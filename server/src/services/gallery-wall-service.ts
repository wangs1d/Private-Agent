import type { ImageAsset, PictureKit } from "@private-ai-agent/picture";

/**
 * 3D 照片墙「贴墙」服务（B 面数据管线）。
 *
 * 职责：把图库（@private-ai-agent/picture，data/pictures）里的照片整理成
 * 3D 时间走廊的布局 JSON——事件簇为一等公民（Yope/Linger 式「记忆」单位），
 * 时间是簇间的排序轴，地点/氛围短句来自视觉分析管线（photo-analysis-service）。
 *
 * 设计要点：
 *   - 布局计算纯确定性（无 LLM）：同输入同输出，每次请求现算（几百张量级
 *     排序+分簇成本可忽略），不引入缓存失效问题。
 *   - 位置体系：走廊沿 X 轴展开，照片挂走廊两侧（z = ±2.7m 展墙面），挂高
 *     统一视线高；3D 页只渲染坐标，不参与布局决策。
 */

// ──────────────────────────── 类型（wire = /gallery-wall/layout）────────────────────────────

export interface WallPhoto {
  id: string;
  /** 中清缩略图（墙上看） */
  thumbUrl: string;
  /** 原图（点开放大用） */
  fileUrl: string;
  width: number;
  height: number;
  /** 展示时间（takenAt 优先，缺省 createdAt），ISO 或 null */
  time: string | null;
  /** 视觉分析的一句氛围短句 */
  caption: string | null;
  /** 视觉分析推断的地点 */
  place: string | null;
  tags: string[];
  /** 走廊内位置 [x, y, z]，米 */
  pos: [number, number, number];
  /** 挂墙侧：1 = 走廊 +z 侧，-1 = -z 侧（3D 页据此定朝向） */
  side: 1 | -1;
}

export interface WallEvent {
  id: string;
  /** 确定性标题：「9月12日 下午 · 大理古城」（地点来自视觉分析，可缺） */
  title: string;
  start: string;
  end: string;
  place: string | null;
  photoCount: number;
  photos: WallPhoto[];
}

export interface WallMark {
  /** 年月地标：「2026年9月」 */
  label: string;
  x: number;
}

export interface WallLayout {
  version: 1;
  generatedAt: string;
  photoCount: number;
  events: WallEvent[];
  marks: WallMark[];
  span: { startX: number; endX: number };
  /** 待视觉分析照片数（墙页提示芯片，>0 时引导用户显式触发分析） */
  pendingAnalysis: number;
}

// ──────────────────────────── 布局常量 ────────────────────────────

/** 事件分簇阈值：间隔超过 3 小时视为不同事件 */
export const EVENT_GAP_MS = 3 * 60 * 60 * 1000;
/** 单簇上限（超长活动拆簇，避免一面墙挤 200 张） */
export const MAX_CLUSTER_SIZE = 30;
/** 簇内画作间距（米）——美术馆画幅宽（上限 1.85m），须留出墙间空隙 */
const PHOTO_SPACING = 2.2;
/** 照片离走廊中线的距离＝展墙位置（米） */
const SIDE_OFFSET = 2.7;
/** 照片挂高基准（米）＝视线高，美术馆齐平挂法 */
const BASE_Y = 1.62;
/** 簇间基础间距 + 随时间间隔增长的额外间距（米） */
const CLUSTER_GAP_BASE = 3.4;
const CLUSTER_GAP_GROWTH = 1.4;

// ──────────────────────────── 工具函数 ────────────────────────────

/** 字符串 → 0..1 确定性抖动（同 id 永远同位置，重启不跳） */
function hashUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000 / 1000;
}

/** 照片时间戳：takenAt 优先，回退 createdAt；都解析不了返回 null */
export function photoTimeMs(asset: Pick<ImageAsset, "takenAt" | "createdAt">): number | null {
  for (const raw of [asset.takenAt, asset.createdAt]) {
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

const TIME_SEGMENT_LABELS: Array<{ from: number; to: number; label: string }> = [
  { from: 5, to: 8, label: "清晨" },
  { from: 8, to: 11, label: "上午" },
  { from: 11, to: 13, label: "中午" },
  { from: 13, to: 17, label: "下午" },
  { from: 17, to: 19, label: "傍晚" },
  { from: 19, to: 23, label: "夜间" },
  { from: 23, to: 24, label: "深夜" },
  { from: 0, to: 5, label: "深夜" },
];

function timeSegmentLabel(ts: number): string {
  const hour = new Date(ts).getHours();
  for (const seg of TIME_SEGMENT_LABELS) {
    if (hour >= seg.from && hour < seg.to) return seg.label;
  }
  return "";
}

function formatEventTitle(ts: number, place: string | null): string {
  const d = new Date(ts);
  const seg = timeSegmentLabel(ts);
  let title = `${d.getMonth() + 1}月${d.getDate()}日${seg ? ` ${seg}` : ""}`;
  if (place) title += ` · ${place}`;
  return title;
}

/**
 * 按时间分簇：间隔 > EVENT_GAP_MS 切新簇，单簇超 MAX_CLUSTER_SIZE 强制拆分。
 * 无时间戳的照片排在最后，自成一簇（标题用「未记录时间」）。
 * 供贴墙布局与 picture.memories 记忆回顾共用同一聚类口径。
 */
export function clusterAssetsByTime(assets: ImageAsset[]): ImageAsset[][] {
  const timed = assets
    .filter((a) => photoTimeMs(a) !== null)
    .sort((a, b) => (photoTimeMs(a) ?? 0) - (photoTimeMs(b) ?? 0));
  const untimed = assets.filter((a) => photoTimeMs(a) === null);

  const clusters: ImageAsset[][] = [];
  let current: ImageAsset[] = [];
  let prevTs: number | null = null;
  for (const asset of timed) {
    const ts = photoTimeMs(asset)!;
    const gapTooBig = prevTs !== null && ts - prevTs > EVENT_GAP_MS;
    if (current.length > 0 && (gapTooBig || current.length >= MAX_CLUSTER_SIZE)) {
      clusters.push(current);
      current = [];
    }
    current.push(asset);
    prevTs = ts;
  }
  if (current.length > 0) clusters.push(current);
  if (untimed.length > 0) clusters.push(untimed);
  return clusters;
}

// ──────────────────────────── 布局计算 ────────────────────────────

/**
 * 计算贴墙布局。输入图库全量资产，输出 3D 页直渲染的
 * 坐标化布局（无 LLM、确定性、幂等）。
 */
export function computeWallLayout(
  assets: ImageAsset[],
  opts: { pictureUrlPrefix?: string } = {},
): WallLayout {
  const prefix = opts.pictureUrlPrefix ?? "";
  const clusters = clusterAssetsByTime(assets);
  const events: WallEvent[] = [];
  const marks: WallMark[] = [];
  const seenMonthKeys = new Set<string>();

  let cursor = 0;
  let prevEndTs: number | null = null;

  for (const cluster of clusters) {
    const startTs = photoTimeMs(cluster[0]!);
    const endTs = photoTimeMs(cluster[cluster.length - 1]!) ?? startTs;

    // 簇级地点：取簇内第一张有分析地点的照片（同事件地点一致性最高）
    const place =
      cluster.map((a) => a.analysis?.place ?? null).find((p) => !!p && p.trim()) ?? null;

    // 簇间距随事件间隔增长（连续快照贴着走，隔天的活动拉开距离）
    if (prevEndTs !== null && startTs !== null) {
      const gapHours = Math.max(0, (startTs - prevEndTs) / 3_600_000);
      cursor += CLUSTER_GAP_BASE + Math.min(6, CLUSTER_GAP_GROWTH * Math.log2(1 + gapHours));
    }
    const clusterStartX = cursor;

    // 年月地标：每个（年,月）第一次出现时落标
    if (startTs !== null) {
      const d = new Date(startTs);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!seenMonthKeys.has(key)) {
        seenMonthKeys.add(key);
        marks.push({ label: `${d.getFullYear()}年${d.getMonth() + 1}月`, x: clusterStartX });
      }
    }

    const side: 1 | -1 = events.length % 2 === 0 ? 1 : -1;
    const photos: WallPhoto[] = cluster.map((asset, j) => {
      const x = clusterStartX + j * PHOTO_SPACING;
      const z = side * SIDE_OFFSET; // 画作齐平挂在展墙面上（美术馆挂法）
      const y = BASE_Y + hashUnit(asset.id) * 0.0;
      return {
        id: asset.id,
        thumbUrl: `${prefix}/picture/assets/${asset.id}/thumbnail/medium`,
        fileUrl: `${prefix}/picture/assets/${asset.id}/file`,
        width: asset.width,
        height: asset.height,
        time: asset.takenAt ?? asset.createdAt,
        caption: asset.analysis?.caption ?? null,
        place: asset.analysis?.place ?? null,
        tags: [...asset.tags],
        pos: [round2(x), round2(y), round2(z)],
        side,
      };
    });

    events.push({
      id: `evt_${cluster[0]!.id.slice(0, 8)}`,
      title: startTs !== null ? formatEventTitle(startTs, place) : "未记录时间",
      start: startTs !== null ? new Date(startTs).toISOString() : "",
      end: endTs !== null ? new Date(endTs).toISOString() : "",
      place,
      photoCount: photos.length,
      photos,
    });

    cursor += (cluster.length - 1) * PHOTO_SPACING;
    prevEndTs = endTs;
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    photoCount: assets.length,
    events,
    marks,
    span: { startX: 0, endX: round2(cursor) },
    pendingAnalysis: assets.filter((a) => !a.analysis?.analyzedAt).length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ──────────────────────────── 服务封装（路由直接消费）────────────────────────────

export class GalleryWallService {
  constructor(
    private readonly pictureKit: PictureKit,
    private readonly pictureRoot: string,
  ) {}

  /** 全量贴墙布局（每次现算，见文件头说明） */
  async layout(): Promise<WallLayout> {
    return computeWallLayout(this.pictureKit.store.listAll());
  }

  get assetRoot(): string {
    return this.pictureRoot;
  }
}
