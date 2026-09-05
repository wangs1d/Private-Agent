/**
 * 图库控制模块,移植自 photography_agent.gallery。
 * Python 版为内存 dict 索引;本版统一委托给 ImageStore,
 * 获得哈希去重、缩略图与持久化能力,方法名保持一致。
 */
import { ImageStore } from '../storage/manager.js';
import type { IngestOptions, QueryFilters, QueryParams } from '../storage/manager.js';
import type { ImageAsset } from '../models.js';

export type { IngestOptions, QueryFilters, QueryParams };

export class GalleryService {
  private readonly store: ImageStore;

  constructor(store: ImageStore) {
    this.store = store;
  }

  /** 上传单张照片(入库 + 分析 + 自动标签 + 缩略图) */
  async uploadPhoto(filePath: string, options: IngestOptions = {}): Promise<ImageAsset> {
    const { asset } = await this.store.ingest(filePath, options);
    return asset;
  }

  /** 批量上传照片 */
  async uploadPhotos(filePaths: string[], options: IngestOptions = {}): Promise<ImageAsset[]> {
    const assets: ImageAsset[] = [];
    for (const filePath of filePaths) {
      assets.push(await this.uploadPhoto(filePath, options));
    }
    return assets;
  }

  /** 按条件过滤、排序并分页返回照片 */
  async queryPhotos(params: QueryParams = {}): Promise<{ items: ImageAsset[]; total: number; page: number; pageSize: number }> {
    return this.store.query(params);
  }

  getPhoto(photoId: string): ImageAsset | null {
    return this.store.get(photoId);
  }

  addTag(photoId: string, tag: string): Promise<ImageAsset> {
    return this.store.addTag(photoId, tag);
  }

  removeTag(photoId: string, tag: string): Promise<ImageAsset> {
    return this.store.removeTag(photoId, tag);
  }

  setSceneType(photoId: string, sceneType: string): Promise<ImageAsset> {
    return this.store.setSceneType(photoId, sceneType);
  }

  setRating(photoId: string, rating: number): Promise<ImageAsset> {
    return this.store.setRating(photoId, rating);
  }
}
