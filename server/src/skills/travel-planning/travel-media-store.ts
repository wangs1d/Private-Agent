/**
 * POI 媒体库（单例）
 *
 * 定位：把 POI 的「图片 / 评论 / 视频」从请求路径上的实时抓取改为本地资产 + 离线回填。
 *
 * 优先级（行程装配时）：
 *   本地上传实拍(user) > 精选图库(curated) > Wikimedia 离线回填(wikimedia) > 占位图
 *
 * 存储：每个 POI 一个 JSON 元数据文件（data/travel-media/<slug>-<hash>.json），
 *       上传的图片二进制落盘 data/travel-media/assets/<slug>-<hash>/，经 HTTP 路由静态服务。
 *       内存 Map 加速，懒加载 + 写穿持久化。
 *
 * poiKey：type + 归一化名称（确定性），同一 POI 在缓存/上传/回填间靠它对齐。
 *        名称归一化忽略大小写/空白/常见中英文标点；坐标轻微漂移不影响命中。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type PoiMediaType = 'attraction' | 'hotel' | 'restaurant';

export interface MediaImage {
  /** 展示 URL（本地资源走 /travel/media/assets/...，外部为完整 URL） */
  url: string;
  /** user=用户本地上传实拍 / curated=精选图库 / wikimedia=离线回填 */
  source: 'user' | 'curated' | 'wikimedia';
  uploader?: string;
  takenAt?: string;
  createdAt: string;
}

export interface MediaReview {
  id: string;
  author: string;
  rating: number;
  text: string;
  images?: string[];
  visitedDate?: string;
  createdAt: string;
  source: 'user' | 'imported';
}

export interface MediaVideo {
  platform: string;
  title: string;
  author: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  playPageUrl: string;
  createdAt: string;
}

export interface PoiMediaEntry {
  poiKey: string;
  type: PoiMediaType;
  name: string;
  latitude?: number;
  longitude?: number;
  images: MediaImage[];
  reviews: MediaReview[];
  videos: MediaVideo[];
  updatedAt: string;
}

export interface PoiMediaAggregate {
  ratingAvg: number;
  ratingCount: number;
  reviewCount: number;
  imageCount: number;
  userImageCount: number;
  videoCount: number;
}

/** 图片来源展示优先级：越大越优先 */
const SOURCE_PRIORITY: Record<MediaImage['source'], number> = { user: 3, curated: 2, wikimedia: 1 };
const MAX_IMAGES_PER_POI = 12;
const MAX_REVIEWS_PER_POI = 100;
const MAX_VIDEOS_PER_POI = 20;

/** 名称归一化：去空白 + 常见标点，转小写 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s·•・()（）\-—_'"「」『』【】,，。.、!！?？:：;；]/g, '')
    .trim();
}

/** poiKey：type:归一化名（确定性，供路由/存储对齐） */
export function poiKeyOf(type: PoiMediaType, name: string): string {
  return `${type}:${normalizeName(name)}`;
}

/** poiKey → 确定性文件名（slug + 8位hash，避免中文/特殊字符进路径） */
function fileNameFor(poiKey: string): string {
  const hash = crypto.createHash('sha1').update(poiKey).digest('hex').slice(0, 8);
  const slug = normalizeName(poiKey.replace(/^[a-z]+:/, '')).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 40) || 'poi';
  return `${slug}-${hash}`;
}

class TravelMediaStore {
  private root: string;
  private assetsRoot: string;
  private mem = new Map<string, PoiMediaEntry>();

  constructor() {
    this.root = path.join(process.cwd(), 'data', 'travel-media');
    this.assetsRoot = path.join(this.root, 'assets');
    this.ensureDir(this.root);
    this.ensureDir(this.assetsRoot);
  }

  get stats(): { entries: number } {
    return { entries: this.mem.size };
  }

  /** 读取 POI 媒体（不存在返回 null，不落盘创建） */
  get(type: PoiMediaType, name: string): PoiMediaEntry | null {
    const key = poiKeyOf(type, name);
    const hit = this.mem.get(key);
    if (hit) return hit;
    const loaded = this.loadFromFile(key);
    if (loaded) this.mem.set(key, loaded);
    return loaded;
  }

  /** 聚合统计（供排序/前端徽标，无媒体时返回 null） */
  aggregate(type: PoiMediaType, name: string): PoiMediaAggregate | null {
    const entry = this.get(type, name);
    if (!entry) return null;
    const rated = entry.reviews.filter((r) => typeof r.rating === 'number' && r.rating > 0);
    const ratingAvg = rated.length
      ? rated.reduce((s, r) => s + r.rating, 0) / rated.length
      : 0;
    return {
      ratingAvg,
      ratingCount: rated.length,
      reviewCount: entry.reviews.length,
      imageCount: entry.images.length,
      userImageCount: entry.images.filter((i) => i.source === 'user').length,
      videoCount: entry.videos.length,
    };
  }

  /** 追加图片（URL 或 dataUrl，dataUrl 自动落盘到 assets）。返回最终图片记录。 */
  addImage(
    type: PoiMediaType,
    name: string,
    input: { url?: string; dataUrl?: string; source?: MediaImage['source']; uploader?: string; takenAt?: string },
    coords?: { latitude: number; longitude: number },
  ): { ok: boolean; image?: MediaImage; error?: string } {
    let url = input.url?.trim() || '';
    if (!url && input.dataUrl) {
      const saved = this.saveDataUrl(type, name, input.dataUrl);
      if (!saved.ok) return { ok: false, error: saved.error };
      url = saved.url!;
    }
    if (!url) return { ok: false, error: '缺少 url 或 dataUrl' };

    const entry = this.getOrCreate(type, name, coords);
    const image: MediaImage = {
      url,
      source: input.source ?? 'user',
      uploader: input.uploader,
      takenAt: input.takenAt,
      createdAt: new Date().toISOString(),
    };
    // 同 URL 去重
    if (entry.images.some((i) => i.url === url)) return { ok: true, image };
    entry.images.push(image);
    this.sortImages(entry);
    entry.images = entry.images.slice(0, MAX_IMAGES_PER_POI);
    this.persist(entry);
    return { ok: true, image };
  }

  /** 离线回填批量挂图（wikimedia 来源，低优先级） */
  attachBackfilledImages(
    type: PoiMediaType,
    name: string,
    urls: string[],
    coords?: { latitude: number; longitude: number },
  ): void {
    if (!urls.length) return;
    const entry = this.getOrCreate(type, name, coords);
    const existing = new Set(entry.images.map((i) => i.url));
    for (const url of urls) {
      if (existing.has(url)) continue;
      existing.add(url);
      entry.images.push({ url, source: 'wikimedia', createdAt: new Date().toISOString() });
    }
    this.sortImages(entry);
    entry.images = entry.images.slice(0, MAX_IMAGES_PER_POI);
    this.persist(entry);
  }

  addReview(
    type: PoiMediaType,
    name: string,
    review: { author?: string; rating: number; text: string; images?: string[]; visitedDate?: string; source?: 'user' | 'imported' },
    coords?: { latitude: number; longitude: number },
  ): { ok: boolean; review?: MediaReview; error?: string } {
    if (!review.text?.trim()) return { ok: false, error: '评论内容不能为空' };
    const rating = Number(review.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return { ok: false, error: '评分需在 1-5 之间' };

    const entry = this.getOrCreate(type, name, coords);
    const record: MediaReview = {
      id: `rev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      author: review.author?.trim() || '旅友',
      rating,
      text: review.text.trim().slice(0, 2000),
      images: review.images,
      visitedDate: review.visitedDate,
      createdAt: new Date().toISOString(),
      source: review.source ?? 'user',
    };
    entry.reviews.push(record);
    if (entry.reviews.length > MAX_REVIEWS_PER_POI) {
      entry.reviews = entry.reviews.slice(-MAX_REVIEWS_PER_POI);
    }
    this.persist(entry);
    return { ok: true, review: record };
  }

  addVideo(
    type: PoiMediaType,
    name: string,
    video: { platform: string; title: string; author: string; durationSeconds?: number; thumbnailUrl?: string; playPageUrl: string },
    coords?: { latitude: number; longitude: number },
  ): { ok: boolean; error?: string } {
    if (!video.playPageUrl?.trim()) return { ok: false, error: '缺少 playPageUrl' };
    const entry = this.getOrCreate(type, name, coords);
    if (entry.videos.some((v) => v.playPageUrl === video.playPageUrl)) return { ok: true };
    entry.videos.push({ ...video, createdAt: new Date().toISOString() });
    if (entry.videos.length > MAX_VIDEOS_PER_POI) {
      entry.videos = entry.videos.slice(-MAX_VIDEOS_PER_POI);
    }
    this.persist(entry);
    return { ok: true };
  }

  /**
   * 供行程装配：按来源优先级返回图片 URL 列表（本地上传在前）。
   * minSource 之下的不返回（如只要 user/curated 时传 'curated'）。
   */
  imageUrls(type: PoiMediaType, name: string, minSource: MediaImage['source'] = 'wikimedia'): string[] {
    const entry = this.get(type, name);
    if (!entry) return [];
    const floor = SOURCE_PRIORITY[minSource];
    return entry.images.filter((i) => SOURCE_PRIORITY[i.source] >= floor).map((i) => i.url);
  }

  /** 解析 assets 相对路径 → 绝对路径（严格防穿越），不存在返回 null */
  resolveAssetPath(safeDir: string, fileName: string): string | null {
    if (!/^[a-z0-9\u4e00-\u9fa5-]+$/i.test(safeDir) || !/^[a-zA-Z0-9._-]+$/.test(fileName)) return null;
    const full = path.join(this.assetsRoot, safeDir, fileName);
    if (!full.startsWith(this.assetsRoot)) return null;
    return fs.existsSync(full) ? full : null;
  }

  // ======================== 管理端：更新 / 删除 ========================

  /** 更新图片元数据（来源/拍摄时间/上传者）。返回是否找到并更新。 */
  updateImage(
    type: PoiMediaType,
    name: string,
    url: string,
    patch: { source?: MediaImage['source']; takenAt?: string; uploader?: string },
  ): boolean {
    const entry = this.get(type, name);
    const image = entry?.images.find((i) => i.url === url);
    if (!entry || !image) return false;
    if (patch.source !== undefined) image.source = patch.source;
    if (patch.takenAt !== undefined) image.takenAt = patch.takenAt;
    if (patch.uploader !== undefined) image.uploader = patch.uploader;
    this.sortImages(entry);
    this.persist(entry);
    return true;
  }

  /** 删除图片记录；本地 assets 文件一并移除（外链只删记录）。 */
  removeImage(type: PoiMediaType, name: string, url: string): boolean {
    const entry = this.get(type, name);
    if (!entry) return false;
    const before = entry.images.length;
    entry.images = entry.images.filter((i) => i.url !== url);
    if (entry.images.length === before) return false;
    // 本地上传的文件同步删除，避免孤儿资源
    const m = /^\/travel\/media\/assets\/([^/]+)\/([^/]+)$/.exec(url);
    if (m) {
      const full = this.resolveAssetPath(m[1]!, m[2]!);
      if (full) {
        try {
          fs.rmSync(full);
        } catch { /* 删除失败不阻塞记录清理 */ }
      }
    }
    this.persist(entry);
    return true;
  }

  /** 更新评论（评分/文本/作者）。返回更新后的评论，未找到返回 null。 */
  updateReview(
    type: PoiMediaType,
    name: string,
    reviewId: string,
    patch: { rating?: number; text?: string; author?: string },
  ): MediaReview | null {
    const entry = this.get(type, name);
    const review = entry?.reviews.find((r) => r.id === reviewId);
    if (!entry || !review) return null;
    if (patch.rating !== undefined) {
      if (!Number.isFinite(patch.rating) || patch.rating < 1 || patch.rating > 5) return null;
      review.rating = patch.rating;
    }
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (!text) return null;
      review.text = text.slice(0, 2000);
    }
    if (patch.author !== undefined && patch.author.trim()) review.author = patch.author.trim().slice(0, 60);
    this.persist(entry);
    return review;
  }

  /** 删除评论。 */
  removeReview(type: PoiMediaType, name: string, reviewId: string): boolean {
    const entry = this.get(type, name);
    if (!entry) return false;
    const before = entry.reviews.length;
    entry.reviews = entry.reviews.filter((r) => r.id !== reviewId);
    if (entry.reviews.length === before) return false;
    this.persist(entry);
    return true;
  }

  /** 删除视频登记。 */
  removeVideo(type: PoiMediaType, name: string, playPageUrl: string): boolean {
    const entry = this.get(type, name);
    if (!entry) return false;
    const before = entry.videos.length;
    entry.videos = entry.videos.filter((v) => v.playPageUrl !== playPageUrl);
    if (entry.videos.length === before) return false;
    this.persist(entry);
    return true;
  }

  // ======================== 内部 ========================

  private getOrCreate(type: PoiMediaType, name: string, coords?: { latitude: number; longitude: number }): PoiMediaEntry {
    const key = poiKeyOf(type, name);
    let entry: PoiMediaEntry | null | undefined = this.mem.get(key);
    if (!entry) {
      entry = this.loadFromFile(key);
    }
    if (!entry) {
      entry = {
        poiKey: key,
        type,
        name,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        images: [],
        reviews: [],
        videos: [],
        updatedAt: new Date().toISOString(),
      };
    }
    if (coords) {
      entry.latitude = coords.latitude;
      entry.longitude = coords.longitude;
    }
    this.mem.set(key, entry);
    return entry;
  }

  /** 图片按来源优先级稳定排序（本地上传在前，同级按时间倒序） */
  private sortImages(entry: PoiMediaEntry): void {
    entry.images.sort((a, b) => {
      const p = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
      if (p !== 0) return p;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  private saveDataUrl(type: PoiMediaType, name: string, dataUrl: string): { ok: boolean; url?: string; error?: string } {
    const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(dataUrl.trim());
    if (!m) return { ok: false, error: 'dataUrl 需为 image/png|jpeg|webp|gif 的 base64 编码' };
    const ext = m[1]!.includes('jpeg') || m[1]!.includes('jpg') ? 'jpg' : m[1]!.toLowerCase().split('/')[1]!.replace('jpeg', 'jpg');
    let buf: Buffer;
    try {
      buf = Buffer.from(m[3]!, 'base64');
    } catch {
      return { ok: false, error: 'base64 解码失败' };
    }
    if (buf.length === 0) return { ok: false, error: '图片内容为空' };
    if (buf.length > 10 * 1024 * 1024) return { ok: false, error: '图片超过 10MB 上限' };

    const dirName = fileNameFor(poiKeyOf(type, name));
    const dir = path.join(this.assetsRoot, dirName);
    this.ensureDir(dir);
    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    return { ok: true, url: `/travel/media/assets/${dirName}/${fileName}` };
  }

  private loadFromFile(poiKey: string): PoiMediaEntry | null {
    const file = path.join(this.root, `${fileNameFor(poiKey)}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as PoiMediaEntry;
      if (raw.poiKey !== poiKey) return null; // hash 碰撞防护
      return raw;
    } catch {
      return null;
    }
  }

  private persist(entry: PoiMediaEntry): void {
    entry.updatedAt = new Date().toISOString();
    const file = path.join(this.root, `${fileNameFor(entry.poiKey)}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[TravelMediaStore] 持久化失败:', err instanceof Error ? err.message : err);
    }
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export const travelMediaStore = new TravelMediaStore();
