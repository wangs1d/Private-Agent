/**
 * POI 缓存管理器
 *
 * 策略：文件持久化 + 内存加速
 * - 首次搜索某目的地 → 调外部API → 存入JSON文件 + 内存
 * - 后续访问 → 直接读内存（毫秒级）
 * - 服务重启后 → 从文件恢复到内存（不丢失数据）
 * - 所有用户共享同一份缓存（全局受益）
 */

import fs from 'fs';
import path from 'path';

/** 单个目的地的缓存条目 */
export interface CacheEntry {
  /** 目的地名称 */
  destination: string;
  /** 搜索关键词（用于去重） */
  queryKey: string;
  /** 缓存的POI数据 */
  data: {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  };
  /** 中心坐标 */
  center: { latitude: number; longitude: number };
  /** 创建时间 */
  createdAt: string;
  /** 最后访问时间 */
  lastAccessedAt: string;
  /** 访问次数（用于统计热门目的地） */
  accessCount: number;
}

/** 原始POI数据结构 */
export interface RawPOI {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  type: string;
  rating?: number;
  tags?: string[];
  /** 已抓取的真实图片（POI 稳定属性，随缓存落盘，行程规划直接复用） */
  images?: string[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat） */
  splatUrl?: string;
  raw?: Record<string, unknown>;
}

export class POICacheManager {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private maxMemoryEntries: number = 100; // 内存最多缓存100个目的地

  constructor() {
    this.cacheDir = path.join(process.cwd(), 'data', 'poi-cache');
    this.ensureCacheDir();
    // 启动时从文件恢复到内存
    this.restoreFromFilesystem();
  }

  // ======================== 公共接口 ========================

  /**
   * 获取缓存（命中返回数据，未命中返回null）
   */
  get(destination: string): CacheEntry | null {
    const key = this.normalizeKey(destination);
    const entry = this.memoryCache.get(key);

    if (entry) {
      entry.lastAccessedAt = new Date().toISOString();
      entry.accessCount++;
      return entry;
    }

    // 内存没有，尝试从文件读取
    return this.loadFromFile(key);
  }

  /**
   * 写入缓存（同时写内存和文件）
   */
  set(
    destination: string,
    data: CacheEntry['data'],
    center: CacheEntry['center']
  ): CacheEntry {
    const key = this.normalizeKey(destination);
    const now = new Date().toISOString();

    const entry: CacheEntry = {
      destination,
      queryKey: key,
      data,
      center,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 1,
    };

    // 写入内存
    this.evictIfNeeded();
    this.memoryCache.set(key, entry);

    // 写入文件（持久化，供其他用户/重启后使用）
    this.saveToFile(key, entry);

    console.log(`[POICache] 已缓存: ${destination} (景点${data.attractions.length} 酒店${data.hotels.length} 餐厅${data.restaurants.length})`);
    return entry;
  }

  /**
   * 检查是否有缓存
   */
  has(destination: string): boolean {
    const key = this.normalizeKey(destination);
    if (this.memoryCache.has(key)) return true;
    return fs.existsSync(this.getFilePath(key));
  }

  /**
   * 获取所有已缓存的目的地列表
   */
  listCachedDestinations(): Array<{
    destination: string;
    accessCount: number;
    createdAt: string;
    poiCount: number;
  }> {
    const result: Array<{ destination: string; accessCount: number; createdAt: string; poiCount: number }> = [];
    for (const [, entry] of this.memoryCache) {
      result.push({
        destination: entry.destination,
        accessCount: entry.accessCount,
        createdAt: entry.createdAt,
        poiCount: entry.data.attractions.length + entry.data.hotels.length + entry.data.restaurants.length,
      });
    }
    // 按访问次数排序
    return result.sort((a, b) => b.accessCount - a.accessCount);
  }

  /**
   * 清除指定目的地的缓存
   */
  invalidate(destination: string): boolean {
    const key = this.normalizeKey(destination);
    this.memoryCache.delete(key);
    try {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /**
   * 为某目的地下的单个 POI 关联/更新真实图片（内存 + 文件持久化）。
   *
   * 图片是 POI 的稳定属性：行程规划时抓取一次即落盘，后续同目的地的
   * 规划直接复用，无需重复请求图片源（省 ~8s 网络等待）。
   */
  updatePOIImages(
    destination: string,
    type: 'attraction' | 'hotel' | 'restaurant',
    poiId: string,
    images: string[],
  ): void {
    if (!images.length) return;
    const key = this.normalizeKey(destination);
    const entry = this.memoryCache.get(key) ?? this.loadFromFile(key);
    if (!entry) return;
    const listKey = `${type}s` as keyof CacheEntry['data'];
    const poi = entry.data[listKey].find((p) => p.id === poiId);
    if (!poi) return;
    poi.images = images;
    this.saveToFile(key, entry);
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    memoryEntries: number;
    fileEntries: number;
    totalSizeBytes: number;
    topDestinations: Array<{ destination: string; accessCount: number }>;
  } {
    let fileEntries = 0;
    let totalSize = 0;

    try {
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));
        fileEntries = files.length;
        for (const f of files) {
          try {
            totalSize += fs.statSync(path.join(this.cacheDir, f)).size;
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    const topDestinations = this.listCachedDestinations()
      .slice(0, 10)
      .map(d => ({ destination: d.destination, accessCount: d.accessCount }));

    return {
      memoryEntries: this.memoryCache.size,
      fileEntries,
      totalSizeBytes: totalSize,
      topDestinations,
    };
  }

  // ======================== 私有方法 ========================

  private normalizeKey(destination: string): string {
    // 使用安全的ASCII编码：先标准化（小写+去空格），再用Buffer转hex
    const normalized = destination.toLowerCase().replace(/\s+/g, '-');
    return Buffer.from(normalized, 'utf-8').toString('hex').slice(0, 64);
  }

  private getFilePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      console.log(`[POICache] 创建缓存目录: ${this.cacheDir}`);
    }
  }

  /** 服务启动时从文件系统恢复到内存 */
  private restoreFromFilesystem(): void {
    let count = 0;
    try {
      if (!fs.existsSync(this.cacheDir)) return;

      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const filePath = path.join(this.cacheDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const entry: CacheEntry = JSON.parse(content);
          const key = this.normalizeKey(entry.destination);

          // 只加载到内存缓存上限
          if (this.memoryCache.size < this.maxMemoryEntries) {
            this.memoryCache.set(key, entry);
            count++;
          }
        } catch (err) {
          console.warn(`[POICache] 恢复缓存失败: ${file}`, err);
        }
      }

      if (count > 0) {
        console.log(`[POICache] 从文件恢复了 ${count} 个目的地的缓存`);
      }
    } catch (err) {
      console.error('[POICache] 恢复缓存失败:', err);
    }
  }

  private loadFromFile(key: string): CacheEntry | null {
    try {
      const filePath = this.getFilePath(key);
      if (!fs.existsSync(filePath)) return null;

      const content = fs.readFileSync(filePath, 'utf-8');
      const entry: CacheEntry = JSON.parse(content);

      // 加载到内存
      this.evictIfNeeded();
      this.memoryCache.set(key, entry);

      entry.lastAccessedAt = new Date().toISOString();
      entry.accessCount++;

      return entry;
    } catch (err) {
      console.warn(`[POICache] 读取文件缓存失败: ${key}`, err);
      return null;
    }
  }

  private saveToFile(key: string, entry: CacheEntry): void {
    try {
      const filePath = this.getFilePath(key);
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[POICache] 写入文件缓存失败: ${key}`, err);
    }
  }

  /** LRU淘汰：当内存超过上限时淘汰最久未访问的 */
  private evictIfNeeded(): void {
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Date.now();

      for (const [key, entry] of this.memoryCache) {
        const time = new Date(entry.lastAccessedAt).getTime();
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
        console.log(`[POICache] LRU淘汰: ${oldestKey} (当前${this.memoryCache.size}/${this.maxMemoryEntries})`);
      }
    }
  }
}

// 全局单例
export const poiCache = new POICacheManager();
