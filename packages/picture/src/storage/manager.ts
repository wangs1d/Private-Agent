/**
 * 图片存储管理:资产入库、内容哈希去重、JSON 索引持久化、
 * 筛选查询、标签/评分/场景管理、缩略图联动与孤儿清理。
 *
 * 目录结构:
 *   <rootDir>/assets/<id><ext>   资产文件
 *   <rootDir>/thumbs/<id>_<size>.webp  缩略图
 *   <rootDir>/index.json         资产索引(原子写入)
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ImageAnalysisService } from '../analysis/service.js';
import { parseRational } from '../analysis/exif.js';
import type { ImageAsset } from '../models.js';
import { nowIso } from '../models.js';
import { ThumbnailService } from '../thumbnails/service.js';
import type { ThumbnailSize } from '../thumbnails/service.js';

export interface ImageStoreOptions {
  rootDir: string;
  /** 复用外部缩略图/分析服务(可选) */
  thumbnails?: ThumbnailService;
  analysis?: ImageAnalysisService;
}

export interface IngestOptions {
  fileName?: string;
  tags?: string[];
  sceneType?: string;
  /** 是否自动打标签,默认 true */
  autoTag?: boolean;
  /** 内容哈希重复时是否复用既有资产,默认 true */
  dedupe?: boolean;
  /** 是否生成缩略图,默认 true */
  withThumbnails?: boolean;
}

export interface IngestResult {
  asset: ImageAsset;
  /** true 表示命中哈希去重,复用了既有资产 */
  deduplicated: boolean;
}

export interface QueryFilters {
  tags?: string[];
  sceneType?: string;
  ratingMin?: number;
  ratingMax?: number;
  /** ISO 时间 */
  timeFrom?: string;
  timeTo?: string;
  /** EXIF 焦段 */
  lensFocalLength?: number;
  format?: string;
  sha256?: string;
}

export interface QueryParams {
  filters?: QueryFilters;
  page?: number;
  pageSize?: number;
  /** created_at | rating | file_name | file_size */
  sortBy?: 'created_at' | 'rating' | 'file_name' | 'file_size';
  sortOrder?: 'asc' | 'desc';
}

export interface QueryResult {
  items: ImageAsset[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StoreStats {
  count: number;
  totalBytes: number;
  byFormat: Record<string, number>;
  bySceneType: Record<string, number>;
  thumbCount: number;
}

interface StoreIndex {
  version: 1;
  assets: Record<string, ImageAsset>;
}

export class ImageStore {
  readonly rootDir: string;
  readonly assetsDir: string;
  readonly thumbnails: ThumbnailService;
  private readonly analysis: ImageAnalysisService;
  private index: StoreIndex = { version: 1, assets: {} };

  constructor(options: ImageStoreOptions) {
    this.rootDir = options.rootDir;
    this.assetsDir = path.join(options.rootDir, 'assets');
    this.thumbnails = options.thumbnails ?? new ThumbnailService(path.join(options.rootDir, 'thumbs'));
    this.analysis = options.analysis ?? new ImageAnalysisService();
  }

  /** 加载索引文件;不存在时初始化空索引 */
  async init(): Promise<void> {
    await fs.mkdir(this.assetsDir, { recursive: true });
    await fs.mkdir(this.thumbnails.rootDir, { recursive: true });
    const indexPath = path.join(this.rootDir, 'index.json');
    if (existsSync(indexPath)) {
      const raw = JSON.parse(await fs.readFile(indexPath, 'utf8')) as StoreIndex;
      if (raw.version === 1 && raw.assets) {
        this.index = raw;
      }
    }
  }

  /** 单个资产的缩略图路径查询 */
  thumbnail(assetId: string, size: ThumbnailSize): string | null {
    return this.thumbnails.get(assetId, size);
  }

  /** 入库:分析元信息 → 哈希去重 → 落盘 → 缩略图 → 写索引 */
  async ingest(source: string | Buffer, options: IngestOptions = {}): Promise<IngestResult> {
    const buffer = typeof source === 'string' ? await fs.readFile(source) : source;
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    if (options.dedupe !== false) {
      const existing = Object.values(this.index.assets).find((asset) => asset.sha256 === sha256);
      if (existing) {
        return { asset: existing, deduplicated: true };
      }
    }

    const parsed = await this.analysis.parse(buffer);
    const assetId = crypto.randomUUID().replaceAll('-', '');
    const fileName = options.fileName
      ?? (typeof source === 'string' ? path.basename(source) : `${assetId}.png`);
    const ext = path.extname(fileName) || `.${parsed.format ?? 'png'}`;
    const assetPath = path.join(this.assetsDir, `${assetId}${ext}`);
    await fs.writeFile(assetPath, buffer);

    const tags = new Set(options.tags ?? []);
    if (options.autoTag !== false) {
      for (const tag of parsed.autoTags) {
        tags.add(tag);
      }
    }

    const thumbnails = options.withThumbnails === false
      ? {}
      : await this.thumbnails.generate(buffer, assetId);

    const asset: ImageAsset = {
      id: assetId,
      filePath: assetPath,
      fileName,
      width: parsed.width,
      height: parsed.height,
      format: parsed.format,
      fileSize: buffer.length,
      sha256,
      exif: parsed.exif,
      takenAt: parsed.takenAt,
      tags: [...tags],
      sceneType: options.sceneType ?? null,
      rating: null,
      thumbnails,
      createdAt: nowIso(),
    };
    this.index.assets[assetId] = asset;
    await this.persist();
    return { asset, deduplicated: false };
  }

  get(assetId: string): ImageAsset | null {
    return this.index.assets[assetId] ?? null;
  }

  require(assetId: string): ImageAsset {
    const asset = this.index.assets[assetId];
    if (!asset) {
      throw new Error(`照片不存在: ${assetId}`);
    }
    return asset;
  }

  listAll(): ImageAsset[] {
    return Object.values(this.index.assets);
  }

  /** 过滤 + 排序 + 分页(过滤语义对齐 Python 版 query_photos) */
  async query(params: QueryParams = {}): Promise<QueryResult> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.max(1, params.pageSize ?? 20);
    let items = this.listAll();
    if (params.filters) {
      items = items.filter((asset) => matchFilters(asset, params.filters!));
    }
    items = sortAssets(items, params.sortBy ?? 'created_at', params.sortOrder ?? 'desc');
    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  async addTag(assetId: string, tag: string): Promise<ImageAsset> {
    const asset = this.require(assetId);
    if (!asset.tags.includes(tag)) {
      asset.tags.push(tag);
      await this.persist();
    }
    return asset;
  }

  async removeTag(assetId: string, tag: string): Promise<ImageAsset> {
    const asset = this.require(assetId);
    if (asset.tags.includes(tag)) {
      asset.tags = asset.tags.filter((item) => item !== tag);
      await this.persist();
    }
    return asset;
  }

  async setSceneType(assetId: string, sceneType: string): Promise<ImageAsset> {
    const asset = this.require(assetId);
    asset.sceneType = sceneType;
    await this.persist();
    return asset;
  }

  async setRating(assetId: string, rating: number): Promise<ImageAsset> {
    if (!Number.isFinite(rating) || rating < 0 || rating > 100) {
      throw new Error(`rating 必须在 0-100 之间,当前为 ${rating}`);
    }
    const asset = this.require(assetId);
    asset.rating = Math.round(rating);
    await this.persist();
    return asset;
  }

  /** 删除资产:移除文件、缩略图与索引记录 */
  async remove(assetId: string, options: { deleteFiles?: boolean } = {}): Promise<boolean> {
    const asset = this.index.assets[assetId];
    if (!asset) {
      return false;
    }
    delete this.index.assets[assetId];
    if (options.deleteFiles !== false) {
      await fs.rm(asset.filePath, { force: true });
      await this.thumbnails.remove(assetId);
    }
    await this.persist();
    return true;
  }

  /** 清理:删除磁盘上未被索引引用的资产/缩略图文件 */
  async cleanupOrphans(): Promise<{ removedAssets: string[]; removedThumbs: string[] }> {
    const removedAssets: string[] = [];
    const removedThumbs: string[] = [];
    for (const name of await fs.readdir(this.assetsDir)) {
      const fullPath = path.join(this.assetsDir, name);
      const referenced = Object.values(this.index.assets).some((asset) => asset.filePath === fullPath);
      if (!referenced) {
        await fs.rm(fullPath, { force: true });
        removedAssets.push(name);
      }
    }
    const thumbDir = this.thumbnails.rootDir;
    if (existsSync(thumbDir)) {
      const knownThumbNames = new Set(
        Object.values(this.index.assets).flatMap((asset) =>
          Object.values(asset.thumbnails ?? {}).map((thumbPath) => path.basename(thumbPath)),
        ),
      );
      for (const name of await fs.readdir(thumbDir)) {
        if (!knownThumbNames.has(name)) {
          await fs.rm(path.join(thumbDir, name), { force: true });
          removedThumbs.push(name);
        }
      }
    }
    return { removedAssets, removedThumbs };
  }

  stats(): StoreStats {
    const byFormat: Record<string, number> = {};
    const bySceneType: Record<string, number> = {};
    let totalBytes = 0;
    let thumbCount = 0;
    for (const asset of this.listAll()) {
      totalBytes += asset.fileSize ?? 0;
      if (asset.format) {
        byFormat[asset.format] = (byFormat[asset.format] ?? 0) + 1;
      }
      if (asset.sceneType) {
        bySceneType[asset.sceneType] = (bySceneType[asset.sceneType] ?? 0) + 1;
      }
      thumbCount += Object.keys(asset.thumbnails ?? {}).length;
    }
    return {
      count: this.listAll().length,
      totalBytes,
      byFormat,
      bySceneType,
      thumbCount,
    };
  }

  /** 原子写入索引(tmp + rename) */
  async persist(): Promise<void> {
    const indexPath = path.join(this.rootDir, 'index.json');
    const tmpPath = `${indexPath}.tmp`;
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(this.index, null, 2), 'utf8');
    await fs.rename(tmpPath, indexPath);
  }
}

function matchFilters(asset: ImageAsset, filters: QueryFilters): boolean {
  if (filters.tags && filters.tags.length > 0 && !filters.tags.some((tag) => asset.tags.includes(tag))) {
    return false;
  }
  if (filters.sceneType !== undefined && asset.sceneType !== filters.sceneType) {
    return false;
  }
  if (filters.ratingMin !== undefined && (asset.rating === null || asset.rating === undefined || asset.rating < filters.ratingMin)) {
    return false;
  }
  if (filters.ratingMax !== undefined && (asset.rating === null || asset.rating === undefined || asset.rating > filters.ratingMax)) {
    return false;
  }
  if ((filters.timeFrom || filters.timeTo) && !asset.takenAt) {
    return false;
  }
  if (filters.timeFrom && asset.takenAt! < filters.timeFrom) {
    return false;
  }
  if (filters.timeTo && asset.takenAt! > filters.timeTo) {
    return false;
  }
  if (filters.lensFocalLength !== undefined) {
    const focal = parseRational(asset.exif['EXIF FocalLength']);
    if (focal === null || Math.round(focal) !== Math.round(filters.lensFocalLength)) {
      return false;
    }
  }
  if (filters.format !== undefined && asset.format !== filters.format) {
    return false;
  }
  if (filters.sha256 !== undefined && asset.sha256 !== filters.sha256) {
    return false;
  }
  return true;
}

function sortAssets(items: ImageAsset[], sortBy: NonNullable<QueryParams['sortBy']>, order: NonNullable<QueryParams['sortOrder']>): ImageAsset[] {
  const direction = order === 'asc' ? 1 : -1;
  const getter = (asset: ImageAsset): number | string | null => {
    switch (sortBy) {
      case 'rating':
        return asset.rating ?? null;
      case 'file_name':
        return asset.fileName;
      case 'file_size':
        return asset.fileSize ?? null;
      default:
        return asset.createdAt;
    }
  };
  const withValue = items.filter((asset) => getter(asset) !== null);
  const withoutValue = items.filter((asset) => getter(asset) === null);
  withValue.sort((a, b) => {
    const va = getter(a)!;
    const vb = getter(b)!;
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb)) * direction;
    }
    return (va - vb) * direction;
  });
  return [...withValue, ...withoutValue];
}
