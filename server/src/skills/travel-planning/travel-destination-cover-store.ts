/**
 * 目的地代表性封面库（单例）
 *
 * 定位：行程卡海报区背景必须是「目的地本身最具代表性的真实照片」（如
 * 杭州→西湖全景、北京→故宫）。这张照片是目的地级别的形象照，与任何单个
 * POI 都不同——挂到某个景点名下会造成「张冠李戴」，因此独立成库按目的地
 * 缓存，不进 POI 媒体库。
 *
 * 来源（由 TravelPlanningService 解析后写入）：
 *   wikipedia-lead = 维基百科条目主图（pageimages，百科选定的条目代表照，最具代表性）
 *   wikimedia      = 目的地中心地理锚定 / Commons 文本搜索的实拍（兜底）
 *
 * 存储：data/travel-media/destination-covers.json 单文件（低频写，同步刷盘），
 * 进程内 Map + 懒加载；30 天 TTL（目的地形象照稳定，过期后重新解析）。
 * TRAVEL_MEDIA_STORE_DIR 环境变量可覆盖存储根目录（与 POI 媒体库一致，测试用）。
 */
import fs from 'fs';
import path from 'path';

export type DestinationCoverSource = 'wikipedia-lead' | 'wikimedia';

export interface DestinationCover {
  url: string;
  source: DestinationCoverSource;
}

interface CoverRecord {
  url: string;
  source: DestinationCoverSource;
  ts: number;
}

/** 封面有效期：目的地形象照基本不变，长缓存即可；过期后下次规划重新解析 */
const COVER_TTL_MS = 30 * 24 * 3600 * 1000;

/** 缓存键归一化：忽略大小写/空白/括号注记，剥尾部行政区划后缀（「杭州市」≈「杭州」） */
function normalizeDest(destination: string): string {
  return destination
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+/g, '')
    .replace(/(特别行政区|自治州|地区|市|县|盟)$/, '');
}

class TravelDestinationCoverStore {
  private file: string;
  private mem = new Map<string, CoverRecord>();
  private loaded = false;

  constructor() {
    const root = process.env.TRAVEL_MEDIA_STORE_DIR || path.join(process.cwd(), 'data', 'travel-media');
    this.file = path.join(root, 'destination-covers.json');
  }

  /** 读取目的地封面（未过期才返回；命中不区分来源——代表性照是稳定事实） */
  get(destination: string): DestinationCover | null {
    this.ensureLoaded();
    const hit = this.mem.get(normalizeDest(destination));
    if (!hit || !hit.url) return null;
    if (Date.now() - hit.ts > COVER_TTL_MS) return null;
    return { url: hit.url, source: hit.source };
  }

  set(destination: string, cover: DestinationCover): void {
    const url = cover.url?.trim();
    if (!url) return;
    this.ensureLoaded();
    this.mem.set(normalizeDest(destination), { url, source: cover.source, ts: Date.now() });
    this.persist();
  }

  get stats(): { entries: number } {
    this.ensureLoaded();
    return { entries: this.mem.size };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, CoverRecord>;
      for (const [key, rec] of Object.entries(raw)) {
        if (rec && typeof rec.url === 'string' && rec.url) this.mem.set(key, rec);
      }
    } catch (err) {
      console.warn('[DestinationCoverStore] 封面缓存读取失败（忽略重建）:', err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.mem), null, 2), 'utf-8');
    } catch (err) {
      console.warn('[DestinationCoverStore] 封面缓存写入失败:', err instanceof Error ? err.message : err);
    }
  }
}

export const destinationCoverStore = new TravelDestinationCoverStore();
