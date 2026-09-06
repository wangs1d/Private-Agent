/**
 * 智能行程规划服务
 *
 * 架构：实时搜索 + 持久化共享缓存
 *
 * 数据流：
 *   用户输入 → 解析目的地/天数 → 查缓存 → 命中?直接返回 : 调OSM API搜索→存缓存→返回
 *
 * API来源：OpenStreetMap（免费、无需Key、全球覆盖）
 *   - Nominatim: 地理编码（地名→坐标）
 *   - Overpass API: POI搜索（景点/酒店/餐厅）
 *
 * 缓存：POICacheManager（文件持久化 + 内存加速，全局共享）
 */

import type { Coordinates, AgentTrace } from './types.js';
import { poiCache, type CacheEntry, type RawPOI } from './poi-cache-manager.js';
import { pricingService, formatQuotePriceInfo, type MemberTier, type PriceQuote, type BoundPlatform, type PricingContext } from './pricing-service.js';
import { travelMediaStore } from './travel-media-store.js';
import { WeatherService, type WeatherBrief } from '../../services/weather-service.js';
import { knowledgeBase } from './knowledge-base.js';
import { extractDays, extractDestination, extractPreferences } from './intent-parser.js';
import { travelFavoritesStore } from './travel-favorites-store.js';
import { emitTravelProgress } from './travel-progress-bus.js';

/** 行程条目可挂载的本地媒体（来自 POI 媒体库） */
interface PoiMediaMeta {
  reviewCount: number;
  reviews: Array<{ author: string; rating: number; text: string; createdAt: string }>;
  videos: Array<{
    platform: string;
    title: string;
    author: string;
    durationSeconds?: number;
    thumbnailUrl?: string;
    playPageUrl: string;
  }>;
}

/** 编排阶段的交通腿结果（OSRM 或 haversine 估算） */
type TransportLeg = { mode: string; durationMin: number; distanceKm: number; note?: string };

/** 单个时段的天气语境（供天气×时段智能排程） */
interface SlotWeatherCtx {
  rainy: boolean;
  hot: boolean;
  cold: boolean;
  precipPct: number;
}

/** 整日天气语境：上午/下午/晚间三段 + 全天聚合（天气获取失败时为 null，按中性天气排程） */
interface TripWeatherCtx {
  morning: SlotWeatherCtx;
  afternoon: SlotWeatherCtx;
  evening: SlotWeatherCtx;
  /** 白天（上午或下午）有雨 → 全天内景区分需室内优先 */
  isRainyDay: boolean;
  isHotDay: boolean;
  isColdDay: boolean;
  /** 一句话摘要（提示文案用） */
  summary: string;
}

/** 降雨相关 WMO 天气码（Open-Meteo） */
const RAIN_WEATHER_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

// ==================== 行程级二级缓存 ====================
// 相同的 目的地+天数+偏好 组合，在 POI 缓存未刷新时整份行程直接复用。
// POI 缓存 set 时 createdAt 变化 → 行程缓存自然失效；图片回写不进 createdAt，
// 二次规划仍享受图片命中（见 collectMediaForDays）。
const ITINERARY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const ITINERARY_CACHE_MAX = 48;
const itineraryCache = new Map<
  string,
  { ts: number; poiUpdatedAt: string; result: PlanningResult }
>();

/** 写入行程缓存（超过上限踢掉最旧的） */
function cacheItinerary(key: string, entry: { ts: number; poiUpdatedAt: string; result: PlanningResult }): void {
  itineraryCache.set(key, entry);
  if (itineraryCache.size <= ITINERARY_CACHE_MAX) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of itineraryCache) {
    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey) itineraryCache.delete(oldestKey);
}

// ======================== 类型定义 ========================

export interface PlanningRequest {
  input: string;
  destination?: string;
  days?: number;
  preferences?: string[];
  /** 用户会员等级（normal/silver/gold/diamond/platinum） */
  memberTier?: MemberTier;
  /** 已绑定的外部平台账户（Booking/Agoda/携程/美团 等，OAuth 授权后传入） */
  boundPlatforms?: BoundPlatform[];
  /** 会话 ID（可选）：传入时通过 travel-progress-bus 向聊天侧流式汇报规划进度 */
  sessionId?: string;
}

/**
 * 从用户自然语言解析出的结构化偏好
 * （与 request.preferences 并集：自由文本标签 + 抽取出的语义标签 + 目的地常识 + 默认值）
 */
export interface TripPreferences {
  /** 原始自由文本标签 */
  raw: string[];
  /** 靠海/海景/海滨/沙滩 */
  seaside: boolean;
  /** 酒店带泳池（内置或室外） */
  pool: boolean;
  /** 想要更多游玩/活动项目（拉满每天景点数） */
  activities: boolean;
  /** 适合带小孩/亲子 */
  kids: boolean;
  /** 适合带老人 */
  elderly: boolean;
  /** 节奏：relaxed(2个景点/天) / balanced(3个) / intensive(4个) */
  pace: 'relaxed' | 'balanced' | 'intensive';
  /** 活动类型偏好：culture / nature / entertainment / mixed（自动从目的地下发） */
  activityMix: 'culture' | 'nature' | 'entertainment' | 'mixed';
  /** 预算档位：low / mid / high */
  budget?: 'low' | 'mid' | 'high';
  /** 菜系偏好：中餐/海鲜/西餐/日料/... */
  cuisine?: string;
  /** 住宿档次（提取自"豪华/精品/经济"等） */
  hotelTier?: 'budget' | 'mid' | 'luxury';
  /** 偏好来源标签：user=用户原文说 / destination=目的地常识 / default=系统默认 */
  sources: Record<keyof Omit<TripPreferences, 'raw' | 'sources'>, 'user' | 'destination' | 'default'>;
}

/**
 * 目的地实用信息（用户没主动问也补上）
 */
export interface TravelInfo {
  destination: string;
  visa: { required: boolean; type: '免签' | '落地签' | '电子签' | '需签证' | '另纸签'; notes?: string };
  currency: { name: string; code: string; symbol: string; rateToCNY?: number };
  timezone: { name: string; offset: string };
  language: string[];
  voltage: string;
  socket: string;
  bestSeason: { months: string[]; description: string };
  emergency: { police?: string; ambulance?: string; touristHotline?: string; chinaEmbassy?: string };
  customs: string[];
  tips: string[];
  /** 目的地一句话简介（行程卡海报区展示；知识库未命中时缺省，前端隐藏该行） */
  intro?: string;
  /** 出行随身物品叮嘱（行程卡「记得带」胶囊；知识库命中取条目，否则按通用模板） */
  packing?: string[];
}

export interface PlannedDay {
  date: string;
  items: ItineraryItem[];
}

export interface ItineraryItem {
  itemId: string;
  /** 对应 POI 缓存中的原始 id（用于图片复用/缓存回写） */
  poiId?: string;
  type: 'hotel' | 'attraction' | 'restaurant';
  name: string;
  description: string;
  startTime: string;
  endTime?: string;
  /** 从前一个item过来的交通方式+时长+距离（首项无） */
  transportFromPrev?: { mode: string; durationMin: number; distanceKm?: number; note?: string };
  /** 建议游览时长（分钟） */
  visitDuration?: number;
  /** 当地小贴士（用户没问也补） */
  tips?: string[];
  /** 预订提示（酒店/付费景点） */
  bookingNote?: string;
  latitude: number;
  longitude: number;
  rating: number;
  priceInfo: string;
  address: string;
  phone: string;
  openingHours: string;
  tags: string[];
  reviewCount: number;
  images: string[];
  /** 相关视频（媒体库登记的元数据+播放页，不自托管文件） */
  videos: Array<{
    platform: string;
    title: string;
    author: string;
    durationSeconds?: number;
    thumbnailUrl?: string;
    playPageUrl: string;
  }>;
  reviews: unknown[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL */
  splatUrl?: string;
  // 酒店特有
  pricePerNight?: number;
  starRating?: number;
  rooms?: Array<{ name: string; pricePerNight: number; capacity: number; amenities: string[]; image: string }>;
  // 景点特有
  ticketPrice?: number;
  category?: string;
  // 餐厅特有
  avgPrice?: number;
  priceLevel?: number;
  cuisine?: string;
  menuItems?: Array<Record<string, unknown>>;
  // 真实价格 + 优惠明细（来自 PricingService）
  priceQuote?: PriceQuote;
}

export interface PlanningResult {
  id: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  destination: string;
  center: Coordinates;
  days: PlannedDay[];
  pois: POISummary[];
  preferences: TripPreferences;
  /** 行程附加实用信息（用户没问也补） */
  travelInfo: TravelInfo;
  /** 整体价格汇总（货币/总原价/总优惠/总实付/价格模式） */
  pricingSummary?: {
    currency: 'CNY' | 'USD' | 'IDR' | 'JPY' | 'THB' | 'EUR' | 'HKD';
    totalOriginal: number;
    totalDiscount: number;
    totalFinal: number;
    memberTier?: MemberTier;
    boundPlatforms?: BoundPlatform[];
    pricingMode: 'real-api' | 'real-database' | 'estimated';
    warnings: string[];
  };
  fromCache: boolean;
  /** 数据可信度：real=实时API数据 / knowledge=知识库真实POI / synthetic=离线合成占位（前端需明示用户） */
  dataQuality?: "real" | "knowledge" | "synthetic";
}

export interface POISummary {
  id: string;
  name: string;
  type: 'attraction' | 'hotel' | 'restaurant';
  latitude: number;
  longitude: number;
  address: string;
  rating: number;
  cost?: string;
  description?: string;
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL */
  splatUrl?: string;
}

// ======================== OpenStreetMap / 高德地图 配置 ========================

const OSM_NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
/** 备用地理编码（Photon，OSM 数据的免费检索服务），Nominatim 失败时切换而非直接抛错 */
const PHOTON_GEOCODE_BASE = 'https://photon.komoot.io/api';
/** 地理编码超时：冷启动主要延迟来源，从 20s 压到 8s（Overpass 6s / OSRM 5s 同量级） */
const GEOCODE_REQUEST_TIMEOUT_MS = 8000;
const PHOTON_REQUEST_TIMEOUT_MS = 6000;
// 多个 Overpass 镜像并行尝试，使用首个成功响应（应对大陆网络对 overpass-api.de 的封锁/超时）
const OSM_OVERPASS_BASES = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const OVERPASS_REQUEST_TIMEOUT_MS = 6000;
const USER_AGENT = 'TravelPlanner3D/1.0 (Educational Project)';

// ======================== 高德地图配置 ========================

/** 从环境变量读取高德API Key */
const AMAP_KEY = process.env.AMAP_WEB_KEY || '';
/** 高德POI搜索基础URL */
const AMAP_POI_BASE = 'https://restapi.amap.com/v3/place/text';
/** 高德请求超时 */
const AMAP_REQUEST_TIMEOUT_MS = 8000;

/**
 * 判断目的地是否为国内（中国大陆）
 * 基于已知国内城市列表 + 省份关键词判断
 */
function isDomesticDestination(destName: string): boolean {
  return knowledgeBase.isDomesticDestination(destName);
}

/**
 * 高德POI类型编码：
 * - 景点: 130000 风景名胜 | 190000 科教文化(博物馆等)
 * - 酒店: 060000
 * - 餐厅: 050000
 */
const AMAP_POI_TYPES: Record<string, string> = {
  attraction: '130000|190100|190200|190300|190400|190500', // 风景名胜 + 博物馆/展览馆/图书馆/科技馆
  hotel: '060000',
  restaurant: '050000',
};

// ======================== 排序/评分权重配置 ========================

/**
 * 评分与排序权重集中配置（替代散落在排序函数里的魔法数字）。
 * 调整排序手感只改这里；语义见各字段名与使用处注释。
 */
const SCORING = {
  /** 收藏命中加权（「type:name」精确匹配） */
  favoriteBoost: 3,
  /** 酒店偏好加分 */
  hotel: { seaside: 5, pool: 4, kids: 2, elderly: 2, luxuryTier: 3, budgetTier: 3 },
  /** 餐厅偏好加分（目的地排序阶段） */
  restaurant: { cuisineMatch: 4, seaside: 2 },
  /** 景点偏好加分 + 天气×室内外修正 */
  attraction: {
    activities: 2, seaside: 3, kids: 2,
    indoorRainy: 5, indoorHot: 3, outdoorRainy: -5, outdoorHot: -2,
    nightView: 1.5, eveningOnly: 1,
  },
  /** 顺路餐厅选择：距离(distWeight) + 评分(ratingWeight) + 偏好加分 - 复用惩罚 */
  routePick: {
    distanceWeight: 0.6,
    distanceBase: 100,
    distanceScale: 1.5,
    ratingWeight: 0.25,
    ratingFallback: 4.0,
    ratingScale: 5,
    cuisineMatch: 15,
    seasideMatch: 8,
    budgetMatch: 5,
    reusePenalty: 10,
  },
} as const;

// ======================== 主服务类 ========================

export class PlanningService {

  /** 当天行程最晚结束时间（分钟，21:00）。超预算的景点顺延丢弃，时钟不再绕回次日。 */
  private static readonly DAY_END_MIN = 21 * 60;

  /** 交通腿缓存（坐标 ~100m 网格），OSRM 结果 24h 复用 */
  private legCache = new Map<string, { transport: TransportLeg; ts: number }>();

  /** OSRM 熔断：不可用时 10 分钟内直接走本地估算，避免编排被外网超时拖住 */
  private osrmDisabledUntil = 0;

  /** 同目的地并发搜索去重：key → in-flight Promise（防缓存击穿打出 N 份外网请求） */
  private inFlightSearches = new Map<string, Promise<CacheEntry>>();

  /**
   * @param weatherService 可选天气服务（未注入则跳过天气感知，按中性天气排程）
   */
  constructor(private readonly weatherService?: WeatherService) {}

  /**
   * 编排阶段的交通腿查询：OSRM 真实路网优先（带 24h 缓存），失败降级 haversine 估算。
   * OSRM 一次失败即熔断 10 分钟（本批其余腿与后续规划直接走本地估算）。
   */
  private async transportLeg(fromLat: number, fromLon: number, toLat: number, toLon: number): Promise<TransportLeg> {
    const key = `${fromLat.toFixed(3)},${fromLon.toFixed(3)}|${toLat.toFixed(3)},${toLon.toFixed(3)}`;
    const hit = this.legCache.get(key);
    if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) return hit.transport;

    let transport: TransportLeg;
    if (Date.now() < this.osrmDisabledUntil) {
      transport = this.computeTransport(fromLat, fromLon, toLat, toLon);
    } else {
      const osrm = await this.osrmRoute(fromLat, fromLon, toLat, toLon);
      if (osrm) {
        transport = osrm;
      } else {
        this.osrmDisabledUntil = Date.now() + 10 * 60 * 1000;
        transport = this.computeTransport(fromLat, fromLon, toLat, toLon);
      }
    }

    this.legCache.set(key, { transport, ts: Date.now() });
    // 简单容量上限：FIFO 淘汰
    if (this.legCache.size > 500) {
      const oldest = this.legCache.keys().next().value;
      if (oldest) this.legCache.delete(oldest);
    }
    return transport;
  }

  /**
   * 本地评论聚合分与 POI 原始评分混合：
   * 媒体库无评论 → 原样返回；评论 <5 条按数量线性加权，≥5 条以本地评论为主。
   */
  private effectiveRating(poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): number {
    const agg = travelMediaStore.aggregate(type, poi.name);
    if (!agg || agg.ratingCount === 0) return poi.rating || 0;
    const w = Math.min(1, agg.ratingCount / 5);
    const base = poi.rating || 0;
    return base > 0 ? base * (1 - w) + agg.ratingAvg * w : agg.ratingAvg;
  }

  /**
   * 主入口：根据用户输入生成完整行程
   */
  /** 规划进度上报（sessionId 缺省时为 no-op） */
  private reportProgress(sessionId: string | undefined, stage: string, message: string): void {
    emitTravelProgress(sessionId, stage, message);
  }

  /** 用户收藏键集合（C5 收藏加权，「type:name」精确匹配；读取失败为空集） */
  private get favoriteKeys(): Set<string> {
    try {
      return travelFavoritesStore.favoriteKeys();
    } catch {
      return new Set();
    }
  }

  /**
   * POI 缓存过期后台刷新（stale-while-revalidate）：
   * 命中缓存但已过 TTL 时先用旧数据服务当前请求，同时异步重搜并写缓存。
   * in-flight 去重保证并发触发只打一份外网请求；失败静默（旧数据仍可用）。
   */
  private refreshStaleCacheInBackground(destName: string, entry: CacheEntry): void {
    if (!poiCache.isStale(entry)) return;
    const normalizedKey = entry.queryKey || destName.toLowerCase().trim();
    console.log(`[PlanningService] POI 缓存已过期(${destName})，后台刷新中（本次请求继续用旧数据）`);
    void this.searchAndCache(destName, normalizedKey).catch((err: unknown) => {
      console.warn(`[PlanningService] 后台刷新失败(${destName}):`, err instanceof Error ? err.message : String(err));
    });
  }

  /** 由 POI raw.source 推导数据可信度（缓存命中同样适用：raw 随缓存落盘） */
  private deriveDataQuality(data: CacheEntry['data']): 'real' | 'knowledge' | 'synthetic' {
    const all = [...data.attractions, ...data.hotels, ...data.restaurants];
    if (all.some((p) => p.raw?.source === 'fallback')) return 'synthetic';
    if (all.some((p) => p.raw?.source === 'known-poi-db')) return 'knowledge';
    return 'real';
  }

  async generateItinerary(request: PlanningRequest): Promise<PlanningResult> {
    const t0 = Date.now();
    console.log(`[PlanningService] 开始规划: "${request.input}"`);

    // 1. 解析用户输入
    const destName = extractDestination(request.input, request.destination);
    const dayCount = request.days || extractDays(request.input) || 3;
    const preferences = extractPreferences(request.input, request.preferences, destName);
    const normalizedDest = destName.toLowerCase().trim();

    this.reportProgress(request.sessionId, "resolve", `正在规划「${destName}」${dayCount}天行程，解析偏好中…`);

    console.log(
      `[PlanningService] 目的地: ${destName}, 天数: ${dayCount}, 偏好: ` +
      `海边=${preferences.seaside} 泳池=${preferences.pool} 活动=${preferences.activities} ` +
      `节奏=${preferences.pace} 混合=${preferences.activityMix} ` +
      `餐系=${preferences.cuisine ?? '-'} 档次=${preferences.hotelTier ?? '-'}` +
      (preferences.raw.length ? ` 原文=[${preferences.raw.join(',')}]` : '')
    );

    // 2. 查缓存
    let cacheEntry = poiCache.get(normalizedDest);
    let fromCache = !!cacheEntry;

    if (!cacheEntry) {
      // 3. 缓存未命中 → 实时搜索
      console.log(`[PlanningService] 缓存未命中，开始实时搜索...`);
      this.reportProgress(request.sessionId, "search", `正在搜索「${destName}」的景点/酒店/餐厅（实时数据）…`);
      cacheEntry = await this.searchAndCache(destName, normalizedDest);
      fromCache = false;
    } else {
      console.log(`[PlanningService] 缓存命中! (已访问${cacheEntry.accessCount}次)`);
      this.reportProgress(request.sessionId, "search", `已命中「${destName}」本地缓存，正在编排行程…`);
      // 过期不阻塞：本次先用旧数据出结果，后台刷新（set 会更新 createdAt，
      // 行程级二级缓存随之自然失效，下次请求拿到新数据）
      this.refreshStaleCacheInBackground(destName, cacheEntry);
    }

    // 真实数据保证（防御）：历史遗留缓存若混有合成占位 POI，拒绝编排并提示重新搜索
    if (this.deriveDataQuality(cacheEntry.data) === "synthetic") {
      throw new Error(`「${destName}」的本地缓存含占位数据，已拒绝生成估算行程；POI 缓存将自动刷新，请稍后重试`);
    }

    // 3.5 天气感知：目的地实时/预报天气（失败降级为中性天气，不阻塞规划）
    const weatherCtx = await this.fetchDestinationWeather(cacheEntry.center, destName);

    // 3.6 语义属性打标（室内/室外/夜景/夜间专属，幂等，兼容旧缓存无标签数据）
    this.enrichPoiAttributes(cacheEntry.data.attractions);
    this.enrichPoiAttributes(cacheEntry.data.hotels);
    this.enrichPoiAttributes(cacheEntry.data.restaurants);

    // 4. 行程级二级缓存：同 目的地+天数+偏好+天气 且 POI 数据未刷新时整体复用
    //    （省去重排序+编排+图片匹配，二次规划毫秒级返回；天气签名变化自动重算）
    //    key 只取结构化字段：preferences.raw 是用户原文标签（换个说法就变），
    //    放进 key 会导致缓存永不命中；sources 仅是标签来源审计，同理排除。
    const weatherSig = weatherCtx
      ? `${weatherCtx.morning.rainy ? 1 : 0}${weatherCtx.afternoon.rainy ? 1 : 0}${weatherCtx.evening.rainy ? 1 : 0}${weatherCtx.isHotDay ? 1 : 0}`
      : 'N';
    const prefSig = JSON.stringify([
      preferences.seaside, preferences.pool, preferences.activities, preferences.kids, preferences.elderly,
      preferences.pace, preferences.activityMix, preferences.budget ?? '', preferences.cuisine ?? '', preferences.hotelTier ?? '',
    ]);
    const itinKey =
      `itin|${normalizedDest}|${dayCount}|${prefSig}|${weatherSig}`;
    const cachedItin = itineraryCache.get(itinKey);
    if (
      cachedItin &&
      cachedItin.poiUpdatedAt === cacheEntry.createdAt &&
      Date.now() - cachedItin.ts < ITINERARY_CACHE_TTL_MS
    ) {
      console.log(`[PlanningService] 【行程缓存命中】直接返回 ${destName} ${dayCount}天行程（免重算+免抓图）`);
      // 深拷贝返回：调用方（编辑链路/序列化）一旦 mutate 不得污染缓存内对象
      return structuredClone(cachedItin.result);
    }

    // 5. 生成日期范围
    const today = new Date();
    const startDate: string = today.toISOString().split('T')[0] ?? '';
    const endDate: string = new Date(today.getTime() + (dayCount - 1) * 86400000).toISOString().split('T')[0] ?? '';

    // 6. 依据偏好+天气对POI排序/筛选（只排序不删除，保留回退池）
    const ranked = this.rankPOIsByPreferences(
      cacheEntry.data.attractions,
      cacheEntry.data.hotels,
      cacheEntry.data.restaurants,
      preferences,
      weatherCtx
    );
    const tParsed = Date.now() - t0;

    // 7. 提取目的地实用信息（用户没问也补）
    const travelInfo = this.extractTravelInfo(destName);

    // 8. 构建每天的行程（两阶段：先构建数据，再并行获取图片）
    const pricingCtx: import('./pricing-service.js').PricingContext = {
      destination: destName,
      preferences: { hotelTier: preferences.hotelTier, budget: preferences.budget },
      memberTier: request.memberTier,
      boundPlatforms: request.boundPlatforms,
      startDate,
    };

    // === 阶段1：构建行程数据（聚类+交通腿+排时，交通腿走 OSRM 缓存）===
    this.reportProgress(request.sessionId, "schedule", "正在按天气与偏好编排每日行程…");
    console.log(`[PlanningService] 阶段1：构建行程数据...`);
    const tBuild0 = Date.now();
    const { days: daysRaw, pois } = await this.buildDaysFast(
      dayCount, startDate,
      ranked.attractions, ranked.hotels, ranked.restaurants,
      cacheEntry.center, preferences, travelInfo, pricingCtx,
      weatherCtx
    );
    const tBuild = Date.now() - tBuild0;

    // === 阶段2：媒体装配（纯本地读：媒体库/POI 缓存直图，网络抓取已移出请求路径）===
    this.reportProgress(request.sessionId, "media", "正在装配图片与点评…");
    const tMedia0 = Date.now();
    const { imageMap, mediaMeta, missing } = this.collectMediaForDays(daysRaw, cacheEntry);
    const days = this.enrichDaysWithMedia(daysRaw, imageMap, mediaMeta);
    const tMedia = Date.now() - tMedia0;

    // 缺图 POI 交给后台回填（TRAVEL_MEDIA_BACKFILL=off 时关闭自动抓取，
    // 由管理员经 /travel/media/backfill 手动触发或后台上传），不阻塞本次请求
    if (missing.length > 0 && PlanningService.AUTO_BACKFILL_ENABLED) {
      this.backfillMediaBackground(missing, cacheEntry);
    }

    // 8. 汇总价格
    const pricingSummary = this._summarizePricing(days, pricingCtx);

    const result: PlanningResult = {
      id: `plan-${Date.now()}`,
      title: this.buildTitle(destName, dayCount, preferences),
      description: request.input,
      startDate,
      endDate,
      destination: destName,
      center: cacheEntry.center,
      days,
      pois,
      preferences,
      travelInfo,
      pricingSummary,
      fromCache,
      dataQuality: this.deriveDataQuality(cacheEntry.data),
    };

    // 9. 写入行程级二级缓存（POI 数据刷新时由 createdAt 差异自然失效）。
    //    缓存内存深拷贝：调用方持有的是原始对象，mutate 不影响缓存。
    cacheItinerary(itinKey, {
      ts: Date.now(),
      poiUpdatedAt: cacheEntry.createdAt,
      result: structuredClone(result),
    });

    console.log(
      `[PlanningService] 规划完成: ${destName} ${dayCount}天 | 解析+取数 ${tParsed}ms, 编排 ${tBuild}ms, 媒体装配 ${tMedia}ms, 总计 ${Date.now() - t0}ms` +
      ` | 图片 ${imageMap.size} 个POI本地直读, 缺图 ${missing.length} 个转后台回填`,
    );

    return result;
  }

  /**
   * Skill 只读入口：搜索目的地 POI（景点/酒店/餐厅）。
   * 走缓存优先 → 网络实时搜索 → 内置知识库真实POI兜底（无合成占位），返回扁平 POI 摘要列表。
   */
  async searchDestination(destName: string, type?: 'attraction' | 'hotel' | 'restaurant'): Promise<{
    destination: string;
    center: Coordinates;
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
    fromCache: boolean;
  }> {
    const normalizedDest = destName.toLowerCase().trim();
    let cacheEntry: CacheEntry | null = null;
    let fromCache = false;
    try {
      cacheEntry = poiCache.get(normalizedDest);
      fromCache = !!cacheEntry;
      if (!cacheEntry) {
        cacheEntry = await this.searchAndCache(destName, normalizedDest);
      } else {
        // 过期后台刷新：当前请求继续用旧数据，不阻塞
        this.refreshStaleCacheInBackground(destName, cacheEntry);
      }
    } catch {
      // 网络/地理编码失败时降级到内置知识库（真实地点）；
      // 知识库也未命中 → 抛错诚实失败，绝不编造 0,0 占位中心
      const known = this.findKnownPOIs(destName);
      const knownCenter = this.findKnownCoordinates(destName)?.center;
      if (!known && !knownCenter) {
        throw new Error(`目的地「${destName}」实时搜索失败且无本地知识库数据，请稍后重试`);
      }
      cacheEntry = {
        destination: destName,
        queryKey: normalizedDest,
        data: {
          attractions: known?.attractions ?? [],
          hotels: known?.hotels ?? [],
          restaurants: known?.restaurants ?? [],
        },
        center: knownCenter ?? { latitude: 0, longitude: 0 },
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        accessCount: 0,
      };
    }
    return {
      destination: destName,
      center: cacheEntry.center,
      attractions: cacheEntry.data.attractions,
      hotels: cacheEntry.data.hotels,
      restaurants: cacheEntry.data.restaurants,
      fromCache,
    };
  }

  /**
   * 公开入口：为 POI 生成行程条目描述文本（替代条目替换时复用规划引擎的文案口径）。
   * 只依赖 name/tags，searchPois 候选（无 id）与完整 RawPOI 均可传入。
   */
  describePoi(
    poi: Pick<RawPOI, 'name'> & Partial<Pick<RawPOI, 'tags' | 'rating' | 'address'>>,
    type: 'attraction' | 'hotel' | 'restaurant',
  ): string {
    return this.generateDescription(poi, type);
  }

  /**
   * 公开入口：编辑后对该天局部重排（替换/新增/删除条目后时间轴修复）。
   *
   * 从 fromItemIndex 起按条目新坐标重算交通腿（复用 transportLeg：OSRM 优先 + 24h
   * 缓存，未涉及编辑点的腿全部缓存命中）并顺序重排 startTime，修掉「替换后坐标变了
   * 但时间还是旧的」的错位；重排复用编排期的口径——餐厅按午/晚餐时段锚定，景点受
   * 当天预算（DAY_END_MIN）口径约束：编辑路径不丢弃条目，只保证时间轴自洽，
   * 超预算信息通过返回值 dayEndMin 透出，由调用方决定是否提示用户。
   *
   * keepFirstStartTime=true 时保留 fromItemIndex 条目的原 startTime 作为锚点
   * （HTTP 面板新增条目显式指定时间时使用），其余场景一律按新坐标顺推。
   */
  async retimeDayAfterEdit<
    T extends {
      type: string;
      startTime: string;
      latitude: number;
      longitude: number;
      visitDuration?: number;
      transportFromPrev?: { mode: string; durationMin: number; distanceKm?: number; note?: string };
    },
  >(
    items: T[],
    fromItemIndex: number,
    opts?: { keepFirstStartTime?: boolean },
  ): Promise<{ dayEndMin: number }> {
    const parseMin = (hhmm: string): number => {
      // 兼容 "HH:MM" 与 "YYYY-MM-DD HH:MM"（取其中的时刻部分）
      const m = /(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
      if (!m) return 9 * 60;
      return Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]));
    };
    const formatTime = (min: number) =>
      `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
    const defaultPrefs: TripPreferences = {
      raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false,
      pace: 'balanced', activityMix: 'mixed',
      sources: {
        seaside: 'default', pool: 'default', activities: 'default', kids: 'default',
        elderly: 'default', pace: 'default', activityMix: 'default',
        budget: 'default', cuisine: 'default', hotelTier: 'default',
      },
    };
    const visitOf = (it: T): number =>
      it.type === 'restaurant' ? 75 : it.visitDuration ?? this.inferVisitDuration('attraction', defaultPrefs);
    const setLeg = (it: T, leg: TransportLeg | undefined): void => {
      if (!leg) return;
      it.transportFromPrev = {
        mode: leg.mode,
        durationMin: leg.durationMin,
        ...(leg.distanceKm != null ? { distanceKm: leg.distanceKm } : {}),
        ...(leg.note ? { note: leg.note } : {}),
      };
    };

    let clock = 9 * 60;
    let prevPoint: { lat: number; lon: number } | null = null;

    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;

      // 未触及前缀：只推进时钟与位置基点
      if (i < fromItemIndex) {
        clock = Math.max(clock, parseMin(it.startTime) + (it.type === 'hotel' ? 60 : visitOf(it)));
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      // 酒店条目：保留原时刻（编排期只把酒店放在 08:00 锚点），只重算入腿
      if (it.type === 'hotel') {
        if (prevPoint) {
          setLeg(it, await this.transportLeg(prevPoint.lat, prevPoint.lon, it.latitude, it.longitude));
        }
        clock = Math.max(clock, parseMin(it.startTime) + 60);
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      const leg = prevPoint
        ? await this.transportLeg(prevPoint.lat, prevPoint.lon, it.latitude, it.longitude)
        : undefined;

      // 显式锚点：保留该条目原 startTime，只重算其交通腿，之后按此时钟顺推
      if (opts?.keepFirstStartTime && i === fromItemIndex) {
        it.startTime = it.startTime || formatTime(clock);
        setLeg(it, leg);
        clock = parseMin(it.startTime) + visitOf(it);
        prevPoint = { lat: it.latitude, lon: it.longitude };
        continue;
      }

      if (it.type === 'restaurant') {
        // 午/晚餐锚定（与编排期一致）：原 startTime 在 15 点前视为午餐
        const lunch = parseMin(it.startTime) < 15 * 60;
        const mealTime = lunch
          ? Math.max(11 * 60, Math.min(13 * 60, clock))
          : Math.max(17.5 * 60, clock + 30);
        it.startTime = formatTime(mealTime);
        setLeg(it, leg);
        clock = mealTime + 75;
      } else {
        const arrival = clock + (leg?.durationMin ?? 0);
        it.startTime = formatTime(arrival);
        setLeg(it, leg);
        clock = arrival + visitOf(it);
      }
      prevPoint = { lat: it.latitude, lon: it.longitude };
    }

    return { dayEndMin: clock };
  }

  /**
   * 公开入口：按类型+坐标找「同类替代 POI」（行程面板「提意见换一个」）。
   * 复用现有 Overpass 周边搜索（以条目坐标为圆心，不做地理编码）：
   * 排除同名 POI → 按 comment 关键词粗略加权（命中名称/标签越多越靠前）→
   * 关键词全不命中时自然回退「距离最近」→ 取排序后第一个。
   * 找不到候选（网络失败/无结果）返回 null，由调用方决定 404 语义。
   */
  async findAlternativePoi(
    type: 'attraction' | 'hotel' | 'restaurant',
    latitude: number,
    longitude: number,
    excludeName: string,
    comment?: string,
  ): Promise<RawPOI | null> {
    const center: Coordinates = { latitude, longitude };
    let candidates: RawPOI[] = [];
    try {
      if (type === 'hotel') candidates = await this.searchHotels(center, '');
      else if (type === 'restaurant') candidates = await this.searchRestaurants(center, '');
      else candidates = await this.searchAttractions(center, '');
    } catch (err) {
      console.warn(`[PlanningService] 替代 POI 搜索失败(${type}):`, err instanceof Error ? err.message : String(err));
      return null;
    }
    const exclude = excludeName.trim().toLowerCase();
    const pool = candidates.filter(p => p.name && p.name.trim().toLowerCase() !== exclude);
    if (pool.length === 0) return null;

    // comment 关键词粗略分词（保留 ≥2 字符 token），命中名称/标签加分
    const keywords = (comment ?? '')
      .split(/[\s，。！？、,.!?;；:：()（）[\]【】]+/)
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 2);
    const scored = pool.map(poi => {
      const hay = `${poi.name} ${(poi.tags || []).join(' ')}`.toLowerCase();
      let score = keywords.reduce((acc, kw) => (hay.includes(kw) ? acc + 100 : acc), 0);
      score -= this.haversineKm(latitude, longitude, poi.latitude, poi.longitude);
      return { poi, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.poi ?? null;
  }

  /**
   * 公开入口：搜索目的地指定类型 POI（行程面板「单项编辑器」备选搜索）。
   * 走 searchDestination 的缓存/网络/知识库全链路，可按关键词粗滤名称/标签，
   * 逐条用 PricingService 报价生成 priceInfo，最多返回 limit 条。
   */
  async searchPois(
    destination: string,
    type: 'attraction' | 'hotel' | 'restaurant',
    keyword?: string,
    limit: number = 8,
  ): Promise<Array<{
    name: string;
    type: 'attraction' | 'hotel' | 'restaurant';
    latitude: number;
    longitude: number;
    address: string;
    priceInfo: string;
    tags: string[];
    /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（缓存 POI 带有时透传） */
    splatUrl?: string;
  }>> {
    const result = await this.searchDestination(destination, type);
    const bucket = type === 'hotel' ? result.hotels : type === 'restaurant' ? result.restaurants : result.attractions;
    const kw = keyword?.trim().toLowerCase() ?? '';
    const matched = kw
      ? bucket.filter(p => `${p.name} ${(p.tags || []).join(' ')}`.toLowerCase().includes(kw))
      : bucket;
    const pricingCtx: PricingContext = { destination, preferences: {} };
    return matched.slice(0, Math.max(1, limit)).map(p => {
      const quote = type === 'hotel'
        ? pricingService.quoteHotel(p.name, p.tags || [], pricingCtx)
        : type === 'attraction'
          ? pricingService.quoteAttraction(p.name, p.tags || [], pricingCtx)
          : pricingService.quoteRestaurant(p.name, p.tags || [], pricingCtx);
      return {
        name: p.name,
        type,
        latitude: p.latitude,
        longitude: p.longitude,
        address: p.address,
        priceInfo: formatQuotePriceInfo(quote),
        tags: p.tags || [],
        ...(p.splatUrl ? { splatUrl: p.splatUrl } : {}),
      };
    });
  }

  /**
   * Skill 只读入口：获取目的地实用信息（签证/货币/最佳季节/通信等），无匹配时返回默认。 */
  async getDestinationInfo(destName: string): Promise<TravelInfo> {
    return this.extractTravelInfo(destName);
  }

  /**
   * Skill 只读入口：计算两点间交通（模式/时长/距离）。
   * from/to 支持 "纬度,经度" 或 "地名"（自动地理编码）。
   */
  async computeRoute(from: string | Coordinates, to: string | Coordinates): Promise<{
    mode: string;
    durationMin: number;
    distanceKm: number;
    note?: string;
  }> {
    const resolve = async (p: string | Coordinates): Promise<Coordinates> => {
      if (typeof p !== 'string') return p;
      const trimmed = p.trim();
      const parts = trimmed.split(',').map(s => Number(s.trim()));
      if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
        return { latitude: parts[0], longitude: parts[1] };
      }
      const geo = await this.geocode(trimmed);
      return geo.center;
    };
    const [fromC, toC] = await Promise.all([resolve(from), resolve(to)]);

    // 优先用 OSRM 真实路网（免费、无需 key）；请求失败/超时自动降级直线估算
    const viaOSRM = await this.osrmRoute(
      fromC.latitude, fromC.longitude, toC.latitude, toC.longitude,
    );
    if (viaOSRM) {
      console.log(`[PlanningService] OSRM 路网路线: ${viaOSRM.distanceKm.toFixed(1)}km / ${viaOSRM.durationMin}min`);
      return viaOSRM;
    }
    return this.computeTransport(fromC.latitude, fromC.longitude, toC.latitude, toC.longitude);
  }

  /**
   * OSRM 开放路由服务：返回两点间真实路网（驾车优先）的耗时/距离。
   * - 服务器地址可用 env TRAVEL_ROUTE_API_BASE 覆盖（默认公共 demo 节点）
   * - 任何失败（网络/超时/无路由）返回 null，由调用方降级到 haversine 估算
   */
  private async osrmRoute(
    fromLat: number, fromLon: number, toLat: number, toLon: number,
  ): Promise<{ mode: string; durationMin: number; distanceKm: number; note?: string } | null> {
    try {
      const base = (process.env.TRAVEL_ROUTE_API_BASE || 'https://router.project-osrm.org').replace(/\/+$/, '');
      const url =
        `${base}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}` +
        `?overview=false&alternatives=false&steps=false`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const data = await res.json() as {
        code?: string;
        routes?: Array<{ distance?: number; duration?: number }>;
      };
      const route = data?.routes?.[0];
      if (data?.code !== 'Ok' || !route) return null;

      const km = (route.distance ?? 0) / 1000;
      if (!(km > 0)) return null;
      const durationMin = Math.max(1, Math.round((route.duration ?? 0) / 60));
      // 按真实距离分档推断交通方式（与 haversine 估算的口径一致）
      const mode = km < 1 ? '步行' : km < 5 ? '打车/Grab' : km < 30 ? '包车/网约车' : '城际交通';
      return { mode, durationMin, distanceKm: km, note: km < 1 ? '短距离' : undefined };
    } catch {
      return null; // 网络/超时/解析失败 → 上层降级
    }
  }

  /** Skill 只读入口：健康自检（缓存数据量 + 内置知识覆盖） */
  async healthCheck(): Promise<{
    cachedDestinations: number;
    poiCacheStats: { memoryEntries: number; fileEntries: number };
  }> {
    const stats = poiCache.getStats();
    return {
      cachedDestinations: poiCache.listCachedDestinations().length,
      poiCacheStats: { memoryEntries: stats.memoryEntries, fileEntries: stats.fileEntries },
    };
  }

  /**
   * 将 agent 返回的 itinerary 转换为 PlanningResult
   * - 已是 PlanningResult 格式（含 id/days/destination）→ 直接用
   * - LLM 输出格式（含 days）→ 包装为 PlanningResult（补齐缺失字段）
   * - 其他/空 → 返回 null 触发降级
   */
  private toPlanningResult(
    itinerary: unknown,
    request: PlanningRequest,
  ): PlanningResult | null {
    if (!itinerary || typeof itinerary !== 'object') return null;
    const obj = itinerary as Record<string, unknown>;

    // 已是 PlanningResult 格式
    if ('id' in obj && 'days' in obj && 'destination' in obj) {
      return itinerary as PlanningResult;
    }

    // LLM 输出格式 { days: [...] } → 包装
    if ('days' in obj && Array.isArray(obj.days)) {
      const destName = request.destination || extractDestination(request.input, request.destination);
      const today = new Date();
      const startDate = today.toISOString().split('T')[0] ?? '';
      return {
        id: `plan-agent-${Date.now()}`,
        title: request.input.slice(0, 50),
        description: request.input,
        startDate,
        endDate: startDate,
        destination: destName,
        center: { latitude: 0, longitude: 0 },
        days: obj.days as PlannedDay[],
        pois: [],
        preferences: extractPreferences(request.input, request.preferences, destName),
        travelInfo: this.extractTravelInfo(destName),
        fromCache: false,
      };
    }

    return null;
  }

  /**
   * 汇总整个行程的价格：按 dayCount 折算酒店晚数、聚合景点/餐厅
   */
  private _summarizePricing(days: PlannedDay[], ctx: import('./pricing-service.js').PricingContext): PlanningResult['pricingSummary'] {
    let totalOriginal = 0, totalFinal = 0;
    const warnings: string[] = [];
    const nightCount = Math.max(1, days.length - 1);

    const hotelQuotes: PriceQuote[] = [];
    const attractionQuotes: PriceQuote[] = [];
    const restaurantQuotes: PriceQuote[] = [];

    days.forEach(day => {
      (day.items || []).forEach(it => {
        if (it.type === 'hotel') {
          // hotel: 价格只算一次（取首次），qty = nightCount
          if (hotelQuotes.length === 0 && it.priceQuote) {
            hotelQuotes.push(it.priceQuote);
            totalOriginal += it.priceQuote.originalPrice * nightCount;
            totalFinal += it.priceQuote.finalPrice * nightCount;
          }
        } else if (it.type === 'attraction') {
          if (it.priceQuote) {
            attractionQuotes.push(it.priceQuote);
            totalOriginal += it.priceQuote.originalPrice;
            totalFinal += it.priceQuote.finalPrice;
          }
        } else if (it.type === 'restaurant') {
          if (it.priceQuote) {
            restaurantQuotes.push(it.priceQuote);
            totalOriginal += it.priceQuote.originalPrice;
            totalFinal += it.priceQuote.finalPrice;
          }
        }
      });
    });

    // 价格模式提示
    const mode = (process.env.PRICING_MODE as 'real-api' | 'real-database' | 'estimated') || 'real-database';
    if (mode === 'estimated') {
      warnings.push('当前为估算价，建议在预订平台核对后再下单');
    } else if (mode === 'real-database') {
      warnings.push('价格来自真实市场数据库，最终以下单平台为准');
    } else {
      warnings.push('价格来自实时预订 API，下单时可能因库存/汇率小幅波动');
    }

    // 绑定平台提示
    if (ctx.boundPlatforms && ctx.boundPlatforms.length) {
      const names = ctx.boundPlatforms.map(p => p.displayName).filter(Boolean);
      if (names.length) {
        warnings.push(`已应用绑定平台优惠：${names.join('、')}`);
      }
    } else {
      warnings.push('未绑定任何平台账户，价格为非会员参考价；绑定 Booking/Agoda/携程/美团 等平台可享真实会员优惠');
    }

    return {
      currency: 'CNY',
      totalOriginal,
      totalDiscount: totalOriginal - totalFinal,
      totalFinal,
      memberTier: ctx.memberTier,
      boundPlatforms: ctx.boundPlatforms,
      pricingMode: mode,
      warnings,
    };
  }


  // ======================== 行程附加实用信息 ========================

  /**
   * 提供目的地实用信息：签证、货币、时区、最佳季节、紧急、禁忌、贴士
   * 用户没问也补
   */
  private extractTravelInfo(destName: string): TravelInfo {
    const info = this.findKnownTravelInfo(destName);
    if (info) return info;
    // 兜底：通用模板
    return {
      destination: destName,
      visa: { required: false, type: '免签', notes: '请以最新使领馆公告为准' },
      currency: { name: '当地货币', code: 'XXX', symbol: '' },
      timezone: { name: '当地时间', offset: 'UTC+0' },
      language: ['当地官方语言'],
      voltage: '220V / 50Hz',
      socket: '双孔欧标（建议带万能转换头）',
      bestSeason: { months: ['全年'], description: '请按当地气候选择合适季节出行' },
      emergency: { police: '110', ambulance: '120', touristHotline: '请查询当地旅游热线', chinaEmbassy: '请查询中国驻当地使馆电话' },
      customs: ['尊重当地风俗', '遵守公共场所秩序'],
      tips: ['建议出发前购买旅游保险', '保留好护照/签证/票据复印件'],
      packing: ['证件/身份证', '充电器与转换插头', '常用药品', '防晒/雨具按季节'],
    };
  }

  private findKnownTravelInfo(destName: string): TravelInfo | null {
    // KnownTravelInfo 为结构类型（visa.type 未收窄为字面量联合），数据文件即 schema 来源
    return knowledgeBase.findKnownTravelInfo(destName) as TravelInfo | null;
  }

  // ======================== 实时搜索 + 缓存写入 ========================

  /**
   * 调用POI搜索API并存入缓存（同 key 并发共享同一个 Promise，防缓存击穿：
   * Nominatim 有 1 req/s 使用政策，并发重复请求容易触发限流拉长所有请求）。
   */
  private async searchAndCache(destName: string, normalizedKey: string): Promise<CacheEntry> {
    const inFlight = this.inFlightSearches.get(normalizedKey);
    if (inFlight) {
      console.log(`[PlanningService] 并发去重: 复用「${destName}」进行中的搜索请求`);
      return inFlight;
    }
    const task = this.doSearchAndCache(destName, normalizedKey).finally(() => {
      this.inFlightSearches.delete(normalizedKey);
    });
    this.inFlightSearches.set(normalizedKey, task);
    return task;
  }

  private async doSearchAndCache(destName: string, normalizedKey: string): Promise<CacheEntry> {
    console.log(`[PlanningService] 正在搜索: ${destName} ...`);

    // Step 1: 地理编码 → 获取中心坐标
    const geoResult = await this.geocode(destName);
    const center = geoResult.center;
    console.log(`[PlanningService] 地理编码成功: [${center.longitude}, ${center.latitude}]`);

    // Step 2: 根据国内外分流选择数据源
    const domestic = isDomesticDestination(destName);
    let attractions: RawPOI[], hotels: RawPOI[], restaurants: RawPOI[];

    if (domestic) {
      // ===== 国内：高德地图 POI 搜索 =====
      console.log(`[PlanningService] 检测到国内目的地，使用高德地图API`);
      const amapResult = await this.searchWithAmap(center, destName);
      attractions = amapResult.attractions;
      hotels = amapResult.hotels;
      restaurants = amapResult.restaurants;

      // 高德无结果时降级到OSM
      if (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0) {
        console.warn(`[PlanningService] 高德无结果，尝试OSM降级...`);
        const osmResult = await this.searchWithOSM(center, destName);
        attractions = osmResult.attractions;
        hotels = osmResult.hotels;
        restaurants = osmResult.restaurants;
      }
    } else {
      // ===== 国外：OpenStreetMap Overpass API =====
      console.log(`[PlanningService] 检测到国外目的地，使用OSM Overpass API`);
      const osmResult = await this.searchWithOSM(center, destName);
      attractions = osmResult.attractions;
      hotels = osmResult.hotels;
      restaurants = osmResult.restaurants;
    }

    console.log(
      `[PlanningService] 搜索完成: 景点${attractions.length} 酒店${hotels.length} 餐厅${restaurants.length}` +
      ` (数据源: ${domestic ? '高德' : 'OSM'})`
    );

    // Step 2.5: 类别缺口补齐（鲁棒性）：任一类别为空而知名库有该类别数据时，
    // 用知识库真实 POI 补齐。避免「酒店有、景点/餐厅空」的部分搜索结果被缓存
    // 永久污染该目的地（缓存命中后直接编排出 0 个景点/餐厅的残缺行程）。
    if (attractions.length === 0 || hotels.length === 0 || restaurants.length === 0) {
      const known = this.findKnownPOIs(destName);
      if (known) {
        if (attractions.length === 0 && known.attractions.length > 0) {
          console.log(`[PlanningService] 景点结果为空，用知名库补齐 ${known.attractions.length} 个`);
          attractions = known.attractions;
        }
        if (hotels.length === 0 && known.hotels.length > 0) {
          console.log(`[PlanningService] 酒店结果为空，用知名库补齐 ${known.hotels.length} 个`);
          hotels = known.hotels;
        }
        if (restaurants.length === 0 && known.restaurants.length > 0) {
          console.log(`[PlanningService] 餐厅结果为空，用知名库补齐 ${known.restaurants.length} 个`);
          restaurants = known.restaurants;
        }
      }
    }

    // Step 3: 所有 API 都返回空结果时，只回退到知识库真实地点；
    // 知识库也未命中 → 抛错诚实失败，绝不生成合成占位行程。
    let knowledgeFallback = false;
    if (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0) {
      console.warn(`[PlanningService] 所有API均无结果，尝试知识库真实POI兜底`);
      const known = this.knownPoiFallback(destName);
      if (known) {
        attractions = known.attractions;
        hotels = known.hotels;
        restaurants = known.restaurants;
        knowledgeFallback = true;
      } else {
        throw new Error(
          `目的地「${destName}」的实时数据暂不可用（POI 搜索无结果且无本地知识库），已拒绝生成估算行程；请稍后重试或换个目的地表达`,
        );
      }
    }

    // Step 4: 写入缓存（内存+文件持久化，全局共享）。
    // 知识库兜底与空结果都不落缓存：一次网络故障降级的数据不应在 TTL 内
    // 阻止后续重试拿到实时数据。
    if (knowledgeFallback || (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0)) {
      console.warn(`[PlanningService] 跳过 POI 缓存写入（${knowledgeFallback ? "知识库兜底" : "空结果"} 不缓存）`);
      return {
        destination: destName,
        queryKey: normalizedKey,
        data: { attractions, hotels, restaurants },
        center,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        accessCount: 0,
      };
    }
    const entry = poiCache.set(normalizedKey, { attractions, hotels, restaurants }, center);

    return entry;
  }

  /**
   * 通过OSM Overpass API搜索POI（国外/备选数据源）
   */
  private async searchWithOSM(center: Coordinates, destName: string): Promise<{
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  }> {
    const [attractions, hotels, restaurants] = await Promise.all([
      this.searchAttractions(center, destName),
      this.searchHotels(center, destName),
      this.searchRestaurants(center, destName),
    ]);
    return { attractions, hotels, restaurants };
  }

  /**
   * 真实数据兜底：仅回退到知识库中的真实地点（名称/坐标可在高德/Google Maps 查到）。
   * 历史版本在此处用 Math.random 生成「当地中心景区」等合成占位 POI——那是在向用户
   * 提供编造数据，已彻底移除。知识库未命中时返回 null，由调用方诚实失败（不落缓存、
   * 不生成行程），用户会收到明确的重试提示而不是一份假行程。
   */
  private knownPoiFallback(destName: string): {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  } | null {
    const known = this.findKnownPOIs(destName);
    if (known) {
      console.log(`[PlanningService] 使用${destName}的知识库真实POI数据（非实时，已标注 dataQuality=knowledge）`);
      return known;
    }
    return null;
  }

  /**
   * 知名目的地真实POI数据库
   * 所有名称均为真实存在的地点，可在高德/Google Maps上搜索到
   * 包含近似坐标（用于地图展示）
   */
  private findKnownPOIs(destName: string): {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  } | null {
    return knowledgeBase.findKnownPOIs(destName);
  }

  // ======================== OpenStreetMap API 调用 ========================

  /**
   * Nominatim 地理编码：地名 → 经纬度
   */
  private async geocode(query: string): Promise<{ center: Coordinates; displayName: string }> {
    // 提速优化：先查本地已知坐标表。命中则毫秒级返回，跳过 Nominatim 网络请求。
    // 绝大多数热门/常见目的地都命中本地表，首询可省掉最长 20s 的地理编码网络等待，
    // 只有冷门目的地才回落到 Nominatim 兜底。
    const knownLocal = this.findKnownCoordinates(query);
    if (knownLocal) {
      console.log(
        `[OSM] 使用本地坐标: ${knownLocal.name} [${knownLocal.center.longitude}, ${knownLocal.center.latitude}]`,
      );
      return { center: knownLocal.center, displayName: knownLocal.name };
    }

    const url = `${OSM_NOMINATIM_BASE}?` +
      `q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1&accept-language=zh`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(GEOCODE_REQUEST_TIMEOUT_MS),
      });

      const data = await res.json() as Array<Record<string, unknown>>;

      if (data && data.length > 0) {
        const item = data[0];
        if (item) {
          const lat = parseFloat(String(item.lat));
          const lon = parseFloat(String(item.lon));

          return {
            center: { latitude: lat, longitude: lon },
            displayName: String(item.display_name ?? '') || query,
          };
        }
      }

      throw new Error('未找到地理位置');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[OSM] 地理编码失败(${query}):`, msg);
      // 备用 geocoder：Nominatim 超时/限流时切 Photon 重试，而不是直接抛错走知识库
      const photon = await this.geocodeByPhoton(query);
      if (photon) {
        console.log(`[OSM] Photon 备用命中: ${photon.displayName} [${photon.center.longitude}, ${photon.center.latitude}]`);
        return photon;
      }
      // 知识库坐标兜底（真实地点坐标，可在地图上查到）
      const known = this.findKnownCoordinates(query);
      if (known) {
        console.log(`[OSM] 使用已知坐标: ${known.name} [${known.center.longitude}, ${known.center.latitude}]`);
        return { center: known.center, displayName: known.name };
      }
      // 诚实失败：绝不返回猜测坐标。历史版本兜底到「中国中心」——那会让整个行程
      // 建在错误的坐标上（假数据），现已改为向上抛错由调用方明确告知用户。
      throw new Error(`无法定位目的地「${query}」（地理编码服务不可用或地名无法识别）`);
    }
  }

  /**
   * Photon 备用地理编码（photon.komoot.io，免费、无需 Key）。
   * 失败返回 null 由调用方继续降级，绝不抛错。
   */
  private async geocodeByPhoton(query: string): Promise<{ center: Coordinates; displayName: string } | null> {
    try {
      const url = `${PHOTON_GEOCODE_BASE}?q=${encodeURIComponent(query)}&limit=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(PHOTON_REQUEST_TIMEOUT_MS),
      });
      const json = await res.json() as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: Record<string, unknown>;
        }>;
      };
      const coords = json.features?.[0]?.geometry?.coordinates;
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
      const p = json.features?.[0]?.properties ?? {};
      const displayName = [p.name, p.city, p.country].filter((v) => typeof v === 'string' && v).join(', ') || query;
      return { center: { latitude: coords[1]!, longitude: coords[0]! }, displayName };
    } catch {
      return null;
    }
  }

  /**
   * 已知目的地坐标表（当OSM地理编码不可用时的兜底）
   * 覆盖国内外热门旅游目的地
   */
  private findKnownCoordinates(query: string): { name: string; center: Coordinates } | null {
    return knowledgeBase.findKnownCoordinates(query);
  }

  /**
   * Overpass API 搜索景点（精简查询，避免超时）
   */
  private async searchAttractions(center: Coordinates, cityHint: string): Promise<RawPOI[]> {
    const query = `
      [out:json][timeout:15];
      (
        node["tourism"](around:25000,${center.latitude},${center.longitude});
        way["tourism"](around:25000,${center.latitude},${center.longitude});
        node["historic"](around:20000,${center.latitude},${center.longitude});
        way["historic"](around:20000,${center.latitude},${center.longitude});
        node["leisure"~"park|garden"](around:25000,${center.latitude},${center.longitude});
        way["leisure"~"park|garden"](around:25000,${center.latitude},${center.longitude});
      );
      out body center;
      (._; >;);
      out skel qt;
    `;

    const results = await this.overpassQuery(query);
    // 过滤掉酒店和餐厅类型的，只保留景点
    const attractions = results.filter(r => {
      const tags = r.raw?.tags as Record<string, string> | undefined;
      const tourism = tags?.tourism || '';
      // 排除酒店类
      if (['hotel', 'hostel', 'guest_house', 'motel', 'camp_site'].includes(tourism)) return false;
      return true;
    });
    return attractions.slice(0, 12).map(r => ({
      ...r,
      type: 'attraction',
    }));
  }

  /**
   * Overpass API 搜索酒店（精简查询）
   */
  private async searchHotels(center: Coordinates, cityHint: string): Promise<RawPOI[]> {
    const query = `
      [out:json][timeout:12];
      (
        node["tourism"="hotel"](around:25000,${center.latitude},${center.longitude});
        way["tourism"="hotel"](around:25000,${center.latitude},${center.longitude});
      );
      out body center;
      (._; >;);
      out skel qt;
    `;

    const results = await this.overpassQuery(query);
    return results.slice(0, 8).map(r => ({
      ...r,
      type: 'hotel',
    }));
  }

  /**
   * Overpass API 搜索餐厅（精简查询）
   */
  private async searchRestaurants(center: Coordinates, cityHint: string): Promise<RawPOI[]> {
    const query = `
      [out:json][timeout:12];
      (
        node["amenity"="restaurant"](around:20000,${center.latitude},${center.longitude});
        node["amenity"="cafe"](around:15000,${center.latitude},${center.longitude});
      );
      out body center;
      (._; >;);
      out skel qt;
    `;

    const results = await this.overpassQuery(query);
    return results.slice(0, 8).map(r => ({
      ...r,
      type: 'restaurant',
    }));
  }

  /**
   * Overpass API 通用查询（多镜像并行 + 短超时）
   */
  private async overpassQuery(overpassQL: string): Promise<RawPOI[]> {
    const tryParseElements = async (res: Response): Promise<Array<Record<string, unknown>> | null> => {
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        const text = await res.text();
        console.warn(`[Overpass] 非JSON响应 (${res.status})，已忽略: ${text.slice(0, 120)}`);
        return null;
      }
      const json = await res.json() as { elements?: Array<Record<string, unknown>>; remark?: string };
      if (json.remark) {
        console.warn(`[Overpass] API备注: ${json.remark}`);
      }
      return json.elements || [];
    };

    // 并行请求所有镜像，首个成功（HTTP 200 + JSON + 有 elements）即胜出并 abort
    // 其余在途请求——避免落败镜像继续跑满整个超时窗口占用连接与重试预算。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_REQUEST_TIMEOUT_MS);
    try {
      const attempts = OSM_OVERPASS_BASES.map(async (base) => {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: `data=${encodeURIComponent(overpassQL)}`,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`${new URL(base).host} HTTP ${res.status}`);
        }
        const elements = await tryParseElements(res);
        if (!elements || elements.length === 0) {
          throw new Error(`${new URL(base).host} 空结果`);
        }
        return { base, elements };
      });

      let winner: { base: string; elements: Array<Record<string, unknown>> };
      try {
        winner = await Promise.any(attempts);
      } catch {
        // AggregateError：所有镜像均失败（含被 abort 的在途请求）
        console.warn('[Overpass] 所有镜像均不可用，触发合成数据降级');
        return [];
      }
      // 首个成功者已产生：取消其余镜像的在途请求
      controller.abort();

      return winner.elements
      .filter(el => {
        if (el.lat !== undefined && el.lon !== undefined) return true;
        // way/relation 元素：out center 输出的是 center.{lat,lon}
        const center = el.center as { lat?: unknown; lon?: unknown } | undefined;
        return center?.lat !== undefined && center?.lon !== undefined;
      })
      .map((el, idx) => {
        const tags = el.tags as Record<string, string> | undefined;
        const name = tags?.name || tags?.['name:zh'] || tags?.['name:en'] || `地点${idx + 1}`;
        const center = el.center as { lat?: unknown; lon?: unknown } | undefined;
        const lat = typeof el.lat === 'number' ? el.lat : parseFloat(String(el.lat ?? center?.lat));
        const lon = typeof el.lon === 'number' ? el.lon : parseFloat(String(el.lon ?? center?.lon));

        // 构建地址
        let address = '';
        if (tags?.['addr:city']) address += tags['addr:city'];
        if (tags?.['addr:road']) address += (address ? ', ' : '') + tags['addr:road'];

        return {
          id: String(el.id || `osm-${idx}`),
          name,
          latitude: lat,
          longitude: lon,
          address: address || `${name}附近`,
          type: '',
          tags: Object.keys(tags || {}).slice(0, 8),
          raw: { ...el, tags },
        };
      })
      .filter(poi => !isNaN(poi.latitude) && !isNaN(poi.longitude));
    } finally {
      clearTimeout(timer);
    }
  }

  // ======================== 高德地图 API 调用 ========================

  /**
   * 高德POI关键词搜索（国内目的地使用）
   * 文档: https://lbs.amap.com/api/webservice/guide/api/search
   */
  private async amapSearchPOI(
    keywords: string,
    city: string,
    poiType: 'attraction' | 'hotel' | 'restaurant',
    limit: number = 10
  ): Promise<RawPOI[]> {
    if (!AMAP_KEY) {
      console.warn('[Amap] 未配置 AMAP_WEB_KEY，跳过高德搜索');
      return [];
    }

    const typeCode = AMAP_POI_TYPES[poiType] || '';
    const params = new URLSearchParams({
      key: AMAP_KEY,
      keywords,
      city,
      types: typeCode,
      output: 'json',
      offset: String(limit),
      page: '1',
      extensions: 'base', // 返回基础信息(地址/电话/评分等)
    });

    const url = `${AMAP_POI_BASE}?${params.toString()}`;
    console.log(`[Amap] 搜索${poiType}: keywords="${keywords}", city="${city}"`);

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(AMAP_REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(`[Amap] HTTP ${res.status}: ${url.slice(0, 80)}`);
        return [];
      }

      const data = await res.json() as {
        status?: string;
        info?: string;
        pois?: Array<{
          id: string;
          name: string;
          location: string; // "lng,lat"
          address: string;
          tel?: string;
          type?: string;
          typecode?: string;
          pname?: string;
          cityname?: string;
          adname?: string;
          rating?: string;
          cost?: string;
        }>;
      };

      if (data.status !== '1' || !data.pois || data.pois.length === 0) {
        console.warn(`[Amap] 无结果或错误: ${data.info || 'unknown'}`);
        return [];
      }

      console.log(`[Amap] 找到 ${data.pois.length} 个${poiType}`);

      return data.pois.map((poi, idx) => {
        const parts = (poi.location || ',').split(',').map(Number);
        const lon: number = parts[0] ?? 0;
        const lat: number = parts[1] ?? 0;
        return {
          id: `amap-${poi.id || idx}`,
          name: poi.name || `地点${idx + 1}`,
          latitude: isNaN(lat) ? 0 : lat,
          longitude: isNaN(lon) ? 0 : lon,
          address: poi.address || `${poi.cityname || ''}${poi.adname || ''}${poi.name}`,
          type: poiType,
          rating: poi.rating ? parseFloat(poi.rating) : 4.0,
          tags: [
            poi.type || poiType,
            poi.typecode || '',
            poi.pname || '',
            poi.cityname || '',
            poi.adname || '',
          ].filter(Boolean),
          raw: { ...poi, source: 'amap' },
        } as RawPOI;
      }).filter(poi => !isNaN(poi.latitude) && !isNaN(poi.longitude) && poi.latitude !== 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Amap] 搜索失败(${keywords}):`, msg);
      return [];
    }
  }

  /**
   * 通过高德API搜索国内目的地的全部POI
   * 并行搜索景点/酒店/餐厅三类
   */
  private async searchWithAmap(center: Coordinates, destName: string): Promise<{
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  }> {
    // 用城市名作为搜索关键词和城市限定
    const cityHint = this.extractCityName(destName);

    const [attractions, hotels, restaurants] = await Promise.all([
      // 景点：搜索风景名胜 + 知名景点关键词
      this.amapSearchPOI('旅游景点|景点|景区|公园|名胜|古迹|博物馆|古镇|古城|寺庙|海滩|雪山|湖泊', cityHint, 'attraction', 15),
      // 酒店
      this.amapSearchPOI('酒店|宾馆|民宿|客栈|度假村|旅馆', cityHint, 'hotel', 10),
      // 餐厅：搜索美食相关
      this.amapSearchPOI('餐厅|美食|饭店|小吃|火锅|烧烤|咖啡|茶馆|特色菜|当地菜', cityHint, 'restaurant', 10),
    ]);

    return { attractions, hotels, restaurants };
  }

  /**
   * 从目的地名称中提取城市名（用于高德API的city参数）
   * 处理如 "云南大理" → "大理", "云南丽江" → "丽江"
   */
  private extractCityName(destName: string): string {
    // 常见省份前缀去除
    const provincePrefixes = [
      '云南','四川','浙江','江苏','山东','河南','湖北','湖南','广东','福建','安徽',
      '江西','河北','山西','辽宁','吉林','黑龙江','陕西','甘肃','青海','贵州','台湾',
      '内蒙古','广西','西藏','宁夏','新疆','海南','香港','澳门',
    ];
    let city = destName.trim();
    for (const prefix of provincePrefixes) {
      if (city.startsWith(prefix)) {
        city = city.slice(prefix.length).trim();
        break;
      }
    }
    // 如果提取后太短，返回原始名称
    return city.length >= 2 ? city : destName.trim();
  }

  // ======================== 行程构建 ========================

  /**
   * Haversine 距离（公里）
   */
  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * 根据两点距离推算交通方式与时长
   */
  private computeTransport(fromLat: number, fromLon: number, toLat: number, toLon: number): { mode: string; durationMin: number; distanceKm: number; note?: string } {
    const km = this.haversineKm(fromLat, fromLon, toLat, toLon);
    if (km < 1) {
      return { mode: '步行', durationMin: Math.max(5, Math.round(km * 14)), distanceKm: km, note: '短距离' };
    }
    if (km < 5) {
      return { mode: '打车/Grab', durationMin: Math.round(km * 3 + 5), distanceKm: km };
    }
    if (km < 30) {
      return { mode: '包车/网约车', durationMin: Math.round(km * 1.5 + 5), distanceKm: km };
    }
    return { mode: '城际交通', durationMin: Math.round(km * 1.0 + 15), distanceKm: km, note: '距离较远，建议预留更多时间' };
  }

  /**
   * 估算游览/用餐时长（分钟）
   */
  private inferVisitDuration(type: 'hotel' | 'attraction' | 'restaurant', prefs: TripPreferences): number {
    if (type === 'hotel') return 30; // 入住/退房办理
    if (type === 'restaurant') return 75;
    // attraction
    let base = 120;
    if (prefs.pace === 'relaxed') base = 150;
    else if (prefs.pace === 'intensive') base = 90;
    if (prefs.activities) base += 30; // 体验型更久
    return base;
  }

  /**
   * 根据偏好为每个 item 生成小贴士（用户没问也补）
   */
  private generateItemTips(
    poi: RawPOI,
    type: 'hotel' | 'attraction' | 'restaurant',
    prefs: TripPreferences,
    travelInfo: TravelInfo
  ): string[] {
    const tips: string[] = [];
    if (type === 'hotel') {
      tips.push('建议提前1-2周预订，价格更优且可选房型更多');
      if (prefs.pool) tips.push('可向酒店确认泳池开放时间，部分需另付费');
      if (prefs.seaside) tips.push('海景房建议指定高层，体验更佳');
    } else if (type === 'attraction') {
      if (prefs.activities) tips.push('建议提前在官方渠道购票，避免现场排队');
      tips.push('建议工作日上午或下午4点后错峰，避开旅行团');
      const tagStr = (poi.tags || []).join(' ');
      if (/temple|寺庙/.test(tagStr)) tips.push('需着装得体，覆盖肩膀与膝盖');
      if (/beach|海/.test(tagStr)) tips.push('请做好防晒并看管好个人物品');
    } else if (type === 'restaurant') {
      tips.push('高峰期建议提前订位或错峰前往');
      if (prefs.cuisine) tips.push(`本地推荐尝试${prefs.cuisine}菜`);
    }
    if (travelInfo.tips.length) {
      // 抽 1 条目的地通用贴士
      tips.push(travelInfo.tips[0] ?? '请遵守当地秩序');
    }
    return tips.slice(0, 3);
  }

  /**
   * 酒店/付费景点的预订提示
   */
  private generateBookingNote(
    poi: RawPOI,
    type: 'hotel' | 'attraction' | 'restaurant',
    prefs: TripPreferences
  ): string | undefined {
    if (type === 'hotel') {
      const season = prefs.kids ? '亲子房通常需提前确认床型' : '旺季建议提前2周以上预订';
      return season;
    }
    if (type === 'attraction') {
      const tagStr = (poi.tags || []).join(' ');
      if (/fee|ticket|paid|门票/.test(tagStr)) {
        return '建议通过官方/合作平台预订电子票，凭二维码入场';
      }
    }
    return undefined;
  }

  /**
   * 根据偏好+天气对POI进行重排序（不删除，只把更匹配的放前面）
   *
   * 天气感知（B3）：雨天/高温时把室内景点前置、室外景点后置；
   * 夜景/夜间专属景点小幅前置，具体晚间分槽在 buildDaysFast 中进一步处理。
   */
  private rankPOIsByPreferences(
    attractions: RawPOI[],
    hotels: RawPOI[],
    restaurants: RawPOI[],
    prefs: TripPreferences,
    weather?: TripWeatherCtx | null
  ): { attractions: RawPOI[]; hotels: RawPOI[]; restaurants: RawPOI[] } {
    const score = (poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): number => {
      const hay = `${poi.name} ${(poi.tags || []).join(' ')}`.toLowerCase();
      let s = this.effectiveRating(poi, type); // 本地评论聚合分混合（媒体库优先）
      // C5 收藏加权：用户收藏过的地点（type:name 精确匹配，餐厅与景点同名互不污染）
      if (this.favoriteKeys.has(`${type}:${poi.name}`)) s += SCORING.favoriteBoost;
      if (type === 'hotel') {
        if (prefs.seaside && /(海|滩|湾|beach|bay|coast|seaside|ocean)/i.test(hay)) s += SCORING.hotel.seaside;
        if (prefs.pool && /(泳池|游泳池|pool|swimming)/i.test(hay)) s += SCORING.hotel.pool;
        if (prefs.kids && /(亲子|家庭|儿童|kid|family)/i.test(hay)) s += SCORING.hotel.kids;
        if (prefs.elderly && /(无障碍|电梯|安静|elevator|accessible)/i.test(hay)) s += SCORING.hotel.elderly;
        if (prefs.hotelTier === 'luxury' && /(豪华|五星|resort|residence)/i.test(hay)) s += SCORING.hotel.luxuryTier;
        if (prefs.hotelTier === 'budget' && /(青旅|民宿|客栈|经济|hostel)/i.test(hay)) s += SCORING.hotel.budgetTier;
      } else if (type === 'restaurant') {
        if (prefs.cuisine) {
          const re = new RegExp(prefs.cuisine, 'i');
          if (re.test(hay)) s += SCORING.restaurant.cuisineMatch;
        }
        if (prefs.seaside && /(海|海景|beach|seafood|海鲜)/i.test(hay)) s += SCORING.restaurant.seaside;
      } else if (type === 'attraction') {
        if (prefs.activities) s += SCORING.attraction.activities; // 想看"有什么好玩的" → 把景点都前置
        if (prefs.seaside && /(海|滩|湾|岛|beach|coast|reef|dive|潜水|冲浪)/i.test(hay)) s += SCORING.attraction.seaside;
        if (prefs.kids && /(乐园|动物园|主题|family|amusement|zoo)/i.test(hay)) s += SCORING.attraction.kids;
        if (weather) {
          const t = poi.tags || [];
          if (t.includes('indoor')) {
            // 雨天/高温 → 室内景点优先
            if (weather.isRainyDay) s += SCORING.attraction.indoorRainy;
            if (weather.isHotDay) s += SCORING.attraction.indoorHot;
          } else if (t.includes('outdoor')) {
            if (weather.isRainyDay) s += SCORING.attraction.outdoorRainy;
            if (weather.isHotDay) s += SCORING.attraction.outdoorHot;
          }
          // 夜景/夜间专属：整体小幅前置（晚间分槽时进一步放大）
          if (t.includes('nightview')) s += SCORING.attraction.nightView;
          if (t.includes('eveningOnly')) s += SCORING.attraction.eveningOnly;
        }
      }
      return s;
    };

    const sortBy = (arr: RawPOI[], t: 'attraction' | 'hotel' | 'restaurant') =>
      [...arr].sort((a, b) => score(b, t) - score(a, t));

    return {
      attractions: sortBy(attractions, 'attraction'),
      hotels: sortBy(hotels, 'hotel'),
      restaurants: sortBy(restaurants, 'restaurant'),
    };
  }

  /**
   * 天气感知取数：拉取目的地当天/预报天气 → 时段化语境。
   * 失败时返回 null（按中性天气排程），绝不阻塞规划主流程。
   */
  private async fetchDestinationWeather(center: Coordinates, destName: string): Promise<TripWeatherCtx | null> {
    if (!this.weatherService) return null;
    try {
      const brief = await this.weatherService.getBrief(center.latitude, center.longitude, 'auto', destName);
      const ctx = this.buildWeatherContext(brief);
      console.log(
        `[PlanningService] 天气感知: ${destName} ${brief.summaryLine} | ` +
        `上午${ctx.morning.rainy ? '☔' : '☀'} 下午${ctx.afternoon.rainy ? '☔' : '☀'} 晚间${ctx.evening.rainy ? '☔' : '☀'} ` +
        `室内优先=${ctx.isRainyDay} 高温=${ctx.isHotDay}`
      );
      return ctx;
    } catch (err) {
      console.warn(`[PlanningService] 天气获取失败，按中性天气规划: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 将 Open-Meteo 逐小时预报折叠为 上午/下午/晚间 三时段天气语境 */
  private buildWeatherContext(brief: WeatherBrief): TripWeatherCtx {
    const slotCtx = (hours: number[]): SlotWeatherCtx => {
      const rows = brief.hourlyForecast.filter(f => {
        const h = parseInt((f.hour || f.time || '').split(':')[0] || '0', 10);
        return hours.includes(h);
      });
      const precipPct = rows.length ? Math.max(...rows.map(r => r.precipitationProbabilityPct ?? 0)) : 0;
      const maxTemp = rows.length ? Math.max(...rows.map(r => r.temperatureC ?? -999)) : -999;
      const hasRain = rows.some(r => RAIN_WEATHER_CODES.has(r.weatherCode));
      return { rainy: hasRain || precipPct >= 60, hot: maxTemp >= 32, cold: maxTemp <= 5, precipPct };
    };
    const morning = slotCtx([9, 10, 11, 12]);
    const afternoon = slotCtx([13, 14, 15, 16]);
    const evening = slotCtx([18, 19, 20, 21]);
    return {
      morning,
      afternoon,
      evening,
      isRainyDay: morning.rainy || afternoon.rainy,
      isHotDay: morning.hot || afternoon.hot,
      isColdDay: morning.cold || afternoon.cold,
      summary: brief.summaryLine,
    };
  }

  /**
   * 语义属性打标（B1）：根据 名称 + 原始 tags + 已有标签 推导 室内/室外/混合、夜景、夜间专属。
   * 幂等（已含目标标签则跳过），随缓存/内存复用，供天气×时段排序与分槽使用。
   */
  private enrichPoiAttributes(list: RawPOI[]): void {
    if (!list) return;
    for (const poi of list) {
      const existing = poi.tags || [];
      if (existing.includes('indoor') || existing.includes('outdoor') || existing.includes('mixed')) {
        continue; // 已打标，跳过
      }
      const rawTags = (poi.raw as { tags?: Record<string, unknown> } | undefined)?.tags;
      const hay = `${poi.name} ${existing.join(' ')} ${rawTags ? Object.values(rawTags).join(' ') : ''}`;

      // 室内（博物馆/水族馆/商场/展览/剧院/购物/温泉等）
      const indoorRe = /(博物馆|美术馆|科技馆|科学馆|水族馆|海洋馆|图书馆|展览|展馆|展厅|剧院|演出剧场|商场|购物中心|商城|购物|免税|室内|乐园室内|蜡像|纪念馆|艺术馆|画廊|电影院|影城|冰雪世界|水世界|温泉|水疗|spa|书店|密室|剧本杀|保龄球|健身房|室内冰场)/i;
      // 室外（公园/海滩/山/湖/塔/峡谷/瀑布/草原/森林/观景台等）
      const outdoorRe = /(公园|海滩|沙滩|海滨|海边|山|峰|湖|江|河|海景|塔|寺庙|古寺|大佛|峡谷|瀑布|草原|森林|湿地|观景台|观景|缆车|索道|动物园|植物园|户外|游乐场|过山车|漂流|潜水|冲浪|骑行|徒步|露营|景区|风景|岛|湾|沙滩浴场)/i;

      const tags = new Set<string>(existing);
      if (indoorRe.test(hay) && !outdoorRe.test(hay)) tags.add('indoor');
      else if (outdoorRe.test(hay) && !indoorRe.test(hay)) tags.add('outdoor');
      else tags.add('mixed');

      // 夜景/晚上适合（观景台/夜市/灯光秀/酒吧/摩天轮等）
      const nightRe = /(夜景|观景台|观景塔|夜市|灯光秀|灯光|灯会|烟花|烟花秀|酒吧|club|夜店|江景|海景餐厅|天台|露台|屋顶|夜游|游船|摩天轮|演出|演艺|show)/i;
      if (nightRe.test(hay)) tags.add('nightview');

      // 仅夜间开放（夜市/酒吧/夜店/夜间演出）
      const eveningOnlyRe = /(夜市|酒吧|夜店|club|夜间演出|夜场|灯会|烟花秀|夜游)/i;
      if (eveningOnlyRe.test(hay)) tags.add('eveningOnly');

      poi.tags = Array.from(tags);
    }
  }

  /** 单个景点在某时段天气下的适宜分（用于分槽贪心指派） */
  private slotScore(a: RawPOI, rainy: boolean, hot: boolean): number {
    const t = a.tags || [];
    if (t.includes('indoor')) return (rainy || hot) ? 3 : 1;
    if (t.includes('outdoor')) return rainy ? 0 : 2;
    return 1; // mixed / 未知 → 中性
  }

  /**
   * 按 天气×时段 拆分当天景点（B4）：
   * - eveningOnly / nightview → 晚间槽（夜景/夜市夜间游玩）
   * - 其余景点按上午/下午天气贪心指派（雨天/高温把室内放对应槽，晴天室外优先）
   * - 各槽内保持地理聚类原有顺序（不重排，减小路程）
   */
  private splitAttractionsBySlot(
    dayAttrs: RawPOI[],
    weather?: TripWeatherCtx | null
  ): { morning: RawPOI[]; afternoon: RawPOI[]; evening: RawPOI[] } {
    const evening: RawPOI[] = [];
    const rest: RawPOI[] = [];
    for (const a of dayAttrs) {
      const t = a.tags || [];
      if (t.includes('eveningOnly')) { evening.push(a); continue; }
      if (t.includes('nightview') && evening.length < 1) { evening.push(a); continue; }
      rest.push(a);
    }

    const n = rest.length;
    const morningCap = Math.ceil(n / 2);
    const morning: RawPOI[] = [];
    const afternoon: RawPOI[] = [];
    const mRain = weather?.morning.rainy ?? false;
    const mHot = weather?.morning.hot ?? false;
    const aRain = weather?.afternoon.rainy ?? false;
    const aHot = weather?.afternoon.hot ?? false;
    for (const a of rest) {
      if (morning.length >= morningCap) { afternoon.push(a); continue; }
      if (afternoon.length >= n - morningCap) { morning.push(a); continue; }
      (this.slotScore(a, aRain, aHot) > this.slotScore(a, mRain, mHot) ? afternoon : morning).push(a);
    }
    return { morning, afternoon, evening };
  }

  /** 生成"为何这样排"的天气/时段说明文案（B5，追加到条目贴士） */
  private slotNote(
    entry: { slot?: 'morning' | 'afternoon' | 'evening'; poi: RawPOI },
    weather: TripWeatherCtx | null | undefined,
    slot: 'morning' | 'afternoon' | 'evening'
  ): string {
    if (!weather) return '';
    const t = entry.poi.tags || [];
    const w = slot === 'morning' ? weather.morning : slot === 'evening' ? weather.evening : weather.afternoon;
    const notes: string[] = [];
    if (w.rainy && t.includes('indoor')) notes.push('今日有雨，已为您改排室内');
    if (slot === 'evening' && (t.includes('nightview') || t.includes('eveningOnly'))) notes.push('此景点适合傍晚/晚间前往，已安排在夜晚时段');
    if (weather.isHotDay && slot !== 'evening' && !t.includes('indoor')) notes.push('白天较热，注意防晒补水');
    if (w.rainy && !t.includes('indoor') && t.includes('outdoor')) notes.push('预计有雨，请备好雨具');
    return notes.join('；');
  }

  /**
   * 依据偏好生成行程标题，例如「巴厘岛7日游·海景泳池」
   */
  private buildTitle(destName: string, dayCount: number, prefs: TripPreferences): string {
    const base = `${destName}${dayCount}日游`;
    const tags: string[] = [];
    if (prefs.seaside) tags.push('海景');
    if (prefs.pool) tags.push('泳池');
    if (prefs.kids) tags.push('亲子');
    if (prefs.elderly) tags.push('适老');
    if (prefs.cuisine) tags.push(prefs.cuisine);
    if (prefs.hotelTier === 'luxury') tags.push('豪华');
    else if (prefs.hotelTier === 'budget') tags.push('经济');
    if (prefs.pace === 'relaxed') tags.push('休闲');
    else if (prefs.pace === 'intensive') tags.push('深度');
    return tags.length ? `${base}·${tags.join('/')}` : base;
  }

  /**
   * 将原始POI数据构建为每天的行程项目
   *
   * 改进点：
   * 1. 按地理位置聚类分配景点（而非按索引切片）
   * 2. 每天内用最近邻算法优化游览顺序（减少往返路程）
   * 3. 每天合理分配午餐/晚餐餐厅
   * 4. 根据实际交通时间动态安排时间点
   */

  // ======================== 两阶段优化：快速构建 + 并行图片 ========================

  /**
   * 阶段1：快速构建行程数据（不获取图片，纯数据操作，<100ms完成）
   * 图片/评论/视频在阶段2通过 collectMediaForDays 本地装配
   */
  private async buildDaysFast(
    dayCount: number,
    startDate: string,
    attractions: RawPOI[],
    hotels: RawPOI[],
    restaurants: RawPOI[],
    center: Coordinates,
    preferences: TripPreferences,
    travelInfo: TravelInfo,
    pricingCtx: import('./pricing-service.js').PricingContext,
    weather?: TripWeatherCtx | null
  ): Promise<{ days: PlannedDay[]; pois: POISummary[] }> {
    const allPois: POISummary[] = [];

    // A4：过滤非法坐标（(0,0)/非有限值/越界），避免把 POI 画到错误位置
    const isValidCoord = (p: RawPOI): boolean =>
      isFinite(p.latitude) && isFinite(p.longitude) &&
      !(p.latitude === 0 && p.longitude === 0) &&
      Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
    attractions = attractions.filter(isValidCoord);
    hotels = hotels.filter(isValidCoord);
    restaurants = restaurants.filter(isValidCoord);

    const toSummary = (poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): POISummary | null => {
      if (!isValidCoord(poi)) return null;
      return {
        id: poi.id, name: poi.name, type,
        latitude: poi.latitude, longitude: poi.longitude,
        address: poi.address, rating: poi.rating ?? 4.5,
        cost: poi.tags?.[0], description: poi.tags?.join(','),
        splatUrl: poi.splatUrl,
      };
    };
    attractions.forEach(a => { const s = toSummary(a, 'attraction'); if (s) allPois.push(s); });
    hotels.forEach(h => { const s = toSummary(h, 'hotel'); if (s) allPois.push(s); });
    restaurants.forEach(r => { const s = toSummary(r, 'restaurant'); if (s) allPois.push(s); });

    const paceCap: Record<TripPreferences['pace'], number> = { relaxed: 2, balanced: 3, intensive: 4 };
    let maxAttractionsPerDay = paceCap[preferences.pace];
    if (preferences.activities) maxAttractionsPerDay += 1;
    if (preferences.elderly) maxAttractionsPerDay = Math.max(2, maxAttractionsPerDay - 1);

    if (preferences.activityMix !== 'mixed') {
      const want = preferences.activityMix;
      attractions = [...attractions].sort((a, b) => {
        const tagA = `${a.name} ${(a.tags || []).join(' ')}`.toLowerCase();
        const tagB = `${b.name} ${(b.tags || []).join(' ')}`.toLowerCase();
        const score = (h: string) => {
          if (want === 'culture' && /(museum|church|temple|castle|monument|memorial|historic|寺庙|古迹|博物馆|文化)/.test(h)) return 2;
          if (want === 'nature' && /(park|garden|nature|mountain|volcano|beach|water|森林|山|湖|海|自然|风景|公园)/.test(h)) return 2;
          if (want === 'entertainment' && /(mall|amusement|theme_park|zoo|market|乐园|购物|娱乐)/.test(h)) return 2;
          return 0;
        };
        return score(tagB) - score(tagA);
      });
    }

    // 起点优先用酒店（第一天入住后出发、其余天从酒店往返），无酒店退回目的地中心
    const startPoint: Coordinates = hotels[0]
      ? { latitude: hotels[0]!.latitude, longitude: hotels[0]!.longitude }
      : center;

    // 地理聚类分配景点（farthest-first 初始化 + 空簇回收 + 每天内 NN+2-opt 排序）
    const clusteredDays = this.clusterAttractionsByGeo(attractions, dayCount, startPoint, maxAttractionsPerDay);
    const primaryHotel = hotels[0];
    // 餐厅去重：按名称去除重复
    const seenRestNames = new Set<string>();
    const dedupedRestaurants = restaurants.filter(r => {
      const key = (r.name || '').trim().toLowerCase();
      if (key && !seenRestNames.has(key)) { seenRestNames.add(key); return true; }
      return false;
    });
    const usedRestaurantIds = new Set<string>();
    const restaurantUsageCount = new Map<string, number>();

    /**
     * 第一步：确定每天访问序列（酒店→上午景点→午餐→下午景点→晚餐→晚间景点）。
     * 午/晚餐先按位置锚定（午餐靠上午最后景点、晚餐靠下午最后景点），时间后面统一排。
     * 景点拆分采用 天气×时段 槽位法（B4）：夜间专属/夜景→晚间，其余按上午/下午天气贪心指派。
     */
    interface DaySequence {
      date: string;
      hotel?: RawPOI;
      entries: Array<{ kind: 'attraction' | 'lunch' | 'dinner'; poi: RawPOI; slot?: 'morning' | 'afternoon' | 'evening' }>;
    }
    const sequences: DaySequence[] = [];
    for (let i = 0; i < dayCount; i++) {
      const date = new Date(new Date(startDate).getTime() + i * 86400000).toISOString().split('T')[0] ?? startDate;
      const dayAttrs = clusteredDays[i] || [];
      const { morning: morningAttrs, afternoon: afternoonAttrs, evening: eveningAttrs } = this.splitAttractionsBySlot(dayAttrs, weather);

      const entries: DaySequence['entries'] = [];
      for (const attr of morningAttrs) entries.push({ kind: 'attraction', poi: attr, slot: 'morning' });

      // 午餐：靠近上午最后一个景点（顺路用餐）；全为晚间景点时退回到酒店
      if (dedupedRestaurants.length > 0 && dayAttrs.length > 0) {
        const lunchRef = morningAttrs.length > 0
          ? morningAttrs[morningAttrs.length - 1]!
          : (afternoonAttrs.length > 0 ? afternoonAttrs[0]! : primaryHotel ?? null);
        if (lunchRef) {
          const lunchRest = this.pickRestaurantOnRoute(dedupedRestaurants, lunchRef.latitude, lunchRef.longitude, usedRestaurantIds, preferences, restaurantUsageCount);
          if (lunchRest) {
            usedRestaurantIds.add(lunchRest.id);
            restaurantUsageCount.set(lunchRest.id, (restaurantUsageCount.get(lunchRest.id) || 0) + 1);
            entries.push({ kind: 'lunch', poi: lunchRest });
          }
        }
      }

      for (const attr of afternoonAttrs) entries.push({ kind: 'attraction', poi: attr, slot: 'afternoon' });

      // 晚餐：靠近下午最后一个景点（顺路用餐）；无下午景点时退回上午最后景点
      if (dedupedRestaurants.length > 0) {
        const dinnerRef = afternoonAttrs.length > 0
          ? afternoonAttrs[afternoonAttrs.length - 1]!
          : (morningAttrs.length > 0 ? morningAttrs[morningAttrs.length - 1]! : primaryHotel ?? null);
        if (dinnerRef) {
          const dinnerRest = this.pickRestaurantOnRoute(dedupedRestaurants, dinnerRef.latitude, dinnerRef.longitude, usedRestaurantIds, preferences, restaurantUsageCount);
          if (dinnerRest) {
            usedRestaurantIds.add(dinnerRest.id);
            restaurantUsageCount.set(dinnerRest.id, (restaurantUsageCount.get(dinnerRest.id) || 0) + 1);
            entries.push({ kind: 'dinner', poi: dinnerRest });
          }
        }
      }

      // B4：晚间景点（夜景/夜市/夜间演出等）排到晚餐后，夜晚时段游览
      for (const attr of eveningAttrs) entries.push({ kind: 'attraction', poi: attr, slot: 'evening' });

      sequences.push({ date, hotel: primaryHotel, entries });
    }

    /**
     * 第二步：并行计算所有交通腿（OSRM 真实路网优先 + 缓存，失败降级 haversine）。
     * 先收集全部腿再一次并发发出，总耗时 ≈ 单次最慢请求（外网不可用时也只有一轮超时）。
     */
    const legMap = new Map<string, TransportLeg>();
    const pendingLegs: Array<{ key: string; fromLat: number; fromLon: number; toLat: number; toLon: number }> = [];
    sequences.forEach((seq, dayIdx) => {
      let prev: { lat: number; lon: number } | null = seq.hotel
        ? { lat: seq.hotel.latitude, lon: seq.hotel.longitude }
        : null;
      seq.entries.forEach((entry, e) => {
        if (prev) {
          pendingLegs.push({
            key: `${dayIdx}:${e}`,
            fromLat: prev.lat, fromLon: prev.lon,
            toLat: entry.poi.latitude, toLon: entry.poi.longitude,
          });
        }
        prev = { lat: entry.poi.latitude, lon: entry.poi.longitude };
      });
    });
    await Promise.all(pendingLegs.map(async (leg) => {
      legMap.set(leg.key, await this.transportLeg(leg.fromLat, leg.fromLon, leg.toLat, leg.toLon));
    }));

    const formatTime = (min: number) =>
      `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

    /**
     * 第三步：排时间。景点受当天预算约束（超出 DAY_END_MIN 的景点顺延丢弃，
     * 时钟不再绕回次日）；午/晚餐固定时段锚定。
     */
    const days: PlannedDay[] = [];
    for (let i = 0; i < dayCount; i++) {
      const seq = sequences[i]!;
      const items: ItineraryItem[] = [];
      let currentTimeMin = 9 * 60;
      let lastPoint: { lat: number; lon: number } | null = seq.hotel
        ? { lat: seq.hotel.latitude, lon: seq.hotel.longitude }
        : null;

      if (i === 0 && seq.hotel) {
        items.push(this.convertToItemSync(seq.hotel, 'hotel', seq.date, '08:00', preferences, travelInfo, pricingCtx));
        currentTimeMin = 9 * 60;
      }

      let dayFull = false;        // 当天预算已满：剩余景点丢弃，餐食保留
      let legsFallback = false;   // 丢弃景点后预计算腿的起点失效 → 改用 haversine 同步估算
      for (let e = 0; e < seq.entries.length; e++) {
        const entry = seq.entries[e]!;

        const legFor = (): TransportLeg | undefined => {
          if (!lastPoint) return undefined;
          if (legsFallback) return this.computeTransport(lastPoint.lat, lastPoint.lon, entry.poi.latitude, entry.poi.longitude);
          return legMap.get(`${i}:${e}`);
        };

        if (entry.kind === 'attraction') {
          if (dayFull) continue;
          const leg = legFor();
          const transportMin = lastPoint ? (leg?.durationMin ?? 0) : 0;
          const visitMin = this.inferVisitDuration('attraction', preferences);
          // 当天预算：装不下就丢掉该景点（之后所有景点同样丢弃），晚餐仍保留。
          // 晚间槽（夜景/夜市等）放宽上限至 22:30，保证夜间景点能排进去
          const dayEndMin = entry.slot === 'evening'
            ? PlanningService.DAY_END_MIN + 90
            : PlanningService.DAY_END_MIN;
          if (lastPoint && currentTimeMin + transportMin + visitMin > dayEndMin) {
            dayFull = true;
            legsFallback = true;
            continue;
          }
          const item = this.convertToItemSync(entry.poi, 'attraction', seq.date, formatTime(currentTimeMin), preferences, travelInfo, pricingCtx);
          // B5：追加"为何这样排"的天气/时段说明
          const slotNoteText = this.slotNote({ slot: entry.slot, poi: entry.poi }, weather, entry.slot ?? 'morning');
          if (slotNoteText) item.tips = [...(item.tips || []), slotNoteText];
          if (leg) item.transportFromPrev = leg;
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          currentTimeMin += transportMin + visitMin;
        } else if (entry.kind === 'lunch') {
          const lunchTime = Math.max(11 * 60, Math.min(13 * 60, currentTimeMin));
          const item = this.convertToItemSync(entry.poi, 'restaurant', seq.date, formatTime(lunchTime), preferences, travelInfo, pricingCtx);
          const leg = legFor();
          if (leg) item.transportFromPrev = leg;
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          currentTimeMin = lunchTime + 75;
        } else {
          const dinnerTime = Math.max(17.5 * 60, currentTimeMin + 30);
          const item = this.convertToItemSync(entry.poi, 'restaurant', seq.date, formatTime(dinnerTime), preferences, travelInfo, pricingCtx);
          const leg = legFor();
          if (leg) item.transportFromPrev = leg;
          items.push(item);
          lastPoint = { lat: entry.poi.latitude, lon: entry.poi.longitude };
          currentTimeMin = dinnerTime + 75;
        }
      }

      days.push({ date: seq.date, items });
    }

    return { days, pois: allPois };
  }

  /**
   * 选择距离参考点最近且未被使用的餐厅（顺路餐厅）
   * 综合评分 = 距离(60%) + 评分(25%) + 偏好匹配(15%)
   * 结合用户喜好（菜系/预算/海景）和网上推荐（评分/评价数）
   */
  private pickRestaurantOnRoute(
    restaurants: RawPOI[],
    refLat: number,
    refLon: number,
    usedIds: Set<string>,
    prefs: TripPreferences,
    usageCount?: Map<string, number>
  ): RawPOI | null {
    if (restaurants.length === 0) return null;

    let candidates = restaurants.filter(r => !usedIds.has(r.id));
    if (candidates.length === 0) {
      if (!usageCount || usageCount.size === 0) return null;
      let minUse = Infinity;
      for (const [, count] of usageCount) {
        if (count < minUse) minUse = count;
      }
      candidates = restaurants.filter(r => (usageCount.get(r.id) || 0) <= minUse);
      if (candidates.length === 0) candidates = restaurants;
    }

    let best = candidates[0] ?? null;
    let bestScore = -Infinity;
    for (const r of candidates) {
      const dist = this.haversineKm(refLat, refLon, r.latitude, r.longitude);
      const distScore = Math.max(0, SCORING.routePick.distanceBase - dist * SCORING.routePick.distanceScale);
      // 评分采用本地评论聚合分混合（无本地评论时退回默认口径）
      const blended = this.effectiveRating(r, 'restaurant');
      const ratingScore = (blended > 0 ? blended : SCORING.routePick.ratingFallback) * SCORING.routePick.ratingScale;
      let prefScore = 0;
      const hay = `${r.name} ${(r.tags || []).join(' ')}`.toLowerCase();
      if (prefs.cuisine) {
        const re = new RegExp(prefs.cuisine, 'i');
        if (re.test(hay)) prefScore += SCORING.routePick.cuisineMatch;
      }
      if (prefs.seaside && /(海|海景|beach|seafood|海鲜)/i.test(hay)) prefScore += SCORING.routePick.seasideMatch;
      if (prefs.budget === 'low' && /(小吃|快餐|平价|local|经济)/i.test(hay)) prefScore += SCORING.routePick.budgetMatch;
      if (prefs.budget === 'high' && /(精致|高档|fine|dining|luxury)/i.test(hay)) prefScore += SCORING.routePick.budgetMatch;

      const usePenalty = (usageCount?.get(r.id) || 0) * SCORING.routePick.reusePenalty;
      const totalScore =
        distScore * SCORING.routePick.distanceWeight + ratingScore * SCORING.routePick.ratingWeight + prefScore - usePenalty;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        best = r;
      }
    }
    return best;
  }

  /**
   * 阶段2（请求路径内）：媒体装配 —— 纯本地读，不发任何网络请求。
   *
   * 取图优先级：媒体库本地上传/精选图 > POI 缓存中已落盘的回填图（wikimedia）。
   * 两级都未命中的 POI 进入 missing 列表，交由 backfillMediaBackground 离线回填。
   * 同时从媒体库带出评论（最新3条）与视频（≤5条）供行程卡片直读。
   */
  private collectMediaForDays(
    days: PlannedDay[],
    entry: CacheEntry | null,
  ): {
    imageMap: Map<string, string[]>;
    mediaMeta: Map<string, PoiMediaMeta>;
    missing: Array<{ poiId?: string; type: ItineraryItem['type']; name: string; latitude: number; longitude: number }>;
  } {
    // 收集所有唯一 POI（含坐标，去重）
    const poiSet = new Map<string, {
      poiId?: string;
      type: ItineraryItem['type'];
      name: string;
      lat: number;
      lon: number;
    }>();
    for (const day of days) {
      for (const item of day.items) {
        const key = `${item.type}-${item.itemId}`;
        if (!poiSet.has(key)) {
          poiSet.set(key, {
            poiId: item.poiId,
            type: item.type,
            name: item.name,
            lat: item.latitude,
            lon: item.longitude,
          });
        }
      }
    }

    const imageMap = new Map<string, string[]>();
    const mediaMeta = new Map<string, PoiMediaMeta>();
    const missing: Array<{ poiId?: string; type: ItineraryItem['type']; name: string; latitude: number; longitude: number }> = [];

    for (const [key, info] of poiSet) {
      // 1. 媒体库：本地上传/精选优先，其次历史回填图
      let images = travelMediaStore.imageUrls(info.type, info.name, 'user');
      if (images.length === 0) images = travelMediaStore.imageUrls(info.type, info.name, 'wikimedia');
      // 2. POI 缓存中已落盘的回填图（旧数据兜底）
      if (images.length === 0 && info.poiId) {
        images = this.findCachedPOIImages(entry, info.type, info.poiId);
      }

      // 评论/视频元数据（有才挂）
      const agg = travelMediaStore.aggregate(info.type, info.name);
      if (agg && (agg.reviewCount > 0 || agg.videoCount > 0)) {
        const mediaEntry = travelMediaStore.get(info.type, info.name);
        mediaMeta.set(key, {
          reviewCount: agg.reviewCount,
          reviews: (mediaEntry?.reviews ?? [])
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 3)
            .map((r) => ({ author: r.author, rating: r.rating, text: r.text, createdAt: r.createdAt })),
          videos: (mediaEntry?.videos ?? []).slice(0, 5).map((v) => ({
            platform: v.platform,
            title: v.title,
            author: v.author,
            durationSeconds: v.durationSeconds,
            thumbnailUrl: v.thumbnailUrl,
            playPageUrl: v.playPageUrl,
          })),
        });
      }

      if (images.length > 0) {
        imageMap.set(key, images);
      } else {
        missing.push({
          poiId: info.poiId,
          type: info.type,
          name: info.name,
          latitude: info.lat,
          longitude: info.lon,
        });
      }
    }

    console.log(`[PlanningService] 媒体装配(本地直读): ${imageMap.size}/${poiSet.size} 个POI有图, ${mediaMeta.size} 个POI带评论/视频`);
    return { imageMap, mediaMeta, missing };
  }

  /** 自动回填开关：TRAVEL_MEDIA_BACKFILL=off 时只走管理员手动触发/本地上传 */
  private static readonly AUTO_BACKFILL_ENABLED =
    (process.env.TRAVEL_MEDIA_BACKFILL ?? 'on').toLowerCase() !== 'off';

  /**
   * 管理端手动回填：对单个 POI 抓一次 Wikimedia 图片并写入媒体库。
   * 供 /travel/media/backfill 接口调用（自动回填关闭时的替代路径）。
   */
  async backfillMediaForPoi(
    name: string,
    type: ItineraryItem['type'],
    latitude?: number,
    longitude?: number,
  ): Promise<string[]> {
    const images = await this.fetchSingleWithRetry(name, type, latitude, longitude);
    if (images.length > 0 && latitude !== undefined && longitude !== undefined) {
      travelMediaStore.attachBackfilledImages(type, name, images, { latitude, longitude });
    } else if (images.length > 0) {
      travelMediaStore.attachBackfilledImages(type, name, images);
    }
    return images;
  }

  /**
   * 阶段2.5（后台，不阻塞请求）：缺图 POI 的离线回填。
   * Wikimedia 抓取（复用原有校验链）成功后同时写入媒体库与 POI 缓存，
   * 下次规划请求路径内直接命中。同目的地同时只跑一轮（并发 3）。
   */
  private backfillInFlight = new Set<string>();
  private backfillMediaBackground(
    missing: Array<{ poiId?: string; type: ItineraryItem['type']; name: string; latitude: number; longitude: number }>,
    entry: CacheEntry | null,
  ): void {
    const tag = entry?.destination ?? 'unknown';
    if (this.backfillInFlight.has(tag)) {
      console.log(`[PlanningService] 后台媒体回填进行中，跳过本次: ${tag}`);
      return;
    }
    this.backfillInFlight.add(tag);
    console.log(`[PlanningService] 后台媒体回填启动: ${tag}，${missing.length} 个POI（不阻塞当前请求）`);

    void (async () => {
      const CONCURRENCY = 3;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor++;
          if (idx >= missing.length) return;
          const info = missing[idx]!;
          try {
            const images = await this.fetchSingleWithRetry(info.name, info.type, info.latitude, info.longitude);
            if (images.length > 0) {
              travelMediaStore.attachBackfilledImages(info.type, info.name, images, {
                latitude: info.latitude,
                longitude: info.longitude,
              });
              // 同步写回 POI 缓存（请求路径内的旧数据兜底层）
              if (entry && info.poiId) {
                poiCache.updatePOIImages(entry.destination, info.type, info.poiId, images);
              }
            }
          } catch { /* 单点失败不影响整体 */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));
      console.log(`[PlanningService] 后台媒体回填完成: ${tag}`);
    })().finally(() => this.backfillInFlight.delete(tag));
  }

  /**
   * 单 POI 图片抓取：失败自动重试 1 次（300ms 起指数退避）
   * 仅由后台回填调用，不再出现在请求路径上。
   */
  private async fetchSingleWithRetry(
    poiName: string,
    type: string,
    lat?: number,
    lon?: number,
  ): Promise<string[]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const images = await this.fetchRealImages(poiName, type, lat, lon);
        if (images.length > 0) return images;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }
    // 第二次结果若无图也返回空，交由上层跳过；网络失败则抛出
    if (lastErr !== undefined) throw lastErr;
    return [];
  }

  /**
   * 从 POI 缓存条目中取出某 POI 已落盘的图片
   */
  private findCachedPOIImages(
    entry: CacheEntry | null,
    type: ItineraryItem['type'],
    poiId?: string,
  ): string[] {
    if (!entry || !poiId) return [];
    const listKey = `${type}s` as keyof CacheEntry['data'];
    const list = entry.data[listKey];
    if (!list) return [];
    return list.find((p) => p.id === poiId)?.images ?? [];
  }

  /**
   * 将本地媒体装配回行程数据：图片 + 评论（最新3条）+ 视频 + 评论数
   */
  private enrichDaysWithMedia(
    daysRaw: PlannedDay[],
    imageMap: Map<string, string[]>,
    mediaMeta: Map<string, PoiMediaMeta>,
  ): PlannedDay[] {
    return daysRaw.map(day => ({
      ...day,
      items: day.items.map(item => {
        const key = `${item.type}-${item.itemId}`;
        const images = imageMap.get(key);
        const meta = mediaMeta.get(key);
        if ((!images || images.length === 0) && !meta) return item;
        return {
          ...item,
          images: images && images.length > 0 ? images : item.images,
          reviewCount: meta ? meta.reviewCount : item.reviewCount,
          reviews: meta && meta.reviews.length > 0 ? meta.reviews : item.reviews,
          videos: meta && meta.videos.length > 0 ? meta.videos : item.videos,
        };
      }),
    }));
  }

  /**
   * 同步版本 convertToItem（纯数据构建）
   * 图片/评论/视频在阶段2通过 collectMediaForDays 本地装配
   */
  private convertToItemSync(
    poi: RawPOI,
    type: ItineraryItem['type'],
    date: string,
    time: string,
    preferences: TripPreferences,
    travelInfo: TravelInfo,
    pricingCtx: import('./pricing-service.js').PricingContext
  ): ItineraryItem {
    const startTime = `${date}T${time}:00`;
    const images: string[] = []; // 图片留空，阶段2并行填充

    const visitMin = this.inferVisitDuration(type, preferences);
    const [hh, mm] = time.split(':').map(n => parseInt(n, 10));
    const endTotalMin = (hh ?? 0) * 60 + (mm ?? 0) + visitMin;
    const endTime = `${date}T${String(Math.floor(endTotalMin / 60) % 24).padStart(2, '0')}:${String(endTotalMin % 60).padStart(2, '0')}:00`;

    let priceQuote: PriceQuote;
    if (type === 'hotel') priceQuote = pricingService.quoteHotel(poi.name, poi.tags || [], pricingCtx);
    else if (type === 'attraction') priceQuote = pricingService.quoteAttraction(poi.name, poi.tags || [], pricingCtx);
    else priceQuote = pricingService.quoteRestaurant(poi.name, poi.tags || [], pricingCtx);

    const priceInfo = this._formatPriceInfo(priceQuote);

    const baseItem: ItineraryItem = {
      itemId: `${type}-${poi.id}-${Date.now()}`,
      poiId: poi.id,
      type,
      name: poi.name,
      description: this.generateDescription(poi, type, preferences),
      startTime,
      endTime,
      visitDuration: visitMin,
      tips: this.generateItemTips(poi, type, preferences, travelInfo),
      bookingNote: this.generateBookingNote(poi, type, preferences),
      latitude: poi.latitude,
      longitude: poi.longitude,
      rating: poi.rating || 0,
      priceInfo,
      address: poi.address || `${poi.name}地址`,
      phone: (() => { const t = (poi.raw?.tags) as Record<string,string>|undefined; return t?.['phone'] || t?.['contact:phone'] || t?.['telephone'] || '暂无公开电话'; })(),
      openingHours: (() => {
        const osmHours = (poi.raw?.tags as Record<string,string>|undefined)?.['opening_hours'];
        if (osmHours) return osmHours;
        return type === 'hotel' ? '24小时前台 · 14:00入住 12:00退房' :
               type === 'attraction' ? '开放时间请以现场公示为准' : '开放时间请以现场公示为准';
      })(),
      tags: this.generateTags(type, poi.rating || 0, preferences),
      reviewCount: 0,
      images,
      videos: [],
      reviews: [],
      splatUrl: poi.splatUrl,
      priceQuote,
    };

    if (type === 'hotel') {
      baseItem.pricePerNight = priceQuote.finalPrice;
      baseItem.starRating = (poi.rating && poi.rating > 0) ? Math.min(5, Math.max(1, Math.round(poi.rating))) : undefined;
      const amenitySet = new Set<string>(['WiFi', '空调', '独立卫浴']);
      const osmAmenities = (poi.raw?.tags) as Record<string,string> | undefined;
      if (osmAmenities) {
        if (osmAmenities['swimming_pool']) amenitySet.add('泳池');
        if (osmAmenities['wifi'] || osmAmenities?.['internet_access']) amenitySet.add('WiFi');
        if (osmAmenities['parking']) amenitySet.add('停车场');
        if (osmAmenities['restaurant']) amenitySet.add('餐厅');
        if (osmAmenities['air_conditioning']) amenitySet.add('空调');
      }
      if (preferences.seaside) amenitySet.add('海景房');
      if (preferences.pool) amenitySet.add('泳池');
      if (preferences.kids) amenitySet.add('亲子设施');
      if (preferences.elderly) amenitySet.add('无障碍');
      const amenities = Array.from(amenitySet);
      baseItem.rooms = [
        { name: '标准间', pricePerNight: priceQuote.finalPrice, capacity: 2, amenities, image: '' },
        { name: '豪华房', pricePerNight: Math.round(priceQuote.finalPrice * 1.4), capacity: 2, amenities: [...amenities, '观景窗'], image: '' },
      ];
    } else if (type === 'attraction') {
      baseItem.ticketPrice = priceQuote.finalPrice;
      baseItem.category = this.inferCategory(poi.tags || [], preferences);
    } else if (type === 'restaurant') {
      baseItem.avgPrice = priceQuote.finalPrice;
      baseItem.priceLevel = baseItem.avgPrice < 50 ? 1 : baseItem.avgPrice < 100 ? 2 : 3;
      baseItem.cuisine = preferences.cuisine || this.inferCuisine(poi.tags || [], poi.name);
      baseItem.menuItems = [
        { name: '招牌推荐', price: priceQuote.finalPrice, desc: '招牌菜品', image: '', isSignature: true, tag: '招牌' },
        { name: '经典菜', price: Math.round(priceQuote.finalPrice * 0.7), desc: '经典做法', image: '', isSignature: true, tag: '必点' },
      ];
    }

    return baseItem;
  }

  /**
   * 按地理位置将景点聚类到各天，并在每天内优化游览顺序
   *
   * 算法：
   * 1. K-means 聚类：将景点按位置分到 N 天（N=dayCount）
   * 2. 每天内最近邻排序：从酒店/中心出发，每次选最近的下一个点
   */
  private clusterAttractionsByGeo(
    attractions: RawPOI[],
    dayCount: number,
    startPoint: Coordinates,
    maxPerDay: number
  ): RawPOI[][] {
    // 去重：按名称（忽略大小写/空格）去除重复景点
    const seenNames = new Set<string>();
    const deduped: RawPOI[] = [];
    for (const a of attractions) {
      const key = (a.name || '').trim().toLowerCase();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        deduped.push(a);
      }
    }
    attractions = deduped;

    if (attractions.length === 0) return Array.from({ length: dayCount }, () => []);

    const result: RawPOI[][] = Array.from({ length: dayCount }, () => []);

    // 如果景点少于天数：按距起点远近顺序逐日分配（避免全堆在第一天）
    if (attractions.length <= dayCount) {
      const sorted = [...attractions].sort((a, b) =>
        this.haversineKm(startPoint.latitude, startPoint.longitude, a.latitude, a.longitude) -
        this.haversineKm(startPoint.latitude, startPoint.longitude, b.latitude, b.longitude));
      sorted.forEach((attr, idx) => {
        result[idx % dayCount]?.push(attr);
      });
      this.reorderDays(result, dayCount, startPoint, maxPerDay);
      return result;
    }

    // ===== Step 1: farthest-first 初始化聚类中心（确定性与散布性兼顾）=====
    // 首个中心取距起点最近的景点；其后每轮选「距已有中心最小距离最大」的点，
    // 避免旧网格初始化（经度只按 i%3 摆 3 列）在天数>3 时中心重叠、聚出空簇。
    const centroids: Array<{ lat: number; lon: number }> = [];
    {
      const first = attractions.reduce((best, a) => {
        const d = this.haversineKm(startPoint.latitude, startPoint.longitude, a.latitude, a.longitude);
        const bd = this.haversineKm(startPoint.latitude, startPoint.longitude, best.latitude, best.longitude);
        return d < bd ? a : best;
      }, attractions[0]!);
      centroids.push({ lat: first.latitude, lon: first.longitude });
      while (centroids.length < dayCount) {
        let far = attractions[0]!;
        let farDist = -1;
        for (const a of attractions) {
          const minD = Math.min(...centroids.map(c => this.haversineKm(a.latitude, a.longitude, c.lat, c.lon)));
          if (minD > farDist) {
            farDist = minD;
            far = a;
          }
        }
        centroids.push({ lat: far.latitude, lon: far.longitude });
      }
    }

    // ===== Step 2: K-means 迭代（最多10轮）=====
    const clusters: number[] = new Array(attractions.length).fill(0);

    for (let iter = 0; iter < 10; iter++) {
      // 分配每个点到最近的中心
      let changed = false;
      for (let i = 0; i < attractions.length; i++) {
        const a = attractions[i]!;
        let bestCluster = 0;
        let bestDist = Infinity;
        for (let c = 0; c < dayCount; c++) {
          const dist = this.haversineKm(a.latitude, a.longitude, centroids[c]!.lat, centroids[c]!.lon);
          if (dist < bestDist) {
            bestDist = dist;
            bestCluster = c;
          }
        }
        if (clusters[i] !== bestCluster) {
          clusters[i] = bestCluster;
          changed = true;
        }
      }

      // 更新聚类中心
      for (let c = 0; c < dayCount; c++) {
        const members = attractions.filter((_, i) => clusters[i] === c);
        if (members.length > 0) {
          centroids[c] = {
            lat: members.reduce((s, m) => s + m.latitude, 0) / members.length,
            lon: members.reduce((s, m) => s + m.longitude, 0) / members.length,
          };
        }
      }

      if (!changed) break; // 收敛
    }

    // ===== Step 3: 将聚类结果分配到每天 =====
    for (let i = 0; i < attractions.length; i++) {
      const cluster = clusters[i] ?? 0;
      result[cluster]?.push(attractions[i]!);
    }

    // ===== Step 3.5: 空簇回收：从最大簇借走离空簇中心最近的点 =====
    for (let c = 0; c < dayCount; c++) {
      if ((result[c]?.length ?? 0) > 0) continue;
      let biggest = -1;
      let biggestLen = 1;
      for (let d = 0; d < dayCount; d++) {
        if ((result[d]?.length ?? 0) > biggestLen) {
          biggestLen = result[d]!.length;
          biggest = d;
        }
      }
      if (biggest < 0) break;
      let stealIdx = -1;
      let stealDist = Infinity;
      for (let j = 0; j < result[biggest]!.length; j++) {
        const p = result[biggest]![j]!;
        const d = this.haversineKm(p.latitude, p.longitude, centroids[c]!.lat, centroids[c]!.lon);
        if (d < stealDist) {
          stealDist = d;
          stealIdx = j;
        }
      }
      if (stealIdx >= 0) {
        result[c]!.push(result[biggest]!.splice(stealIdx, 1)[0]!);
      }
    }

    // ===== Step 4: 每天内按最近邻 + 2-opt 优化顺序 =====
    this.reorderDays(result, dayCount, startPoint, maxPerDay);

    // 处理未被分配的景点（被 maxPerDay 截断的，重新分配到有空位的日期）
    // 用 ID 集合追踪已分配的景点，避免重复添加
    const assignedIds = new Set<string>();
    for (let d = 0; d < dayCount; d++) {
      for (const poi of result[d] ?? []) {
        if (poi.id) assignedIds.add(poi.id);
      }
    }
    const unassigned = attractions.filter(a => !assignedIds.has(a.id));
    const touchedDays = new Set<number>();
    unassigned.forEach((attr) => {
      // 找有空位且距离该景点最近的日期加入
      let bestDay = -1;
      let bestDist = Infinity;
      for (let d = 0; d < dayCount; d++) {
        if ((result[d]?.length ?? 0) >= maxPerDay) continue;
        const dayPois = result[d] ?? [];
        if (dayPois.length === 0) {
          bestDay = d;
          break;
        }
        // 计算到该日期已有景点的最近距离
        const minDist = Math.min(...dayPois.map(p => this.haversineKm(p.latitude, p.longitude, attr.latitude, attr.longitude)));
        if (minDist < bestDist) {
          bestDist = minDist;
          bestDay = d;
        }
      }
      if (bestDay >= 0) {
        result[bestDay]!.push(attr);
        touchedDays.add(bestDay);
      }
    });

    // 补位后受影响的天重跑排序（否则补进去的点会破坏最优邻接序）
    if (touchedDays.size > 0) {
      this.reorderDays(result, dayCount, startPoint, maxPerDay);
    }

    console.log(`[PlanningService] 地理聚类完成: ${result.map((d, i) => `Day${i+1}:${d.length}个景点`).join(', ')}`);
    return result;
  }

  /**
   * 每天内排序：从起点最近邻出发，再做 2-opt 改进（开放式路径，消除交叉），
   * 最后截断到 maxPerDay。天数少、点少，2-opt 全量扫描代价可忽略。
   */
  private reorderDays(
    result: RawPOI[][],
    dayCount: number,
    startPoint: Coordinates,
    maxPerDay: number,
  ): void {
    const pathLen = (arr: RawPOI[]): number => {
      let s = 0;
      let prev: Coordinates = startPoint;
      for (const p of arr) {
        s += this.haversineKm(prev.latitude, prev.longitude, p.latitude, p.longitude);
        prev = { latitude: p.latitude, longitude: p.longitude };
      }
      return s;
    };

    for (let d = 0; d < dayCount; d++) {
      const dayPois = result[d]!;
      if (dayPois.length <= 1) continue;

      // 最近邻：从起点出发
      const ordered: RawPOI[] = [];
      const visited = new Set<number>();
      let current: Coordinates = startPoint;
      for (let count = 0; count < dayPois.length; count++) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let j = 0; j < dayPois.length; j++) {
          if (visited.has(j)) continue;
          const dist = this.haversineKm(current.latitude, current.longitude, dayPois[j]!.latitude, dayPois[j]!.longitude);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = j;
          }
        }
        if (bestIdx >= 0) {
          visited.add(bestIdx);
          const chosen = dayPois[bestIdx]!;
          ordered.push(chosen);
          current = { latitude: chosen.latitude, longitude: chosen.longitude };
        }
      }

      // 2-opt 改进：若反转某段能缩短路径则采纳（有守卫上限，防极端退化）
      let improved = true;
      let guard = 0;
      while (improved && guard++ < 20) {
        improved = false;
        const base = pathLen(ordered);
        for (let i = 0; i < ordered.length - 1; i++) {
          for (let k = i + 1; k < ordered.length; k++) {
            const cand = [...ordered.slice(0, i), ...ordered.slice(i, k + 1).reverse(), ...ordered.slice(k + 1)];
            if (pathLen(cand) < base - 1e-9) {
              ordered.length = 0;
              ordered.push(...cand);
              improved = true;
              break;
            }
          }
          if (improved) break;
        }
      }

      result[d] = ordered.slice(0, maxPerDay); // 限制每天最大数量
    }
  }

  /**
   * 格式化价格显示文本
   *  - 优惠时：¥实付 (原价¥xx · 优惠yy)
   *  - 无优惠：¥原价
   *  - 免费：免费
   */
  private _formatPriceInfo(q: PriceQuote): string {
    return formatQuotePriceInfo(q);
  }

  // ======================== 辅助方法 ========================

  private generateImages(type: string, poiName: string, lat?: number, lon?: number): Promise<string[]> {
    return this.fetchRealImages(poiName, type, lat, lon);
  }

  /**
   * 获取 POI 的真实图片（多重地理+名称校验，确保图片对应真实地点）
   *
   * 三阶段策略（从最准确到兜底）：
   * 1. **Wikimedia geosearch**：在 POI 坐标 1km 范围内搜索带图片的 Wiki 实体
   *    → 准确度最高（按地理位置过滤）
   * 2. **Wikimedia 文本搜索 + 名称匹配**：搜 "POI名 + 城市" 再校验图片元数据
   *    → 兜底策略，确保热门 POI 也能找到
   * 3. **过滤规则**：
   *    - 最小尺寸 640x480（排除图标/标记/小图）
   *    - 文件名黑名单：map、icon、logo、flag、pin、marker、symbol、svg
   *    - 名称白名单：必须包含 POI 名关键词（中文或英文/拼音）
   *    - GPS 校验（如有 EXIF GPS，必须在 POI 50km 范围内）
   */
  private async fetchRealImages(poiName: string, type: string, lat?: number, lon?: number): Promise<string[]> {
    if (!poiName) return [];

    // 文件名黑名单：排除地图、图标、标记等不相关图片
    const BLOCKED_PATTERNS = [
      /map/i, /icon/i, /logo/i, /flag/i, /\bpin\b/i, /marker/i, /symbol/i,
      /svg$/i, /sign/i, /coat[_-]?of[_-]?arms/i, /pictogram/i, /emblem/i,
      /blank[_-]?flag/i, /no[_-]?image/i, /placeholder/i, /locator/i,
    ];
    const MIN_WIDTH = 640;
    const MIN_HEIGHT = 480;
    const MAX_RADIUS_KM = 50; // GPS 校验半径
    const poiNameClean = poiName.replace(/[()（）·•・]/g, '').trim();

    const isBlocked = (filename: string): boolean =>
      BLOCKED_PATTERNS.some(p => p.test(filename));

    /**
     * 计算字符串相似度（基于字符集合重合度）
     */
    const similarity = (a: string, b: string): number => {
      if (!a || !b) return 0;
      const setA = new Set(a.toLowerCase().replace(/\s+/g, ''));
      const setB = new Set(b.toLowerCase().replace(/\s+/g, ''));
      let intersect = 0;
      setA.forEach(c => { if (setB.has(c)) intersect++; });
      return intersect / Math.max(setA.size, setB.size);
    };

    /**
     * 从图片信息中提取名称关键词
     */
    const extractNameFromTitle = (title: string): string => {
      return title
        .replace(/^File:/i, '')
        .replace(/\.(jpg|jpeg|png|webp|gif|svg)$/i, '')
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    /**
     * 校验图片元数据是否符合 POI
     */
    const validateImage = (imageinfo: any, fileTitle: string): boolean => {
      const filename = fileTitle.replace(/^File:/i, '');

      // 1. 名称黑名单
      if (isBlocked(filename)) return false;

      // 2. 尺寸过滤
      const w = imageinfo?.width || 0;
      const h = imageinfo?.height || 0;
      if (w > 0 && h > 0 && (w < MIN_WIDTH || h < MIN_HEIGHT)) return false;

      // 3. 名称相似度（至少 30% 字符重合）
      const nameInTitle = extractNameFromTitle(fileTitle);
      const sim = similarity(poiNameClean, nameInTitle);
      if (sim < 0.3) return false;

      // 4. EXIF GPS 校验（如有，必须在 50km 内）
      if (lat !== undefined && lon !== undefined && imageinfo?.metadata) {
        const meta = Array.isArray(imageinfo.metadata) ? imageinfo.metadata : [];
        // Wikimedia 返回的 metadata 数组里可能包含 GPS 字段
        const gpsLat = parseFloat(String(meta.find((m: any) => m?.name === 'GPSLatitude')?.value || 'NaN'));
        const gpsLon = parseFloat(String(meta.find((m: any) => m?.name === 'GPSLongitude')?.value || 'NaN'));
        if (!isNaN(gpsLat) && !isNaN(gpsLon)) {
          const dist = this.haversineKm(lat, lon, gpsLat, gpsLon);
          if (dist > MAX_RADIUS_KM) {
            console.log(`[ImageFilter] 拒绝: ${filename} (GPS距离${dist.toFixed(1)}km超限)`);
            return false;
          }
        }
      }

      return true;
    };

    try {
      // ===== 阶段1：Wikimedia geosearch（按坐标）=====
      if (lat !== undefined && lon !== undefined) {
        const geoResults = await this.wikimediaGeosearch(poiName, lat, lon, 1500);
        if (geoResults.length > 0) {
          console.log(`[ImageSearch] ${poiName}: geosearch命中${geoResults.length}个实体`);
          const validImages = await this.fetchImageUrlsByTitles(geoResults, validateImage);
          if (validImages.length >= 2) return validImages;
          // 不够则继续尝试
          if (validImages.length === 1) {
            const stage2 = await this.wikimediaTextSearch(poiName, lat, lon, validateImage);
            return [...validImages, ...stage2].slice(0, 4);
          }
        }
      }

      // ===== 阶段2：Wikimedia 文本搜索 + 坐标校验 =====
      const textResults = await this.wikimediaTextSearch(poiName, lat, lon, validateImage);
      if (textResults.length > 0) return textResults;

      // 阶段3 全部失败，返回空数组（前端将回退到地标通用图）
      console.log(`[ImageSearch] ${poiName}: 未找到匹配的真实图片`);
      return [];
    } catch (err) {
      console.warn(`[ImageSearch] ${poiName} 失败:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Wikimedia 地理搜索：返回指定坐标 1.5km 范围内的所有 Wiki 条目标题
   */
  private async wikimediaGeosearch(poiName: string, lat: number, lon: number, radiusMeters: number = 1500): Promise<string[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=${radiusMeters}&gslimit=10&format=json&origin=*`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { query?: { geosearch?: Array<{ title: string }> } };
      return (data.query?.geosearch || []).map(g => g.title);
    } catch { return []; }
  }

  /**
   * Wikimedia 文本搜索：搜索 "POI名"，返回匹配的图片文件名
   */
  private async wikimediaTextSearch(poiName: string, lat?: number, lon?: number, validate?: (img: any, title: string) => boolean): Promise<string[]> {
    const query = encodeURIComponent(poiName);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${query}&srnamespace=6&srlimit=20&format=json&origin=*`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { query?: { search?: Array<{ title: string }> } };
      const titles = (data.query?.search || []).map(s => s.title);
      return await this.fetchImageUrlsByTitles(titles, validate);
    } catch { return []; }
  }

  /**
   * 批量获取多个文件名的真实图片URL（带尺寸+元数据过滤）
   */
  private async fetchImageUrlsByTitles(titles: string[], validate?: (img: any, title: string) => boolean): Promise<string[]> {
    if (titles.length === 0) return [];
    const validUrl = validate || (() => true);

    // Wikimedia API 一次最多50个 title
    const chunks: string[][] = [];
    for (let i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));

    const imageUrls: string[] = [];
    for (const chunk of chunks) {
      const params = new URLSearchParams({
        action: 'query',
        titles: chunk.join('|'),
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: '1200',
        format: 'json',
        origin: '*',
      });
      const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) continue;
        const data = await res.json() as {
          query?: { pages?: Record<string, { title: string; imageinfo?: Array<any> }> }
        };
        const pages = data.query?.pages || {};
        for (const pageId in pages) {
          const page = pages[pageId];
          if (!page?.imageinfo?.[0]) continue;
          const info = page.imageinfo[0];
          const thumbUrl = info.thumburl || info.url;
          if (!thumbUrl) continue;
          if (validUrl(info, page.title)) {
            imageUrls.push(thumbUrl);
            if (imageUrls.length >= 5) return imageUrls;
          }
        }
      } catch (err) {
        console.warn(`[ImageSearch] 批量获取失败:`, err instanceof Error ? err.message : err);
      }
    }
    return imageUrls;
  }

  private generateDescription(poi: Pick<RawPOI, 'name'> & Partial<Pick<RawPOI, 'tags' | 'rating' | 'address'>>, type: string, prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string {
    const tags = poi.tags || [];
    const tagStr = tags.slice(0, 3).join('、');

    // 防御：如果 poi.name 异常长（> 25字，可能包含用户输入）则截断显示
    const safeName = poi.name && poi.name.length <= 25
      ? poi.name
      : (poi.name ? poi.name.slice(0, 20) + '...' : '该地点');

    switch (type) {
      case 'attraction': {
        const base = `${safeName}是当地热门景点${tagStr ? `，属于${tagStr}类别` : ''}，风景优美，值得专程前往游览。`;
        if (prefs.activities) return `${base}本次行程优先为你安排体验型游玩项目，建议预留充足时间。`;
        return base;
      }
      case 'hotel': {
        const notes: string[] = [];
        if (prefs.seaside) notes.push('近海/海景');
        if (prefs.pool) notes.push('自带泳池');
        if (prefs.kids) notes.push('亲子设施齐全');
        if (prefs.elderly) notes.push('无障碍/安静');
        const noteStr = notes.length ? `，匹配你提到的${notes.join('、')}` : '';
        return `${safeName}位置便利，设施齐全${noteStr}，是当地受欢迎的住宿选择。`;
      }
      case 'restaurant': {
        const cuisine = prefs.cuisine ? `主打${prefs.cuisine}` : '本地风味';
        return `${safeName}是当地知名美食地点，${cuisine}，深受食客喜爱。`;
      }
      default:
        return `${safeName}，值得一去的好地方。`;
    }
  }

  private generateTags(type: string, rating: number, prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string[] {
    const tags: string[] = [];
    if (type === 'attraction') {
      tags.push('热门景点', '必打卡');
      if (prefs.activities) tags.push('游玩项目');
      if (prefs.seaside) tags.push('海景相关');
      if (prefs.kids) tags.push('亲子推荐');
      if (rating >= 4.6) tags.push('高评分推荐');
    } else if (type === 'hotel') {
      tags.push('优质住宿');
      if (prefs.seaside) tags.push('海景房');
      if (prefs.pool) tags.push('自带泳池');
      if (prefs.kids) tags.push('亲子友好');
      if (prefs.elderly) tags.push('适老');
      if (prefs.hotelTier === 'luxury') tags.push('豪华');
      else if (prefs.hotelTier === 'budget') tags.push('经济实惠');
      if (rating >= 4.6) tags.push('高评分推荐');
    } else if (type === 'restaurant') {
      tags.push('美食推荐');
      if (prefs.cuisine) tags.push(prefs.cuisine);
      if (rating >= 4.6) tags.push('高分必吃');
    }
    return tags;
  }

  /**
   * 兼容旧接口：仅给免费/付费标记。所有真实价格由 PricingService 提供
   */
  private inferPrice(type: string, poi: RawPOI): string {
    if (type === 'attraction') {
      const hasFee = poi.tags?.some(t =>
        t.includes('fee') || t.includes('ticket') || t.includes('paid')
      );
      return hasFee ? '需门票' : '免费';
    }
    // 酒店/餐厅的真实价格 + 优惠统一在 convertToItem 里通过 PricingService 计算
    return '请以实时报价为准';
  }

  private parseCost(priceStr: string | undefined | null): number | null {
    if (!priceStr) return null;
    const m = priceStr.match(/(\d+)/);
    return m && m[1] ? parseInt(m[1]) : null;
  }

  private inferCategory(tags: string[], prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string {
    if (tags.some(t => /park|garden|nature|beach|water|mountain|volcano/.test(t))) {
      return prefs.seaside ? '海岛自然风光' : '自然风光';
    }
    if (tags.some(t => /museum|church|temple|castle|monument|memorial|historic/.test(t))) return '历史文化';
    if (tags.some(t => /mall|shop|market|amusement|theme_park|zoo/.test(t))) return '休闲娱乐';
    return '综合景点';
  }

  private inferCuisine(tags: string[], name: string): string {
    if (tags.some(t => /chinese|asian|japanese|korean|italian|french|thai|indian|mexican/.test(t))) {
      const match = tags.find(t => /chinese|asian|japanese|korean|italian|french|thai|indian|mexican/.test(t));
      if (match) return match.charAt(0).toUpperCase() + match.slice(1);
    }
    return '本地特色';
  }
}
