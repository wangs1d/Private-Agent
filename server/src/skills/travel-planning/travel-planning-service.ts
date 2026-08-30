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
import type { IPlanningAgent, AgentRequest } from './interfaces.js';
import { poiCache, type CacheEntry, type RawPOI } from './poi-cache-manager.js';
import { pricingService, formatQuotePriceInfo, type MemberTier, type PriceQuote, type BoundPlatform, type PricingContext } from './pricing-service.js';
import { travelMediaStore } from './travel-media-store.js';

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
  const domesticKeywords = [
    // 直辖市
    '北京','上海','天津','重庆',
    // 省份
    '河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西','甘肃','青海','台湾','内蒙古','广西','西藏','宁夏','新疆','香港','澳门',
    // 热门城市
    '大理','丽江','杭州','成都','西安','厦门','三亚','桂林','拉萨','青岛','南京','苏州','长沙','张家界','哈尔滨','武汉','广州','深圳','昆明','黄山','九寨沟','敦煌','乌镇','凤凰古城','平遥古城','周庄','西塘','千岛湖','普陀山','峨眉山','武夷山','泰山','华山','衡山','嵩山','恒山','五台山','长白山','天池','喀纳斯','吐鲁番','喀什','稻城亚丁','四姑娘山',
    // 别名
    '北平','沪','蓉','穗','深','杭','宁',
  ];
  const lower = destName.toLowerCase().trim();
  return domesticKeywords.some(k => lower.includes(k.toLowerCase()) || destName.includes(k));
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

// ======================== 主服务类 ========================

export class PlanningService {

  /** 当天行程最晚结束时间（分钟，21:00）。超预算的景点顺延丢弃，时钟不再绕回次日。 */
  private static readonly DAY_END_MIN = 21 * 60;

  /** 交通腿缓存（坐标 ~100m 网格），OSRM 结果 24h 复用 */
  private legCache = new Map<string, { transport: TransportLeg; ts: number }>();

  /** OSRM 熔断：不可用时 10 分钟内直接走本地估算，避免编排被外网超时拖住 */
  private osrmDisabledUntil = 0;

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
  async generateItinerary(request: PlanningRequest): Promise<PlanningResult> {
    const t0 = Date.now();
    console.log(`[PlanningService] 开始规划: "${request.input}"`);

    // 1. 解析用户输入
    const destName = this.extractDestination(request.input, request.destination);
    const dayCount = request.days || this.extractDays(request.input) || 3;
    const preferences = this.extractPreferences(request.input, request.preferences, destName);
    const normalizedDest = destName.toLowerCase().trim();

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
      cacheEntry = await this.searchAndCache(destName, normalizedDest);
      fromCache = false;
    } else {
      console.log(`[PlanningService] 缓存命中! (已访问${cacheEntry.accessCount}次)`);
    }

    // 4. 行程级二级缓存：同 目的地+天数+偏好 且 POI 数据未刷新时整体复用
    //    （省去重排序+编排+图片匹配，二次规划毫秒级返回）
    const itinKey =
      `itin|${normalizedDest}|${dayCount}|${JSON.stringify(preferences)}`;
    const cachedItin = itineraryCache.get(itinKey);
    if (
      cachedItin &&
      cachedItin.poiUpdatedAt === cacheEntry.createdAt &&
      Date.now() - cachedItin.ts < ITINERARY_CACHE_TTL_MS
    ) {
      console.log(`[PlanningService] 【行程缓存命中】直接返回 ${destName} ${dayCount}天行程（免重算+免抓图）`);
      return cachedItin.result;
    }

    // 5. 生成日期范围
    const today = new Date();
    const startDate: string = today.toISOString().split('T')[0] ?? '';
    const endDate: string = new Date(today.getTime() + (dayCount - 1) * 86400000).toISOString().split('T')[0] ?? '';

    // 6. 依据偏好对POI排序/筛选
    const ranked = this.rankPOIsByPreferences(
      cacheEntry.data.attractions,
      cacheEntry.data.hotels,
      cacheEntry.data.restaurants,
      preferences
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
    console.log(`[PlanningService] 阶段1：构建行程数据...`);
    const tBuild0 = Date.now();
    const { days: daysRaw, pois } = await this.buildDaysFast(
      dayCount, startDate,
      ranked.attractions, ranked.hotels, ranked.restaurants,
      cacheEntry.center, preferences, travelInfo, pricingCtx
    );
    const tBuild = Date.now() - tBuild0;

    // === 阶段2：媒体装配（纯本地读：媒体库/POI 缓存直图，网络抓取已移出请求路径）===
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
    };

    // 9. 写入行程级二级缓存（POI 数据刷新时由 createdAt 差异自然失效）
    cacheItinerary(itinKey, {
      ts: Date.now(),
      poiUpdatedAt: cacheEntry.createdAt,
      result,
    });

    console.log(
      `[PlanningService] 规划完成: ${destName} ${dayCount}天 | 解析+取数 ${tParsed}ms, 编排 ${tBuild}ms, 媒体装配 ${tMedia}ms, 总计 ${Date.now() - t0}ms` +
      ` | 图片 ${imageMap.size} 个POI本地直读, 缺图 ${missing.length} 个转后台回填`,
    );

    return result;
  }

  /**
   * Agent 集成入口：通过注入的 IPlanningAgent 生成行程
   *
   * 设计要点：
   *   - PlanningService 不持有 PlanningAgent 引用（避免循环依赖），通过参数注入
   *   - agent 返回的 itinerary 若已是 PlanningResult 格式则直接用；否则包装为 PlanningResult
   *   - agent 返回空 itinerary 或转换失败时，降级到 this.generateItinerary 并标记 degraded
   *   - 不修改 generateItinerary 主方法的现有逻辑
   */
  async generateItineraryViaAgent(
    request: PlanningRequest,
    agent: IPlanningAgent,
  ): Promise<PlanningResult & { agentTrace: AgentTrace; planningMode: string }> {
    const agentRequest: AgentRequest = {
      input: request.input,
      destination: request.destination,
      days: request.days,
      preferences: request.preferences,
    };

    const agentResult = await agent.generateItinerary(agentRequest);
    const agentTrace: AgentTrace = agentResult.agentTrace;

    // 尝试将 agent 返回的 itinerary 转换为 PlanningResult
    const planningResult = this.toPlanningResult(agentResult.itinerary, request);

    if (planningResult) {
      return {
        ...planningResult,
        agentTrace,
        planningMode: agentTrace.planningMode,
      };
    }

    // 降级到规则引擎
    const fallbackResult = await this.generateItinerary(request);
    const degradedTrace: AgentTrace = {
      ...agentTrace,
      planningMode: 'fallback-rule',
      degraded: true,
      degradeReason:
        agentTrace.degradeReason ||
        'Agent returned empty or invalid itinerary, fell back to rule engine',
    };
    return {
      ...fallbackResult,
      agentTrace: degradedTrace,
      planningMode: 'fallback-rule',
    };
  }

  /**
   * Skill 只读入口：搜索目的地 POI（景点/酒店/餐厅）。
   * 走缓存优先 → 网络实时搜索 → 内置知识库/合成兜底，返回扁平 POI 摘要列表。
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
      }
    } catch {
      // 网络/地理编码失败时降级到内置知识库
      const known = this.findKnownPOIs(destName);
      cacheEntry = {
        destination: destName,
        queryKey: normalizedDest,
        data: {
          attractions: known?.attractions ?? [],
          hotels: known?.hotels ?? [],
          restaurants: known?.restaurants ?? [],
        },
        center: this.findKnownCoordinates(destName)?.center ?? { latitude: 0, longitude: 0 },
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
   */
  describePoi(poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): string {
    return this.generateDescription(poi, type);
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
      const destName = request.destination || this.extractDestination(request.input, request.destination);
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
        preferences: this.extractPreferences(request.input, request.preferences, destName),
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

  // ======================== 目的地解析 ========================

  /**
   * 从用户输入中提取目的地名称
   * 支持丰富的中文表达模式，优先匹配已知热门目的地
   */
  private extractDestination(input: string, explicitDest?: string): string {
    if (explicitDest && explicitDest.trim()) return explicitDest.trim();

    const text = input.trim();

    // ===== 策略0: 清理异常字符（emoji/乱码/控制字符）=====
    // 防止 destination 变成 "??????" 或 "未去莫干山民宿假放松为"
    const cleanedText = text
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // emoji
      .replace(/[\uFFFD\uFFFC\uFF1F\uFF1A]/g, ' ')               // 替换字符/全角问号
      .replace(/[?？！!。，,]/g, ' ')                              // 标点
      .replace(/\s+/g, ' ')
      .trim();
    const workText = cleanedText || text;

    // ===== 策略1: 已知热门目的地优先匹配（最高优先级）=====
    const knownDestinations = [
      // 国内
      '云南大理','大理','云南丽江','丽江','北京','上海','杭州','成都','西安','厦门','三亚',
      '桂林','拉萨','青岛','重庆','南京','苏州','长沙','张家界','哈尔滨','武汉','广州',
      '深圳','香港','澳门','台北','昆明','黄山','九寨沟','张家界','敦煌','乌镇','凤凰古城',
      '平遥古城','周庄','西塘','千岛湖','普陀山','峨眉山','武夷山','泰山','华山','衡山',
      '嵩山','恒山','五台山','长白山','天池','喀纳斯','吐鲁番','喀什','稻城亚丁','四姑娘山',
      '莫干山','安吉','千岛湖','普陀山','雁荡山','天台山',
      // 国外
      '东京','大阪','京都','奈良','北海道','富士山','曼谷','清迈','普吉岛','苏梅岛',
      '巴厘岛','新加坡','吉隆坡','马六甲','首尔','釜山','济州岛','巴黎','罗马','伦敦',
      '纽约','悉尼','迪拜','伊斯坦布尔','开罗','马尔代夫','塞班岛','长滩岛','岘港',
      '芽庄','富国岛','暹粒','斯里兰卡','马尔代夫','斐济','大溪地','塞舌尔','毛里求斯',
      '布拉格','阿姆斯特丹','巴塞罗那','雅典','圣托里尼','威尼斯','佛罗伦萨',
    ];

    const lowerText = workText.toLowerCase();
    // 按关键词长度倒序，优先匹配最长的（比如"云南大理"优先于"大理"）
    const sortedKnown = [...knownDestinations].sort((a, b) => b.length - a.length);
    for (const dest of sortedKnown) {
      if (lowerText.includes(dest.toLowerCase()) || workText.includes(dest)) {
        console.log(`[PlanningService] 目的地命中已知列表: ${dest}`);
        return dest;
      }
    }

    // ===== 策略2: 正则模式匹配 =====
    const patterns = [
      // "我想去XXX玩/旅游/旅行"  - 限制目的地在 "去" 和 "玩/游" 之间的关键短语
      /(?:我想?去|前往|想去|计划去|准备去|要去)\s*([^\s,，。！？!?]{2,8}?)(?:\s*(?:玩|旅游|旅行|游玩|度假|逛|转|看看|考察))/,
      // "去XXX玩/游"
      /^(?:想)?(?:去|游览|参观|游玩|到)\s*([^\s,，。！？!?]{2,8})$/,
      // "XXX N天/日游/之旅" - 限制2-6个汉字，避免匹配整段
      /([^\s,，。！？!?]{2,6})(?:\s*\d+\s*[天日周]\s*(?:之)?游|之旅|旅游)/,
      // "XXX + 数字天" (如 "大理5天")
      /([^\s,，。！？!?]{2,6})\s+(\d+)\s*[天日]/,
    ];

    for (const p of patterns) {
      const m = workText.match(p);
      if (m && m[1]) {
        const dest = m[1].trim();
        if (dest.length >= 2 && dest.length <= 8) {
          console.log(`[PlanningService] 正则匹配目的地: ${dest}`);
          return dest;
        }
      }
    }

    // ===== 策略3: 提取前几个有意义的词作为目的地兜底 =====
    // 过滤掉动词和无关词
    const cleaned = workText
      .replace(/(?:我想?去|前往|想去|计划去|准备去|要去|到|玩|旅游|旅行|游玩|度|逛|转|看看|喜欢|希望|想要|需要|大概|大约|左右|预算|费用|花费|多少钱|放松|度假|为主|为主酒店|主酒店|主美食|主景点|未去|没去|不去|即将去)/g, '')
      .replace(/[天日个周月]/g, '')
      .replace(/\d+/g, '')
      .trim();

    const words = cleaned.split(/[\s,，、]+/).filter(w => w.length >= 2 && w.length <= 6);
    if (words.length > 0) {
      // 优先取第一个看起来像地名的词（含有"山/岛/城/湖/海/镇/村"等地理关键词）
      const geoWord = words.find(w => /[山川岛城湖海镇村寨古城]/.test(w));
      const dest = geoWord || words[0];
      if (dest && dest.length >= 2 && dest.length <= 8) {
        console.log(`[PlanningService] 兜底提取目的地: ${dest} (原文: ${input})`);
        return dest;
      }
    }

    // 真正的兜底：取前4个汉字（不再延长，避免出现"未去莫干山..."）
    const safe = workText.replace(/\s/g, '').slice(0, 4);
    console.warn(`[PlanningService] 无法提取目的地，使用前4字: ${safe} (原文: ${input})`);
    return safe || '未指定';
  }

  /**
   * 提取行程天数，支持丰富中文表达
   *  - "3天 / 三日 / 5天"
   *  - "一周 / 一个星期 / 两个星期 / 3周 / 两周半"
   *  - "半个月 / 10天"
   */
  private extractDays(input: string): number | null {
    // 数字+天/日
    const m = input.match(/(\d+)\s*[天日]/);
    if (m && m[1]) return Math.min(30, Math.max(1, parseInt(m[1])));

    // X周 / X星期（支持中文数字 + 任意个"个"等量词）
    const weekMatch = input.match(/([一二三四五六七八九十\d]+)\s*(?:个)?\s*(?:周|星期)/);
    if (weekMatch && weekMatch[1]) {
      const cnNum: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
      const w = weekMatch[1];
      const n = cnNum[w] ?? parseInt(w) ?? 1;
      return Math.min(30, n * 7);
    }

    // 半个月
    if (/半\s*个?[月]/.test(input)) return 15;

    return null;
  }

  // ======================== 偏好解析 ========================

  /**
   * 从自然语言 + 自由文本标签 + 目的地常识中抽取结构化偏好
   * 优先级：用户原文 > 目的地常识 > 系统默认
   */
  private extractPreferences(input: string, rawPrefs?: string[], destName?: string): TripPreferences {
    const text = `${input || ''} ${(rawPrefs || []).join(' ')}`.toLowerCase();
    const has = (kw: string | RegExp) => (kw instanceof RegExp ? kw.test(text) : text.includes(kw));

    const prefs: TripPreferences = {
      raw: rawPrefs ? [...rawPrefs] : [],
      seaside: false,
      pool: false,
      activities: false,
      kids: false,
      elderly: false,
      pace: 'balanced',
      activityMix: 'mixed',
      sources: {
        seaside: 'default',
        pool: 'default',
        activities: 'default',
        kids: 'default',
        elderly: 'default',
        pace: 'default',
        activityMix: 'default',
        budget: 'default',
        cuisine: 'default',
        hotelTier: 'default',
      },
    };

    // —— 用户原文层 ——
    // 海边 / 海景 / 滨海岸
    if (has(/海[边滨景]?/) || has(/海[滨岸]/) || has(/靠海/) || has(/沙滩/) || has(/海岛/) || has(/beach|seaside|ocean/)) {
      prefs.seaside = true; prefs.sources.seaside = 'user';
    }

    // 泳池
    if (has(/泳池/) || has(/游泳池/) || has(/pool|swimming/)) {
      prefs.pool = true; prefs.sources.pool = 'user';
    }

    // 游玩项目 / 活动 / 玩什么
    if (
      has(/有什么好玩的/) || has(/好玩的项目/) || has(/玩什么/) || has(/有什么项目/) ||
      has(/游玩项目/) || has(/娱乐项目/) || has(/活动/) || has(/体验/) || has(/activities|tour|sightseeing/)
    ) {
      prefs.activities = true; prefs.sources.activities = 'user';
    }

    // 同行人
    if (has(/带[小孩宝宝孩子]/) || has(/亲子/) || has(/全家/) || has(/一家人/)) {
      prefs.kids = true; prefs.sources.kids = 'user';
    }
    if (has(/带[老人父母长辈]/) || has(/父母/) || has(/老人/)) {
      prefs.elderly = true; prefs.sources.elderly = 'user';
    }

    // 节奏
    if (has(/休闲/) || has(/慢游/) || has(/度假/) || has(/放松/) || has(/悠闲/) || has(/懒/)) {
      prefs.pace = 'relaxed'; prefs.sources.pace = 'user';
    } else if (has(/紧凑/) || has(/高效/) || has(/深度游/) || has(/打卡/) || has(/多去/)) {
      prefs.pace = 'intensive'; prefs.sources.pace = 'user';
    }

    // 活动类型偏好
    if (has(/文化/) || has(/古迹/) || has(/历史/) || has(/博物馆/) || has(/寺庙/)) {
      prefs.activityMix = 'culture'; prefs.sources.activityMix = 'user';
    } else if (has(/自然/) || has(/山水/) || has(/徒步/) || has(/国家公园/) || has(/风景/)) {
      prefs.activityMix = 'nature'; prefs.sources.activityMix = 'user';
    } else if (has(/娱乐/) || has(/乐园/) || has(/购物/) || has(/夜生活/)) {
      prefs.activityMix = 'entertainment'; prefs.sources.activityMix = 'user';
    }

    // 预算档
    if (has(/省[钱一点]?/) || has(/便宜/) || has(/经济/) || has(/穷游/) || has(/预算[不紧]?[太多高]/)) {
      prefs.budget = 'low'; prefs.sources.budget = 'user';
    } else if (has(/豪华/) || has(/高端/) || has(/奢/) || has(/奢华/) || has(/五星/)) {
      prefs.budget = 'high'; prefs.sources.budget = 'user';
    } else if (has(/舒适/) || has(/中端/) || has(/四星/)) {
      prefs.budget = 'mid'; prefs.sources.budget = 'user';
    }

    // 住宿档次（仅影响酒店排序）
    if (has(/豪华酒店/) || has(/五星/) || has(/高端住宿/) || has(/奢华/)) {
      prefs.hotelTier = 'luxury'; prefs.sources.hotelTier = 'user';
    } else if (has(/经济/) || has(/青旅/) || has(/民宿/) || has(/客栈/)) {
      prefs.hotelTier = 'budget'; prefs.sources.hotelTier = 'user';
    } else if (has(/舒适/) || has(/精品/) || has(/四星/)) {
      prefs.hotelTier = 'mid'; prefs.sources.hotelTier = 'user';
    }

    // 菜系
    const cuisineMap: Array<[RegExp, string]> = [
      [/海鲜/, '海鲜'],
      [/中餐|中国菜|中厨/, '中餐'],
      [/日料|日本菜|寿司|刺身/, '日料'],
      [/韩餐|韩国|烤肉|韩式/, '韩餐'],
      [/西餐|法国|意面|意大利|牛排/, '西餐'],
      [/泰餐|泰国|冬阴功/, '泰餐'],
      [/火锅|麻辣/, '火锅'],
      [/烧烤|撸串/, '烧烤'],
      [/甜品|咖啡|下午茶/, '甜品'],
      [/当地|本地|特色/, '当地特色'],
    ];
    for (const [re, name] of cuisineMap) {
      if (re.test(text)) {
        prefs.cuisine = name; prefs.sources.cuisine = 'user';
        break;
      }
    }

    // —— 目的地常识层（用户没说就补） ——
    if (destName) this.applyDestinationDefaults(destName, prefs);

    // —— 系统默认层 ——
    if (!prefs.hotelTier) {
      prefs.hotelTier = 'mid'; prefs.sources.hotelTier = 'default';
    }
    if (!prefs.budget) {
      prefs.budget = 'mid'; prefs.sources.budget = 'default';
    }

    return prefs;
  }

  /**
   * 根据目的地常识补全偏好（用户没说时启用，但来源标为 destination）
   */
  private applyDestinationDefaults(destName: string, prefs: TripPreferences): void {
    const n = destName.toLowerCase();

    // 海岛/海滨 → 默认 seaside + pool
    const islandKw = ['巴厘岛','bali','马尔代夫','maldives','普吉','phuket','三亚','沙巴','sabah',
                     '长滩','boracay','沙美','苏梅','koh samui','岘港','danang','芽庄','nha trang',
                     '宿务','cebu','长崎','冲绳','okinawa','济州','jeju','关岛','guam',
                     '斐济','fiji','塞班','saipan','帕劳','palau','印尼','印度尼西亚','indonesia'];
    if (islandKw.some(k => n.includes(k)) && prefs.sources.seaside === 'default') {
      prefs.seaside = true; prefs.sources.seaside = 'destination';
      if (prefs.sources.pool === 'default') { prefs.pool = true; prefs.sources.pool = 'destination'; }
      if (prefs.sources.activityMix === 'default') { prefs.activityMix = 'mixed'; }
    }

    // 日本 → 美食/温泉/文化
    if (/日本|japan|东京|大阪|京都|奈良|北海道|富士山/.test(n)) {
      if (!prefs.cuisine) { prefs.cuisine = '日料'; prefs.sources.cuisine = 'destination'; }
      if (prefs.sources.activityMix === 'default') { prefs.activityMix = 'culture'; prefs.sources.activityMix = 'destination'; }
    }
    // 韩国
    if (/韩国|korea|首尔|釜山|济州/.test(n)) {
      if (!prefs.cuisine) { prefs.cuisine = '韩餐'; prefs.sources.cuisine = 'destination'; }
    }
    // 泰国
    if (/泰国|thailand|曼谷|清迈|普吉|苏梅/.test(n)) {
      if (!prefs.cuisine) { prefs.cuisine = '泰餐'; prefs.sources.cuisine = 'destination'; }
    }
    // 东南亚综合
    if (/越南|新加坡|马来西亚|印尼|菲律宾|柬埔寨/.test(n)) {
      if (prefs.sources.activities === 'default') { prefs.activities = true; prefs.sources.activities = 'destination'; }
    }

    // 欧洲
    if (/法国|巴黎|意大利|罗马|英国|伦敦|西班牙|巴塞罗那|德国|瑞士|荷兰|希腊|葡萄牙/.test(n)) {
      if (prefs.sources.activityMix === 'default') { prefs.activityMix = 'culture'; prefs.sources.activityMix = 'destination'; }
      if (prefs.sources.pace === 'default') { prefs.pace = 'balanced'; } // 步行多
    }

    // 阿联酋/迪拜 → 豪华
    if (/迪拜|阿联酋|dubai|uae/.test(n) && prefs.sources.hotelTier === 'default') {
      prefs.hotelTier = 'luxury'; prefs.sources.hotelTier = 'destination';
    }

    // 印度/尼泊尔/高原 → 节奏放松
    if (/印度|尼泊尔|不丹|拉萨|西藏|秘鲁|玻利维亚|肯尼亚/.test(n)) {
      if (prefs.sources.pace === 'default') { prefs.pace = 'relaxed'; prefs.sources.pace = 'destination'; }
    }

    // 带孩子常见目的地 → 默认亲子
    if (/日本|东京|disney|迪士尼|新加坡|环球影城/.test(n) && prefs.sources.kids === 'default') {
      // 仅当目的地含迪士尼/环球影城等亲子关键词
      if (/迪士尼|环球影城|legoland|乐高/.test(n)) {
        prefs.kids = true; prefs.sources.kids = 'destination';
      }
    }
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
    };
  }

  private findKnownTravelInfo(destName: string): TravelInfo | null {
    const q = destName.toLowerCase();
    const all: TravelInfo[] = [
      // 印度尼西亚 / 巴厘岛
      {
        destination: '印度尼西亚',
        visa: { required: true, type: '落地签', notes: '中国公民可免签入境印尼（30天内），但建议行前确认最新政策' },
        currency: { name: '印尼盾', code: 'IDR', symbol: 'Rp', rateToCNY: 2200 },
        timezone: { name: '印尼中部/西部/东部时间', offset: 'UTC+7 / +8 / +9' },
        language: ['印尼语', '巴厘语（巴厘岛）', '英语（景区通用）'],
        voltage: '230V / 50Hz',
        socket: '欧标双圆孔（建议带转换头）',
        bestSeason: { months: ['4月','5月','6月','9月','10月'], description: '干季（4-10月）最佳，避开11-3月雨季' },
        emergency: { police: '110', ambulance: '118', touristHotline: '+62-21-576-3074', chinaEmbassy: '+62-21-576-1037' },
        customs: ['进入寺庙需穿过膝长裤/长裙','不要用左手递东西','头被视为神圣不可触摸','不要随意拍摄当地宗教仪式'],
        tips: ['小费习惯：餐厅可给1万Rp，服务类1-2万Rp','包车/水疗/按摩务必提前谈价','Spa、租车可砍价5折起','携带防蚊液与防晒霜','巴厘岛Scooter驾照检查较严，谨慎租摩托'],
      },
      {
        destination: '巴厘岛',
        visa: { required: true, type: '落地签', notes: '中国公民可免签入境印尼30天' },
        currency: { name: '印尼盾', code: 'IDR', symbol: 'Rp', rateToCNY: 2200 },
        timezone: { name: '印尼中部时间', offset: 'UTC+8' },
        language: ['印尼语', '巴厘语', '英语（旅游区）'],
        voltage: '230V / 50Hz',
        socket: '欧标双圆孔',
        bestSeason: { months: ['4月','5月','6月','9月','10月'], description: '干季最佳' },
        emergency: { police: '110', ambulance: '118', chinaEmbassy: '+62-21-576-1037' },
        customs: ['寺庙着装需覆盖肩膀与膝盖','勿踩当地祭祀用的小花篮(canang)','头不可触摸'],
        tips: ['推荐包车1天约60-80万Rp','Spa+按摩可砍价','准备防蚊液','Scooter谨慎'],
      },
      // 日本
      {
        destination: '日本',
        visa: { required: true, type: '需签证', notes: '需提前办日本签证，多地可办' },
        currency: { name: '日元', code: 'JPY', symbol: '¥', rateToCNY: 21 },
        timezone: { name: '日本标准时间', offset: 'UTC+9' },
        language: ['日语', '部分景区有中文/英文'],
        voltage: '100V / 50-60Hz（与中国不同，电器需注意）',
        socket: '双扁脚（日标）',
        bestSeason: { months: ['3月','4月','5月','10月','11月'], description: '春秋最佳，樱花季3-4月，红叶10-11月' },
        emergency: { police: '110', ambulance: '119', touristHotline: '050-3816-2787', chinaEmbassy: '+81-3-3403-3388' },
        customs: ['电车/巴士内请勿大声喧哗','优先席让座','不边走边吃','温泉需先冲洗身体再入池','垃圾分类严格'],
        tips: ['必备西瓜卡/SUICA','便利店/自动贩卖机覆盖广','拉面/寿司地区差异大，多尝','温泉为常见体验','餐厅多不收小费'],
      },
      // 泰国
      {
        destination: '泰国',
        visa: { required: true, type: '免签', notes: '中国公民互免签证（2024起），停留不超过30日' },
        currency: { name: '泰铢', code: 'THB', symbol: '฿', rateToCNY: 5 },
        timezone: { name: '印度支那时间', offset: 'UTC+7' },
        language: ['泰语', '英语（旅游区）', '中文（华人区）'],
        voltage: '220V / 50Hz',
        socket: '双扁/双圆混合（建议带万能头）',
        bestSeason: { months: ['11月','12月','1月','2月'], description: '凉季最佳，3-5月热，6-10月雨季' },
        emergency: { police: '191', ambulance: '1669', touristHotline: '1155', chinaEmbassy: '+66-2-245-7044' },
        customs: ['进入寺庙需脱鞋','勿用脚指人/物','头不可触摸','皇室相关需尊重'],
        tips: ['Grab/Bolt打车方便','按摩/Spa价格谈判空间大','夜市美食众多','小费20-50泰铢常见'],
      },
      // 三亚
      {
        destination: '三亚',
        visa: { required: false, type: '免签', notes: '国内旅行无需签证' },
        currency: { name: '人民币', code: 'CNY', symbol: '¥' },
        timezone: { name: '北京时间', offset: 'UTC+8' },
        language: ['普通话', '海南话', '英语（旅游区）'],
        voltage: '220V / 50Hz',
        socket: '国标双扁/三孔',
        bestSeason: { months: ['10月','11月','12月','1月','2月','3月'], description: '秋冬季最佳，避开台风季(7-9月)' },
        emergency: { police: '110', ambulance: '120', touristHotline: '12345' },
        customs: ['海滩文明游玩','勿捕捞受保护海洋生物'],
        tips: ['景区消费偏高建议提前买好水果零食','海鲜加工店注意明码实价','防晒SPF50+必备','租车/电瓶车注意安全'],
      },
      // 马尔代夫
      {
        destination: '马尔代夫',
        visa: { required: true, type: '免签', notes: '中国公民可免签30天，需带有效期6个月以上护照与酒店订单' },
        currency: { name: '美元', code: 'USD', symbol: '$', rateToCNY: 7.2 },
        timezone: { name: '马尔代夫时间', offset: 'UTC+5' },
        language: ['迪维希语', '英语（通用）'],
        voltage: '220V / 50Hz',
        socket: '英标三方脚（需带转换头）',
        bestSeason: { months: ['11月','12月','1月','2月','3月','4月'], description: '干季最佳，雨季多阵雨但仍可出行' },
        emergency: { police: '119', ambulance: '102', chinaEmbassy: '+960-301-0915' },
        customs: ['禁酒岛外携带','尊重伊斯兰文化','勿赤足进入居民岛'],
        tips: ['水飞/快艇上岛需提前预约','一价全包较划算','浮潜装备可自带','酒店有给小费习惯（1-2美元）'],
      },
    ];

    // 关键词匹配：返回第一个命中的
    for (const info of all) {
      const keywords = [info.destination.toLowerCase()];
      // 加入额外的别名匹配
      if (info.destination === '印度尼西亚') keywords.push('印尼','indonesia');
      if (info.destination === '巴厘岛') keywords.push('bali');
      if (info.destination === '日本') keywords.push('japan','东京','大阪','京都');
      if (info.destination === '泰国') keywords.push('thailand','曼谷','清迈','普吉');
      if (info.destination === '马尔代夫') keywords.push('maldives');
      if (info.destination === '三亚') keywords.push('海南','sanya');

      if (keywords.some(k => q.includes(k))) return info;
    }
    return null;
  }

  // ======================== 实时搜索 + 缓存写入 ========================

  /**
   * 调用POI搜索API并存入缓存
   * 国内目的地 → 高德地图（真实数据、稳定）
   * 国外目的地 → OpenStreetMap Overpass（免费全球覆盖）
   */
  private async searchAndCache(destName: string, normalizedKey: string): Promise<CacheEntry> {
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

    // Step 3: 如果所有API都返回空结果，生成改进的合成数据
    let syntheticFallback = false;
    if (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0) {
      console.warn(`[PlanningService] 所有API均无结果，使用知名景点降级方案`);
      const synthetic = this.generateSyntheticPOIs(center, destName);
      attractions = synthetic.attractions;
      hotels = synthetic.hotels;
      restaurants = synthetic.restaurants;
      syntheticFallback = true;
    }

    // Step 4: 写入缓存（内存+文件持久化，全局共享）。
    // 全空结果与合成降级结果都不落缓存：否则一次网络故障会把空/占位 POI
    // 永久污染该目的地（缓存命中后直接编排出 0 项行程，且 TTL 内无法自愈）。
    if (syntheticFallback || (attractions.length === 0 && hotels.length === 0 && restaurants.length === 0)) {
      console.warn(`[PlanningService] 跳过 POI 缓存写入（${syntheticFallback ? "合成降级" : "空结果"} 不缓存）`);
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
   * 降级方案：使用知名真实景点/酒店/餐厅数据
   * 当所有API都不可用时，返回该目的地的知名真实POI（可在地图上搜到）
   */
  private generateSyntheticPOIs(center: Coordinates, destName: string): {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  } {
    // 尝试从已知POI数据库匹配
    const known = this.findKnownPOIs(destName);
    if (known) {
      console.log(`[PlanningService] 使用${destName}的知名真实POI数据`);
      return known;
    }

    // 完全未知的目的地：生成通用模板（但至少标注为估算位置）
    // 注意：不再拼接 destName 到 POI 名中，避免 destName 异常时污染所有POI名称
    const lat = center.latitude;
    const lon = center.longitude;
    const spread = (maxKm: number) => (Math.random() - 0.5) * maxKm / 111;

    const makePOI = (name: string, type: string, offsetLat: number, offsetLon: number): RawPOI => ({
      id: `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      latitude: lat + offsetLat,
      longitude: lon + offsetLon,
      address: `该地点附近`,
      type,
      rating: 4.0 + Math.random() * 0.8,
      tags: [type],
      raw: { source: 'fallback', note: 'API不可用，使用估算位置' },
    });

    return {
      attractions: [
        makePOI('当地中心景区', 'attraction', spread(5), spread(5)),
        makePOI('当地历史文化景点', 'attraction', spread(-4), spread(-4)),
        makePOI('当地自然风光区', 'attraction', spread(3), spread(-3)),
      ],
      hotels: [
        makePOI('当地精选酒店', 'hotel', spread(2), spread(2)),
        makePOI('当地民宿', 'hotel', spread(-2), spread(-2)),
      ],
      restaurants: [
        makePOI('当地特色餐厅', 'restaurant', spread(-2), spread(3)),
        makePOI('当地小吃店', 'restaurant', spread(3), spread(-2)),
      ],
    };
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
    const q = destName.toLowerCase().replace(/\s+/g, '');
    const db: Array<{
      keywords: string[];
      data: {
        attractions: Array<{ name: string; lat: number; lon: number; tags: string[] }>;
        hotels: Array<{ name: string; lat: number; lon: number; tags: string[] }>;
        restaurants: Array<{ name: string; lat: number; lon: number; tags: string[] }>;
      };
    }> = [
      {
        keywords: ['大理','dali','云南大理'],
        data: {
          attractions: [
            { name: '大理古城', lat: 25.6541, lon: 100.1696, tags: ['古城','历史文化'] },
            { name: '洱海公园', lat: 25.7000, lon: 100.1900, tags: ['湖泊','自然风光'] },
            { name: '崇圣寺三塔', lat: 25.7047, lon: 100.1472, tags: ['寺庙','古迹'] },
            { name: '苍山景区', lat: 25.6600, lon: 100.1500, tags: ['山脉','自然'] },
            { name: '双廊古镇', lat: 25.9069, lon: 100.1894, tags: ['古镇','海景'] },
            { name: '喜洲古镇', lat: 25.8514, lon: 100.1294, tags: ['古镇','白族文化'] },
            { name: '蝴蝶泉', lat: 25.8231, lon: 100.1531, tags: ['景点','自然'] },
          ],
          hotels: [
            { name: '大理古城博爱路精品客栈', lat: 25.6550, lon: 100.1700, tags: ['民宿','古城内'] },
            { name: '大理洱海天域英迪格酒店', lat: 25.7200, lon: 100.2300, tags: ['五星','海景'] },
            { name: '大理希尔顿酒店', lat: 25.6000, lon: 100.2200, tags: ['五星','国际连锁'] },
          ],
          restaurants: [
            { name: '段公子·大理古国主题店', lat: 25.6550, lon: 100.1680, tags: ['滇菜','网红'] },
            { name: '再回首凉鸡米线', lat: 25.6520, lon: 100.1710, tags: ['小吃','本地特色'] },
            { name: '大理古城人民路烧烤', lat: 25.6500, lon: 100.1670, tags: ['烧烤','夜宵'] },
          ],
        },
      },
      {
        keywords: ['莫干山','mogan','mogan山'],
        data: {
          attractions: [
            { name: '莫干山风景名胜区', lat: 30.6050, lon: 119.8950, tags: ['山岳','避暑胜地','竹海'] },
            { name: '莫干山剑池', lat: 30.6012, lon: 119.8920, tags: ['山泉','古迹'] },
            { name: '莫干山瀑布群', lat: 30.6080, lon: 119.8980, tags: ['瀑布','自然'] },
            { name: '裸心谷', lat: 30.5810, lon: 119.8820, tags: ['度假村','生态'] },
            { name: '德清下渚湖湿地', lat: 30.5420, lon: 119.9650, tags: ['湿地','自然'] },
            { name: '莫干山毛泽东旧居', lat: 30.6040, lon: 119.8930, tags: ['历史','名人故居'] },
          ],
          hotels: [
            { name: '莫干山郡安里度假酒店', lat: 30.5880, lon: 119.8890, tags: ['度假村','山景'] },
            { name: '大乐之野·莫干山', lat: 30.6020, lon: 119.8950, tags: ['精品民宿','网红'] },
            { name: '莫干山民宿·西坡', lat: 30.6100, lon: 119.8900, tags: ['民宿','山景'] },
            { name: '莫干山裸心堡', lat: 30.5830, lon: 119.8780, tags: ['奢华','度假'] },
          ],
          restaurants: [
            { name: '莫干山石颐山房', lat: 30.6040, lon: 119.8930, tags: ['本帮菜','山野风味'] },
            { name: '大乐之野·山中餐厅', lat: 30.6020, lon: 119.8950, tags: ['西餐','民宿餐厅'] },
            { name: '莫干山农家菜·竹园', lat: 30.6080, lon: 119.8980, tags: ['农家菜','土菜'] },
          ],
        },
      },
      {
        keywords: ['丽江','lijiang','云南丽江'],
        data: {
          attractions: [
            { name: '丽江古城', lat: 26.8720, lon: 100.2360, tags: ['古城','世界遗产'] },
            { name: '玉龙雪山', lat: 27.1000, lon: 100.1700, tags: ['雪山','自然'] },
            { name: '蓝月谷', lat: 27.0800, lon: 100.1750, tags: ['湖泊','峡谷'] },
            { name: '束河古镇', lat: 26.9100, lon: 100.2000, tags: ['古镇','纳西文化'] },
            { name: '黑龙潭公园', lat: 26.8700, lon: 100.2350, tags: ['公园','湖泊'] },
            { name: '泸沽湖', lat: 27.7300, lon: 100.7500, tags: ['湖泊','摩梭文化'] },
          ],
          hotels: [
            { name: '丽江古城五一街文治巷民宿', lat: 26.8730, lon: 100.2370, tags: ['民宿','古城'] },
            { name: '丽江和府洲际度假酒店', lat: 26.8680, lon: 100.2320, tags: ['五星','度假'] },
            { name: '丽江金茂凯悦臻选酒店', lat: 26.8650, lon: 100.2280, tags: ['五星','雪山景'] },
          ],
          restaurants: [
            { name: '阿婆腊排骨火锅', lat: 26.8700, lon: 100.2400, tags: ['火锅','纳西风味'] },
            { name: '丽江古城七一街小吃', lat: 26.8710, lon: 100.2340, tags: ['小吃','古城'] },
            { name: '滇西王子·云南菜', lat: 26.8690, lon: 100.2360, tags: ['滇菜','精致餐饮'] },
          ],
        },
      },
      {
        keywords: ['三亚','sanya'],
        data: {
          attractions: [
            { name: '天涯海角', lat: 18.2960, lon: 109.3450, tags: ['海滨','标志性'] },
            { name: '亚龙湾', lat: 18.2150, lon: 109.6200, tags: ['海滩','度假'] },
            { name: '蜈支洲岛', lat: 18.3130, lon: 109.7620, tags: ['海岛','潜水'] },
            { name: '南山文化旅游区', lat: 18.2880, lon: 109.1980, tags: ['佛教','文化'] },
            { name: '大小洞天', lat: 18.3000, lon: 109.1720, tags: ['海滨','道教'] },
            { name: '鹿回头风景区', lat: 18.2120, lon: 109.4780, tags: ['山顶','观景'] },
          ],
          hotels: [
            { name: '三亚亚特兰蒂斯酒店', lat: 18.2450, lon: 109.6740, tags: ['七星','水世界'] },
            { name: '三亚海棠湾仁恒皇冠假日', lat: 18.2300, lon: 109.7000, tags: ['五星','海棠湾'] },
            { name: '三亚大东海酒店', lat: 18.2200, lon: 109.4800, tags: ['四星','大东海'] },
          ],
          restaurants: [
            { name: '椰梦长廊海鲜广场', lat: 18.2500, lon: 109.5000, tags: ['海鲜','本地人推荐'] },
            { name: '第一市场海鲜加工', lat: 18.2420, lon: 109.5080, tags: ['海鲜','平价'] },
            { name: '琼乡阁海南菜餐厅', lat: 18.2480, lon: 109.5120, tags: ['琼菜','海南风味'] },
          ],
        },
      },
      {
        keywords: ['成都','chengdu'],
        data: {
          attractions: [
            { name: '大熊猫繁育研究基地', lat: 30.7380, lon: 104.1450, tags: ['动物','国宝'] },
            { name: '宽窄巷子', lat: 30.6700, lon: 104.0550, tags: ['街区','历史文化'] },
            { name: '锦里古街', lat: 30.6450, lon: 104.0500, tags: ['古街','三国文化'] },
            { name: '武侯祠', lat: 30.6450, lon: 104.0550, tags: ['祠堂','三国'] },
            { name: '杜甫草堂', lat: 30.6600, lon: 104.0300, tags: ['博物馆','诗歌'] },
            { name: '青城山', lat: 30.9000, lon: 103.5700, tags: ['道教名山','自然'] },
          ],
          hotels: [
            { name: '成都春熙路亚朵酒店', lat: 30.6580, lon: 104.0800, tags: ['中高端','商圈'] },
            { name: '成都世纪城天堂洲际', lat: 30.5700, lon: 104.0700, tags: ['五星','会展'] },
            { name: '成都宽窄巷子民宿', lat: 30.6680, lon: 104.0580, tags: ['民宿','景区旁'] },
          ],
          restaurants: [
            { name: '陈麻婆豆腐(骡马市店)', lat: 30.6600, lon: 104.0650, tags: ['川菜','老字号'] },
            { name: '小龙坎老火锅(春熙店)', lat: 30.6550, lon: 104.0780, tags: ['火锅','网红'] },
            { name: '钟水饺(人民公园店)', lat: 30.6550, lon: 104.0600, tags: ['小吃','传统'] },
          ],
        },
      },
      {
        keywords: ['杭州','hangzhou'],
        data: {
          attractions: [
            { name: '西湖风景名胜区', lat: 30.2590, lon: 120.1490, tags: ['湖泊','世界遗产'] },
            { name: '灵隐寺', lat: 30.2400, lon: 120.1020, tags: ['寺庙','佛教'] },
            { name: '西溪湿地', lat: 30.2700, lon: 120.0700, tags: ['湿地','生态'] },
            { name: '雷峰塔', lat: 30.2300, lon: 120.1480, tags: ['古塔','传说'] },
            { name: '宋城景区', lat: 30.2000, lon: 120.1400, tags: ['主题乐园','演出'] },
          ],
          hotels: [
            { name: '杭州西湖国宾馆', lat: 30.2500, lon: 120.1380, tags: ['国宾','西湖边'] },
            { name: '杭州君悦酒店', lat: 30.2480, lon: 120.1620, tags: ['国际五星','湖滨'] },
            { name: '杭州河坊街民宿', lat: 30.2450, lon: 120.1680, tags: ['民宿','历史街区'] },
          ],
          restaurants: [
            { name: '楼外楼(孤山路店)', lat: 30.2500, lon: 120.1440, tags: ['杭帮菜','百年老店'] },
            { name: '外婆家(西湖银泰店)', lat: 30.2550, lon: 120.1600, tags: ['杭帮菜','连锁'] },
            { name: '知味观(总店)', lat: 30.2520, lon: 120.1650, tags: ['小吃','老字号'] },
          ],
        },
      },
      {
        keywords: ['西安','xian'],
        data: {
          attractions: [
            { name: '秦始皇兵马俑博物馆', lat: 34.3840, lon: 109.2780, tags: ['博物馆','世界遗产'] },
            { name: '大雁塔·大慈恩寺', lat: 34.2200, lon: 108.9640, tags: ['古塔','佛教'] },
            { name: '西安城墙', lat: 34.2520, lon: 108.9470, tags: ['城墙','明代'] },
            { name: '华清宫', lat: 34.3600, lon: 109.2120, tags: ['宫殿','温泉'] },
            { name: '陕西历史博物馆', lat: 34.2300, lon: 108.9550, tags: ['博物馆','文物'] },
            { name: '回民街', lat: 34.2620, lon: 108.9430, tags: ['美食街','历史文化'] },
          ],
          hotels: [
            { name: '西安威斯汀大酒店', lat: 34.2180, lon: 108.9620, tags: ['五星','大雁塔'] },
            { name: '西安钟楼饭店', lat: 34.2600, lon: 108.9470, tags: ['四星','钟楼'] },
            { name: '西安回民街民宿', lat: 34.2600, lon: 108.9400, tags: ['民宿','回民街'] },
          ],
          restaurants: [
            { name: '德发长饺子馆(钟楼店)', lat: 34.2590, lon: 108.9480, tags: ['饺子','中华老字号'] },
            { name: '老孙家羊肉泡馍', lat: 34.2610, lon: 108.9400, tags: ['泡馍','回民'] },
            { name: '长安大排档(赛格店)', lat: 34.2230, lon: 108.9650, tags: ['陕菜','网红'] },
          ],
        },
      },
      {
        keywords: ['北京','beijing'],
        data: {
          attractions: [
            { name: '故宫博物院', lat: 39.9160, lon: 116.3970, tags: ['宫殿','世界遗产'] },
            { name: '长城-八达岭', lat: 40.3580, lon: 116.0200, tags: ['长城','世界遗产'] },
            { name: '天坛公园', lat: 39.8830, lon: 116.4100, tags: ['祭坛','世界遗产'] },
            { name: '颐和园', lat: 39.9980, lon: 116.2750, tags: ['皇家园林','世界遗产'] },
            { name: '南锣鼓巷', lat: 39.9380, lon: 116.4030, tags: ['胡同','历史文化'] },
            { name: '天安门广场', lat: 39.9050, lon: 116.3980, tags: ['广场','地标'] },
          ],
          hotels: [
            { name: '北京王府井希尔顿酒店', lat: 39.9120, lon: 116.4100, tags: ['五星','王府井'] },
            { name: '北京王府井漫心酒店', lat: 39.9140, lon: 116.4080, tags: ['中端','王府井'] },
            { name: '北京南锣鼓巷胡同民宿', lat: 39.9370, lon: 116.4000, tags: ['民宿','胡同'] },
          ],
          restaurants: [
            { name: '全聚德烤鸭店(前门店)', lat: 39.8980, lon: 116.3970, tags: ['烤鸭','中华老字号'] },
            { name: '东来顺饭庄(王府井店)', lat: 39.9140, lon: 116.4100, tags: ['涮肉','清真'] },
            { name: '护国寺小吃店', lat: 39.9280, lon: 116.3800, tags: ['小吃','京味'] },
          ],
        },
      },
      {
        keywords: ['上海','shanghai'],
        data: {
          attractions: [
            { name: '上海迪士尼乐园', lat: 31.1430, lon: 121.6580, tags: ['主题乐园','亲子'] },
            { name: '外滩', lat: 31.2400, lon: 121.4900, tags: ['滨江','地标'] },
            { name: '东方明珠', lat: 31.2390, lon: 121.5000, tags: ['电视塔','地标'] },
            { name: '豫园', lat: 31.2280, lon: 121.4920, tags: ['园林','古典'] },
            { name: '南京路步行街', lat: 31.2350, lon: 121.4760, tags: ['商业街','购物'] },
          ],
          hotels: [
            { name: '上海和平饭店', lat: 31.2370, lon: 121.4880, tags: ['传奇','外滩'] },
            { name: '上海浦东丽思卡尔顿', lat: 31.2380, lon: 121.5000, tags: ['奢华','陆家嘴'] },
            { name: '上海南京路亚朵S酒店', lat: 31.2330, lon: 121.4750, tags: ['中高端','南京路'] },
          ],
          restaurants: [
            { name: '上海老饭店(豫园店)', lat: 31.2270, lon: 121.4900, tags: ['本帮菜','老字号'] },
            { name: '小南国(日月光店)', lat: 31.2100, lon: 121.4750, tags: ['本帮菜','精致'] },
            { name: '鼎泰丰(兴业太古汇店)', lat: 31.2250, lon: 121.4680, tags: ['小笼包','台式'] },
          ],
        },
      },
      {
        keywords: ['巴厘岛','bali','印尼'],
        data: {
          attractions: [
            { name: '乌布皇宫(Puri Saren)', lat: -8.5069, lon: 115.2614, tags: ['皇宫','历史文化'] },
            { name: '海神庙(Tanah Lot)', lat: -8.6210, lon: 115.0870, tags: ['海上寺庙','日落'] },
            { name: '德格拉朗梯田', lat: -8.5030, lon: 115.2800, tags: ['梯田','田园'] },
            { name: '京打马尼火山', lat: -8.2900, lon: 115.3800, tags: ['火山','日出'] },
            { name: '库塔海滩(Kuta Beach)', lat: -8.7180, lon: 115.1690, tags: ['海滩','冲浪'] },
            { name: '圣泉寺(Tirta Empul)', lat: -8.4200, lon: 115.3100, tags: ['寺庙','净化仪式'] },
          ],
          hotels: [
            { name: '乌布 Hanging Gardens', lat: -8.4500, lon: 115.2700, tags: ['豪华','丛林泳池'] },
            { name: '库塔 The Ritz-Carlton', lat: -8.7800, lon: 115.1660, tags: ['奢华','海滩'] },
            { name: '水明漾 W Resort & Spa', lat: -8.7200, lon: 115.1400, tags: ['设计酒店','时尚'] },
          ],
          restaurants: [
            { name: 'Bebek Bengil Dirty Duck', lat: -8.5060, lon: 115.2640, tags: ['脏鸭餐','乌布必吃'] },
            { name: 'Ibu Oka Babi Guling', lat: -8.5070, lon: 115.2620, tags: ['烤乳猪','巴厘传统'] },
            { name: 'La Lucciola', lat: -8.7170, lon: 115.1550, tags: ['意大利','海景'] },
          ],
        },
      },
      {
        keywords: ['东京','tokyo','日本东京'],
        data: {
          attractions: [
            { name: '浅草寺(Senso-ji)', lat: 35.7148, lon: 139.7967, tags: ['寺庙','东京最古老'] },
            { name: '东京塔(Tokyo Tower)', lat: 35.6586, lon: 139.7454, tags: ['地标','夜景'] },
            { name: '明治神宫(Meiji Jingu)', lat: 35.6764, lon: 139.6993, tags: ['神社','森林'] },
            { name: '皇居(Kokyo)', lat: 35.6852, lon: 139.7528, tags: ['皇宫','日式庭园'] },
            { name: '涩谷十字路口', lat: 35.6595, lon: 139.7004, tags: ['地标','购物'] },
            { name: '东京迪士尼乐园', lat: 35.6329, lon: 139.8804, tags: ['主题乐园','亲子'] },
          ],
          hotels: [
            { name: '东京帝国酒店', lat: 35.6750, lon: 139.7580, tags: ['传奇','银座'] },
            { name: '东京安缦(Aman Tokyo)', lat: 35.6770, lon: 139.7580, tags: ['奢华','大手町'] },
            { name: '新宿格兰贝尔酒店', lat: 35.6920, lon: 139.7050, tags: ['中端','交通便利'] },
          ],
          restaurants: [
            { name: '数寄屋桥次郎寿司', lat: 35.6720, lon: 139.7660, tags: ['寿司','米其林三星'] },
            { name: '一风堂拉面(新宿店)', lat: 35.6900, lon: 139.7020, tags: ['拉面','博多风味'] },
            { name: '筑地场外市场', lat: 35.6650, lon: 139.7700, tags: ['海鲜','新鲜刺身'] },
          ],
        },
      },
      {
        keywords: ['曼谷','bangkok','泰国曼谷'],
        data: {
          attractions: [
            { name: '大皇宫(Grand Palace)', lat: 13.7500, lon: 100.4910, tags: ['皇宫','佛教'] },
            { name: '卧佛寺(Wat Pho)', lat: 13.7460, lon: 100.4930, tags: ['寺庙','卧佛'] },
            { name: '郑王庙(Wat Arun)', lat: 13.7430, lon: 100.4890, tags: ['寺庙','黎明寺'] },
            { name: '乍都乍周末市场', lat: 13.8000, lon: 100.5500, tags: ['集市','购物'] },
            { name: '湄南河游船', lat: 13.7500, lon: 100.4900, tags: ['河流','观光'] },
          ],
          hotels: [
            { name: '曼谷半岛酒店', lat: 13.7420, lon: 100.5020, tags: ['奢华','湄南河畔'] },
            { name: '曼谷文华东方', lat: 13.7440, lon: 100.5040, tags: ['传奇','河景'] },
            { name: '素坤逸55号Grande Centre Point', lat: 13.7300, lon: 100.5700, tags: ['中高端','商务区'] },
          ],
          restaurants: [
            { name: '建兴酒坊(Somboon Seafood)', lat: 13.7150, lon: 100.5570, tags: ['咖喱蟹','米其林'] },
            { name: 'Thipsamai Pad Thai', lat: 13.6570, lon: 100.5020, tags: ['泰式炒粉','老字号'] },
            { name: 'Jeh O Chula Mom\'s Noodle', lat: 13.7320, lon: 100.5330, tags: ['船面','深夜食堂'] },
          ],
        },
      },
      {
        keywords: ['巴黎','paris','法国巴黎'],
        data: {
          attractions: [
            { name: '埃菲尔铁塔(Tour Eiffel)', lat: 48.8584, lon: 2.2945, tags: ['地标','铁塔'] },
            { name: '卢浮宫(Musée du Louvre)', lat: 48.8606, lon: 2.3376, tags: ['博物馆','艺术'] },
            { name: '巴黎圣母院(Cathédrale Notre-Dame)', lat: 48.8530, lon: 2.3499, tags: ['教堂','哥特式'] },
            { name: '凯旋门(Arc de Triomphe)', lat: 48.8738, lon: 2.2950, tags: ['纪念碑','拿破仑'] },
            { name: '蒙马特高地(Sacré-Cœur)', lat: 48.8867, lon: 2.3431, tags: ['教堂','艺术区'] },
          ],
          hotels: [
            { name: '巴黎丽兹酒店(Ritz Paris)', lat: 48.8660, lon: 2.3230, tags: ['传奇','旺多姆'] },
            { name: '巴黎Le Bristol', lat: 48.8680, lon: 2.3150, tags: [' palace','奥赛'] },
            { name: '蒙马特艺术家公寓', lat: 48.8850, lon: 2.3400, tags: ['民宿','艺术区'] },
          ],
          restaurants: [
            { name: 'Le Comptoir du Panthéon', lat: 48.8460, lon: 2.3450, tags: ['法餐','经典小酒馆'] },
            { name: 'L\'As du Fallafel', lat: 48.8560, lon: 2.3650, tags: ['中东','玛莱区'] },
            { name: 'Café de Flore', lat: 48.8530, lon: 2.3330, tags: ['咖啡馆','左岸文化'] },
          ],
        },
      },
    ];

    for (const entry of db) {
      if (entry.keywords.some(k => q.includes(k.toLowerCase()))) {
        const makePOI = (
          item: { name: string; lat: number; lon: number; tags: string[] },
          type: string
        ): RawPOI => ({
          id: `known-${item.name}-${Date.now()}`,
          name: item.name,
          latitude: item.lat,
          longitude: item.lon,
          address: `${destName} · ${item.tags[0] || ''}`,
          type,
          rating: 4.3 + Math.random() * 0.6,
          tags: item.tags,
          raw: { source: 'known-poi-db', destination: destName },
        });

        return {
          attractions: entry.data.attractions.map(a => makePOI(a, 'attraction')),
          hotels: entry.data.hotels.map(h => makePOI(h, 'hotel')),
          restaurants: entry.data.restaurants.map(r => makePOI(r, 'restaurant')),
        };
      }
    }

    return null; // 未找到匹配
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
        signal: AbortSignal.timeout(20000),
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
      // 优先从已知目的地坐标表查找（本地未命中过，此处作最终兜底）
      const known = this.findKnownCoordinates(query);
      if (known) {
        console.log(`[OSM] 使用已知坐标: ${known.name} [${known.center.longitude}, ${known.center.latitude}]`);
        return { center: known.center, displayName: known.name };
      }
      // 最终兜底：中国中心
      return { center: { latitude: 30.584, longitude: 104.067 }, displayName: query };
    }
  }

  /**
   * 已知目的地坐标表（当OSM地理编码不可用时的兜底）
   * 覆盖国内外热门旅游目的地
   */
  private findKnownCoordinates(query: string): { name: string; center: Coordinates } | null {
    const q = query.toLowerCase().replace(/\s+/g, '');
    const destinations: Array<{ name: string; keywords: string[]; center: Coordinates }> = [
      // 国内热门
      { name: '云南大理', keywords: ['大理','云南大理','dali'], center: { latitude: 25.6904, longitude: 100.1595 } },
      { name: '云南丽江', keywords: ['丽江','云南丽江','lijiang'], center: { latitude: 26.872, longitude: 100.236 } },
      { name: '北京', keywords: ['北京','beijing','北平'], center: { latitude: 39.916, longitude: 116.397 } },
      { name: '上海', keywords: ['上海','shanghai','沪'], center: { latitude: 31.230, longitude: 121.473 } },
      { name: '杭州', keywords: ['杭州','hangzhou'], center: { latitude: 30.274, longitude: 120.155 } },
      { name: '成都', keywords: ['成都','chengdu'], center: { latitude: 30.658, longitude: 104.065 } },
      { name: '西安', keywords: ['西安','xian','长安'], center: { latitude: 34.261, longitude: 108.940 } },
      { name: '厦门', keywords: ['厦门','xiamen','鹭岛'], center: { latitude: 24.479, longitude: 118.089 } },
      { name: '三亚', keywords: ['三亚','sanya','海南'], center: { latitude: 18.252, longitude: 109.518 } },
      { name: '桂林', keywords: ['桂林','guilin'], center: { latitude: 25.274, longitude: 110.299 } },
      { name: '拉萨', keywords: ['拉萨','lhasa','西藏'], center: { latitude: 29.650, longitude: 91.132 } },
      { name: '青岛', keywords: ['青岛','qingdao'], center: { latitude: 36.067, longitude: 120.382 } },
      { name: '重庆', keywords: ['重庆','chongqing'], center: { latitude: 29.563, longitude: 106.551 } },
      { name: '南京', keywords: ['南京','nanjing'], center: { latitude: 32.058, longitude: 118.797 } },
      { name: '苏州', keywords: ['苏州','suzhou'], center: { latitude: 31.298, longitude: 120.585 } },
      { name: '长沙', keywords: ['长沙','changsha'], center: { latitude: 28.195, longitude: 112.970 } },
      { name: '张家界', keywords: ['张家界','zhangjiajie'], center: { latitude: 29.117, longitude: 110.485 } },
      { name: '哈尔滨', keywords: ['哈尔滨','harbin'], center: { latitude: 45.804, longitude: 126.536 } },
      { name: '武汉', keywords: ['武汉','wuhan'], center: { latitude: 30.584, longitude: 114.299 } },
      { name: '广州', keywords: ['广州','guangzhou'], center: { latitude: 23.129, longitude: 113.264 } },
      { name: '深圳', keywords: ['深圳','shenzhen'], center: { latitude: 22.543, longitude: 114.058 } },
      { name: '香港', keywords: ['香港','hongkong','hk'], center: { latitude: 22.278, longitude: 114.169 } },
      { name: '澳门', keywords: ['澳门','macau'], center: { latitude: 22.198, longitude: 113.543 } },
      { name: '台北', keywords: ['台北','taipei','台湾'], center: { latitude: 25.033, longitude: 121.565 } },
      { name: '昆明', keywords: ['昆明','kunming'], center: { latitude: 25.041, longitude: 102.712 } },
      // 国外热门
      { name: '日本东京', keywords: ['东京','tokyo','日本东京'], center: { latitude: 35.689, longitude: 139.692 } },
      { name: '日本大阪', keywords: ['大阪','osaka','日本大阪'], center: { latitude: 34.694, longitude: 135.502 } },
      { name: '日本京都', keywords: ['京都','kyoto','日本京都'], center: { latitude: 35.011, longitude: 135.768 } },
      { name: '泰国曼谷', keywords: ['曼谷','bangkok','泰国曼谷'], center: { latitude: 13.756, longitude: 100.502 } },
      { name: '泰国普吉岛', keywords: ['普吉岛','phuket','泰国普吉'], center: { latitude: 7.881, longitude: 98.392 } },
      { name: '韩国首尔', keywords: ['首尔','seoul','韩国首尔'], center: { latitude: 37.566, longitude: 126.978 } },
      { name: '新加坡', keywords: ['新加坡','singapore','狮城'], center: { latitude: 1.352, longitude: 103.819 } },
      { name: '马来西亚吉隆坡', keywords: ['吉隆坡','kl','kualalumpur'], center: { latitude: 3.139, longitude: 101.687 } },
      { name: '越南岘港', keywords: ['岘港','danang','越南岘港'], center: { latitude: 16.054, longitude: 108.220 } },
      { name: '印尼巴厘岛', keywords: ['巴厘岛','bali','印尼巴厘岛','印尼'], center: { latitude: -8.409, longitude: 115.188 } },
      { name: '马尔代夫', keywords: ['马尔代夫','maldives'], center: { latitude: 4.175, longitude: 73.510 } },
      { name: '法国巴黎', keywords: ['巴黎','paris','法国巴黎'], center: { latitude: 48.856, longitude: 2.352 } },
      { name: '意大利罗马', keywords: ['罗马','rome','意大利罗马'], center: { latitude: 41.903, longitude: 12.496 } },
      { name: '英国伦敦', keywords: ['伦敦','london','英国伦敦'], center: { latitude: 51.507, longitude: -0.128 } },
      { name: '美国纽约', keywords: ['纽约','newyork','ny'], center: { latitude: 40.713, longitude: -74.006 } },
      { name: '澳大利亚悉尼', keywords: ['悉尼','sydney','澳洲悉尼'], center: { latitude: -33.869, longitude: 151.209 } },
      { name: '阿联酋迪拜', keywords: ['迪拜','dubai'], center: { latitude: 25.204, longitude: 55.270 } },
      { name: '土耳其伊斯坦布尔', keywords: ['伊斯坦布尔','istanbul','土耳其'], center: { latitude: 41.008, longitude: 28.978 } },
      { name: '埃及开罗', keywords: ['开罗','cairo','埃及'], center: { latitude: 30.044, longitude: 31.235 } },
    ];

    for (const d of destinations) {
      if (d.keywords.some(k => q.includes(k))) {
        return { name: d.name, center: d.center };
      }
    }
    return null;
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

    // 并行请求所有镜像，使用首个成功（HTTP 200 + JSON + 有 elements）
    const attempts = OSM_OVERPASS_BASES.map(async (base) => {
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: `data=${encodeURIComponent(overpassQL)}`,
          signal: AbortSignal.timeout(OVERPASS_REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.warn(`[Overpass] ${new URL(base).host} HTTP ${res.status}`);
          return null;
        }
        const elements = await tryParseElements(res);
        if (elements && elements.length > 0) {
          return { base, elements };
        }
        return null;
      } catch {
        // 单个镜像失败静默忽略（已通过超时/连接错误竞争胜出的其他镜像会接管）
        return null;
      }
    });

    const results = await Promise.all(attempts);
    const winner = results.find(r => r && r.elements && r.elements.length > 0);
    if (!winner) {
      console.warn('[Overpass] 所有镜像均不可用，触发合成数据降级');
      return [];
    }

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
   * 根据偏好对POI进行重排序（不删除，只把更匹配的放前面）
   */
  private rankPOIsByPreferences(
    attractions: RawPOI[],
    hotels: RawPOI[],
    restaurants: RawPOI[],
    prefs: TripPreferences
  ): { attractions: RawPOI[]; hotels: RawPOI[]; restaurants: RawPOI[] } {
    const score = (poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): number => {
      const hay = `${poi.name} ${(poi.tags || []).join(' ')}`.toLowerCase();
      let s = this.effectiveRating(poi, type); // 本地评论聚合分混合（媒体库优先）
      if (type === 'hotel') {
        if (prefs.seaside && /(海|滩|湾|beach|bay|coast|seaside|ocean)/i.test(hay)) s += 5;
        if (prefs.pool && /(泳池|游泳池|pool|swimming)/i.test(hay)) s += 4;
        if (prefs.kids && /(亲子|家庭|儿童|kid|family)/i.test(hay)) s += 2;
        if (prefs.elderly && /(无障碍|电梯|安静|elevator|accessible)/i.test(hay)) s += 2;
        if (prefs.hotelTier === 'luxury' && /(豪华|五星|resort|residence)/i.test(hay)) s += 3;
        if (prefs.hotelTier === 'budget' && /(青旅|民宿|客栈|经济|hostel)/i.test(hay)) s += 3;
      } else if (type === 'restaurant') {
        if (prefs.cuisine) {
          const re = new RegExp(prefs.cuisine, 'i');
          if (re.test(hay)) s += 4;
        }
        if (prefs.seaside && /(海|海景|beach|seafood|海鲜)/i.test(hay)) s += 2;
      } else if (type === 'attraction') {
        if (prefs.activities) s += 2; // 想看"有什么好玩的" → 把景点都前置
        if (prefs.seaside && /(海|滩|湾|岛|beach|coast|reef|dive|潜水|冲浪)/i.test(hay)) s += 3;
        if (prefs.kids && /(乐园|动物园|主题|family|amusement|zoo)/i.test(hay)) s += 2;
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
    pricingCtx: import('./pricing-service.js').PricingContext
  ): Promise<{ days: PlannedDay[]; pois: POISummary[] }> {
    const allPois: POISummary[] = [];

    const toSummary = (poi: RawPOI, type: 'attraction' | 'hotel' | 'restaurant'): POISummary => ({
      id: poi.id, name: poi.name, type,
      latitude: poi.latitude, longitude: poi.longitude,
      address: poi.address, rating: poi.rating ?? 4.5,
      cost: poi.tags?.[0], description: poi.tags?.join(','),
      splatUrl: poi.splatUrl,
    });
    attractions.forEach(a => allPois.push(toSummary(a, 'attraction')));
    hotels.forEach(h => allPois.push(toSummary(h, 'hotel')));
    restaurants.forEach(r => allPois.push(toSummary(r, 'restaurant')));

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
     * 第一步：确定每天访问序列（酒店→上午景点→午餐→下午景点→晚餐）。
     * 午/晚餐先按位置锚定（午餐靠上午最后景点、晚餐靠下午最后景点），时间后面统一排。
     */
    interface DaySequence {
      date: string;
      hotel?: RawPOI;
      entries: Array<{ kind: 'attraction' | 'lunch' | 'dinner'; poi: RawPOI }>;
    }
    const sequences: DaySequence[] = [];
    for (let i = 0; i < dayCount; i++) {
      const date = new Date(new Date(startDate).getTime() + i * 86400000).toISOString().split('T')[0] ?? startDate;
      const dayAttrs = clusteredDays[i] || [];
      const morningCount = Math.ceil(dayAttrs.length / 2);
      const morningAttrs = dayAttrs.slice(0, morningCount);
      const afternoonAttrs = dayAttrs.slice(morningCount);

      const entries: DaySequence['entries'] = [];
      for (const attr of morningAttrs) entries.push({ kind: 'attraction', poi: attr });

      // 午餐：靠近上午最后一个景点（顺路用餐）
      if (dedupedRestaurants.length > 0 && dayAttrs.length > 0) {
        const lunchRef = morningAttrs.length > 0
          ? morningAttrs[morningAttrs.length - 1]!
          : primaryHotel ?? null;
        if (lunchRef) {
          const lunchRest = this.pickRestaurantOnRoute(dedupedRestaurants, lunchRef.latitude, lunchRef.longitude, usedRestaurantIds, preferences, restaurantUsageCount);
          if (lunchRest) {
            usedRestaurantIds.add(lunchRest.id);
            restaurantUsageCount.set(lunchRest.id, (restaurantUsageCount.get(lunchRest.id) || 0) + 1);
            entries.push({ kind: 'lunch', poi: lunchRest });
          }
        }
      }

      for (const attr of afternoonAttrs) entries.push({ kind: 'attraction', poi: attr });

      // 晚餐：靠近下午最后一个景点（顺路用餐）
      if (dedupedRestaurants.length > 0) {
        const dinnerRef = afternoonAttrs.length > 0
          ? afternoonAttrs[afternoonAttrs.length - 1]!
          : (entries.length > 0 ? entries[entries.length - 1]!.poi : primaryHotel ?? null);
        if (dinnerRef) {
          const dinnerRest = this.pickRestaurantOnRoute(dedupedRestaurants, dinnerRef.latitude, dinnerRef.longitude, usedRestaurantIds, preferences, restaurantUsageCount);
          if (dinnerRest) {
            usedRestaurantIds.add(dinnerRest.id);
            restaurantUsageCount.set(dinnerRest.id, (restaurantUsageCount.get(dinnerRest.id) || 0) + 1);
            entries.push({ kind: 'dinner', poi: dinnerRest });
          }
        }
      }

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
          // 当天预算：装不下就丢掉该景点（之后所有景点同样丢弃），晚餐仍保留
          if (lastPoint && currentTimeMin + transportMin + visitMin > PlanningService.DAY_END_MIN) {
            dayFull = true;
            legsFallback = true;
            continue;
          }
          const item = this.convertToItemSync(entry.poi, 'attraction', seq.date, formatTime(currentTimeMin), preferences, travelInfo, pricingCtx);
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
      const distScore = Math.max(0, 100 - dist * 1.5);
      // 评分采用本地评论聚合分混合（无本地评论时退回默认 4.0 口径）
      const blended = this.effectiveRating(r, 'restaurant');
      const ratingScore = (blended > 0 ? blended : 4.0) * 5;
      let prefScore = 0;
      const hay = `${r.name} ${(r.tags || []).join(' ')}`.toLowerCase();
      if (prefs.cuisine) {
        const re = new RegExp(prefs.cuisine, 'i');
        if (re.test(hay)) prefScore += 15;
      }
      if (prefs.seaside && /(海|海景|beach|seafood|海鲜)/i.test(hay)) prefScore += 8;
      if (prefs.budget === 'low' && /(小吃|快餐|平价|local|经济)/i.test(hay)) prefScore += 5;
      if (prefs.budget === 'high' && /(精致|高档|fine|dining|luxury)/i.test(hay)) prefScore += 5;

      const usePenalty = (usageCount?.get(r.id) || 0) * 10;
      const totalScore = distScore * 0.6 + ratingScore * 0.25 + prefScore - usePenalty;
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

  private generateDescription(poi: RawPOI, type: string, prefs: TripPreferences = { raw: [], seaside: false, pool: false, activities: false, kids: false, elderly: false, pace: 'balanced', activityMix: 'mixed', sources: { seaside: 'default', pool: 'default', activities: 'default', kids: 'default', elderly: 'default', pace: 'default', activityMix: 'default', budget: 'default', cuisine: 'default', hotelTier: 'default' } }): string {
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
