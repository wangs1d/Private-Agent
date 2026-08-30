import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  travelPlanStore,
  type StoredTravelPlan,
} from "../../skills/travel-planning/travel-plan-store.js";
import { travelShareStore } from "../../skills/travel-planning/travel-share-store.js";
import {
  pricingService,
  formatQuotePriceInfo,
  type MemberTier,
  type BoundPlatform,
  type PriceQuote,
  type PricingContext,
} from "../../skills/travel-planning/pricing-service.js";
import type { PlanningService } from "../../skills/travel-planning/travel-planning-service.js";

/** 行程条目类型（与 PlanningService 的 POI 三分类一致） */
const POI_TYPES = ["attraction", "hotel", "restaurant"] as const;
type PoiType = (typeof POI_TYPES)[number];

/** 会员等级（pricing-service.MemberTier 的运行时枚举，用于请求校验） */
const MEMBER_TIERS = ["normal", "silver", "gold", "diamond", "platinum"] as const;

/** 绑定平台代码（pricing-service.PlatformCode 的运行时枚举） */
const PLATFORM_CODES = [
  "booking",
  "agoda",
  "trip",
  "ctrip",
  "fliggy",
  "meituan",
  "dianping",
  "klook",
  "kkday",
] as const;

/**
 * 纯字符串形式绑定平台时的默认账户等级（对齐各平台静态权益表的中档等级，
 * 折扣计算把 accountLevel 传给 pricing-service 的平台优惠匹配）。
 */
const DEFAULT_PLATFORM_LEVEL: Record<(typeof PLATFORM_CODES)[number], string> = {
  booking: "genius-1",
  agoda: "silver",
  trip: "silver",
  ctrip: "silver",
  fliggy: "F1",
  meituan: "yellow",
  dianping: "yellow",
  klook: "priority",
  kkday: "member",
};

// ======================== 请求 schema ========================

const indexParamsSchema = z.object({
  planId: z.string().min(1).max(80),
  dayIndex: z.coerce.number().int().min(0),
  itemIndex: z.coerce.number().int().min(0),
});

const planIdParamsSchema = z.object({
  planId: z.string().min(1).max(80),
});

/** 条目编辑：body 中出现的字段替换原条目对应字段（未出现的保留原值） */
const itemPatchSchema = z.object({
  type: z.enum(POI_TYPES).optional(),
  name: z.string().min(1).max(120).optional(),
  startTime: z.string().min(1).max(40).optional(),
  latitude: z.coerce.number().finite().optional(),
  longitude: z.coerce.number().finite().optional(),
  address: z.string().max(300).optional(),
  priceInfo: z.string().max(200).optional(),
  description: z.string().max(3000).optional(),
  tips: z.array(z.string().max(300)).max(9).optional(),
  images: z.array(z.string().max(1000)).max(20).optional(),
});

const commentSchema = z.object({
  comment: z.string().min(1).max(500),
});

const poiSearchQuerySchema = z.object({
  destination: z.string().min(1).max(80),
  type: z.enum(POI_TYPES),
  keyword: z.string().max(80).optional(),
});

/** 绑定平台：对象形式含账户等级（对齐 3D-Travel state.boundPlatforms），字符串形式按默认等级 */
const boundPlatformSchema = z.union([
  z.object({
    platform: z.enum(PLATFORM_CODES),
    accountLevel: z.string().min(1).max(40),
    displayName: z.string().max(60).optional(),
  }),
  z.enum(PLATFORM_CODES),
]);

const bookingSchema = z.object({
  memberTier: z.enum(MEMBER_TIERS).optional(),
  boundPlatforms: z.array(boundPlatformSchema).max(9).optional(),
});

/**
 * 行程路由域：面向前端行程面板的编辑/搜索/预订/分享能力（一比一移植 3D-Travel
 * 服务端部分）。数据源为 travelPlanStore 落盘的完整行程（planId 由
 * travel.plan-itinerary 生成并随 travel_itinerary 卡下发前端）。
 *
 * - 编辑：PATCH/DELETE 按天/条目索引修改；comment 端点「提意见换一个」——
 *   按原条目类型与坐标经规划引擎找同类替代 POI 并用 PricingService 重新计价。
 * - 搜索：GET /travel/poi-search 供单项编辑器搜索备选 POI。
 * - 预订：按酒店×晚数/门票×1/餐厅人均×1 逐项报价并汇总优惠。
 * - 分享：8 位分享码 ↔ planId 映射（travel-share-store 单文件持久化）。
 *
 * travelPlanningService 未装配时所有端点返回 503（仿 not enabled 模式）。
 */
export function registerTravelPlanRoutes(app: FastifyInstance, deps: { travelPlanningService?: PlanningService }): void {
  /** 统一 503：规划服务未装配。返回 false 表示已发送错误响应 */
  const requireService = (reply: FastifyReply): boolean => {
    if (!deps.travelPlanningService) {
      void reply.code(503).send({ ok: false, error: "规划服务未装配，行程路由域不可用" });
      return false;
    }
    return true;
  };

  /** 按 planId 取行程；不存在时发送 404 并返回 null */
  const requirePlan = (reply: FastifyReply, planId: string): StoredTravelPlan | null => {
    const plan = travelPlanStore.get(planId);
    if (!plan) {
      void reply.code(404).send({ ok: false, error: `行程不存在：${planId}` });
      return null;
    }
    return plan;
  };

  /** 按天/条目索引取条目；越界时发送 400 并返回 null */
  const requireItem = (
    reply: FastifyReply,
    plan: StoredTravelPlan,
    dayIndex: number,
    itemIndex: number,
  ): StoredTravelPlan["days"][number]["items"][number] | null => {
    const day = plan.days[dayIndex];
    const item = day?.items[itemIndex];
    if (!item) {
      void reply.code(400).send({
        ok: false,
        error: `索引越界：dayIndex=${dayIndex}（共 ${plan.days.length} 天），itemIndex=${itemIndex}`,
      });
      return null;
    }
    return item;
  };

  /** 用 PricingService 为条目报价（按类型选计价入口） */
  const quoteFor = (name: string, tags: string[], type: PoiType, ctx: PricingContext): PriceQuote => {
    if (type === "hotel") return pricingService.quoteHotel(name, tags, ctx);
    if (type === "attraction") return pricingService.quoteAttraction(name, tags, ctx);
    return pricingService.quoteRestaurant(name, tags, ctx);
  };

  /** 绑定平台入参 → pricing-service 的 BoundPlatform（字符串形式按默认账户等级） */
  const normalizePlatforms = (raw: z.infer<typeof bookingSchema>["boundPlatforms"]): BoundPlatform[] | undefined => {
    if (!raw || raw.length === 0) return undefined;
    return raw.map((p) =>
      typeof p === "string"
        ? { platform: p, accountLevel: DEFAULT_PLATFORM_LEVEL[p], displayName: p }
        : { platform: p.platform, accountLevel: p.accountLevel, displayName: p.displayName ?? p.platform },
    );
  };

  // ======================== 行程读取 ========================

  /** 行程摘要列表（新→旧，最多 20 份），供面板「我的行程」选择 */
  app.get("/travel/plans", async (_request, reply) => {
    if (!requireService(reply)) return;
    return { ok: true, plans: travelPlanStore.listSummaries(20) };
  });

  /** 端点自述清单（与其他路由域一致的自我描述） */
  app.get("/travel/plans/_meta", async () => ({
    domain: "travel-plan",
    endpoints: [
      "GET    /travel/plans                                行程摘要列表（≤20）",
      "GET    /travel/plans/:planId                        完整行程（404 若不存在）",
      "PATCH  /travel/plans/:planId/days/:dayIndex/items/:itemIndex   {type?,name?,startTime?,latitude?,longitude?,address?,priceInfo?,description?,tips?,images?}",
      "DELETE /travel/plans/:planId/days/:dayIndex/items/:itemIndex   删除条目",
      "POST   /travel/plans/:planId/days/:dayIndex/items/:itemIndex/comment   {comment} 提意见换一个",
      "GET    /travel/poi-search?destination=&type=&keyword=          单项编辑器备选搜索（≤8 条）",
      "POST   /travel/plans/:planId/booking                {memberTier?,boundPlatforms?} 预订报价",
      "POST   /travel/plans/:planId/share                  生成/复用 8 位分享码",
      "GET    /travel/share/:code                          按分享码读完整行程",
    ],
    note: "planId 来自 travel_itinerary 卡 travelPlan.planId；分享码读取使用独立前缀 /travel/share/:code 避免与 :planId 参数段歧义",
  }));

  /** 完整行程（前端双面板直读/编辑的权威数据源） */
  app.get<{ Params: { planId: string } }>("/travel/plans/:planId", async (request, reply) => {
    if (!requireService(reply)) return;
    const parsed = planIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const plan = requirePlan(reply, parsed.data.planId);
    if (!plan) return;
    return { ok: true, plan };
  });

  // ======================== 行程编辑 ========================

  /** 替换/微调单个条目：body 中出现的字段覆盖原值，直接返回更新后的完整 plan（顶层即 plan 对象） */
  app.patch<{ Params: { planId: string; dayIndex: string; itemIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items/:itemIndex",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const params = indexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const patch = itemPatchSchema.safeParse(request.body);
      if (!patch.success) {
        return reply.code(400).send({ ok: false, error: patch.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      const item = requireItem(reply, plan, params.data.dayIndex, params.data.itemIndex);
      if (!item) return;
      plan.days[params.data.dayIndex]!.items[params.data.itemIndex] = { ...item, ...patch.data };
      travelPlanStore.save(plan);
      return plan;
    },
  );

  /** 删除单个条目，直接返回更新后的完整 plan（顶层即 plan 对象） */
  app.delete<{ Params: { planId: string; dayIndex: string; itemIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items/:itemIndex",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const params = indexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      const item = requireItem(reply, plan, params.data.dayIndex, params.data.itemIndex);
      if (!item) return;
      plan.days[params.data.dayIndex]!.items.splice(params.data.itemIndex, 1);
      travelPlanStore.save(plan);
      return plan;
    },
  );

  /** 「提意见换一个」：按原条目类型与坐标找同类替代 POI，重新计价后替换（保留原 startTime），直接返回更新后的完整 plan */
  app.post<{ Params: { planId: string; dayIndex: string; itemIndex: string } }>(
    "/travel/plans/:planId/days/:dayIndex/items/:itemIndex/comment",
    async (request, reply) => {
      if (!requireService(reply)) return;
      const service = deps.travelPlanningService!;
      const params = indexParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: params.error.flatten() });
      }
      const body = commentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: body.error.flatten() });
      }
      const plan = requirePlan(reply, params.data.planId);
      if (!plan) return;
      const item = requireItem(reply, plan, params.data.dayIndex, params.data.itemIndex);
      if (!item) return;
      if (!(POI_TYPES as readonly string[]).includes(item.type)) {
        return reply.code(400).send({ ok: false, error: `该条目类型（${item.type}）不支持换一换` });
      }
      const type = item.type as PoiType;
      let poi;
      try {
        poi = await service.findAlternativePoi(type, item.latitude, item.longitude, item.name, body.data.comment);
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: `替代 POI 搜索失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!poi) {
        return reply.code(404).send({
          ok: false,
          error: "未找到可替换的同类地点：附近搜索无结果，请稍后重试或直接编辑条目内容",
        });
      }
      const quote = quoteFor(poi.name, poi.tags || [], type, {
        destination: plan.destination,
        preferences: {},
      });
      plan.days[params.data.dayIndex]!.items[params.data.itemIndex] = {
        ...item,
        type,
        name: poi.name,
        latitude: poi.latitude,
        longitude: poi.longitude,
        address: poi.address || item.address,
        priceInfo: formatQuotePriceInfo(quote),
        description: service.describePoi(poi, type),
        tips: item.tips,
        images: poi.images && poi.images.length > 0 ? poi.images : [],
        reviews: [],
        videos: [],
      };
      travelPlanStore.save(plan);
      return plan;
    },
  );

  // ======================== POI 搜索（单项编辑器） ========================

  /** 搜索目的地指定类型 POI 备选（≤8 条，含计价后的 priceInfo） */
  app.get("/travel/poi-search", async (request, reply) => {
    if (!requireService(reply)) return;
    const service = deps.travelPlanningService!;
    const parsed = poiSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { destination, type, keyword } = parsed.data;
    try {
      const pois = await service.searchPois(destination, type, keyword, 8);
      return { ok: true, pois };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: `POI 搜索失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ======================== 预订报价 ========================

  /**
   * 预订报价：从行程提取预订项——酒店 × 住宿晚数（plan.days 数）、景点门票 ×1、
   * 餐厅人均 ×1；逐项走 PricingService 报价（会员等级 + 绑定平台优惠）并汇总。
   */
  app.post<{ Params: { planId: string } }>("/travel/plans/:planId/booking", async (request, reply) => {
    if (!requireService(reply)) return;
    const params = planIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: params.error.flatten() });
    }
    const body = bookingSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: body.error.flatten() });
    }
    const plan = requirePlan(reply, params.data.planId);
    if (!plan) return;

    const ctx: PricingContext = {
      destination: plan.destination,
      preferences: {},
      memberTier: body.data.memberTier,
      boundPlatforms: normalizePlatforms(body.data.boundPlatforms),
    };
    const nights = Math.max(1, plan.days.length);
    const items: Array<{
      name: string;
      type: PoiType;
      unitPrice: number;
      count: number;
      originalPrice: number;
      finalPrice: number;
      /** 折扣标签数组（前端直接展示） */
      discounts: string[];
      /** 折扣明细（member/platformBenefits，调试与详情用） */
      discountDetail?: PriceQuote["breakdown"];
    }> = [];
    let totalOriginal = 0;
    let totalFinal = 0;
    for (const day of plan.days) {
      for (const item of day.items) {
        if (!(POI_TYPES as readonly string[]).includes(item.type)) continue;
        const type = item.type as PoiType;
        const quote = quoteFor(item.name, [], type, ctx);
        const count = type === "hotel" ? nights : 1;
        const originalPrice = quote.originalPrice * count;
        const finalPrice = quote.finalPrice * count;
        const labels: string[] = [];
        if (quote.breakdown?.member?.label) labels.push(quote.breakdown.member.label);
        for (const benefit of quote.breakdown?.platformBenefits ?? []) {
          if (benefit.label) labels.push(benefit.label);
        }
        items.push({
          name: item.name,
          type,
          // 折后单价（对齐 3D-Travel 展示口径：finalUnit × 数量）
          unitPrice: quote.finalPrice,
          count,
          originalPrice,
          finalPrice,
          discounts: labels,
          ...(labels.length > 0 ? { discountDetail: quote.breakdown } : {}),
        });
        totalOriginal += originalPrice;
        totalFinal += finalPrice;
      }
    }
    return {
      ok: true,
      items,
      totalOriginal,
      totalFinal,
      totalSaved: totalOriginal - totalFinal,
    };
  });

  // ======================== 分享 ========================

  /** 生成 8 位分享码（同一行程重复分享复用已有码） */
  app.post<{ Params: { planId: string } }>("/travel/plans/:planId/share", async (request, reply) => {
    if (!requireService(reply)) return;
    const params = planIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: params.error.flatten() });
    }
    const plan = requirePlan(reply, params.data.planId);
    if (!plan) return;
    return { ok: true, shareCode: travelShareStore.codeFor(plan.planId) };
  });

  /** 按分享码读完整行程（只读分享视图；独立前缀避免与 :planId 参数段匹配歧义） */
  app.get<{ Params: { code: string } }>("/travel/share/:code", async (request, reply) => {
    if (!requireService(reply)) return;
    const code = request.params.code.trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) {
      return reply.code(400).send({ ok: false, error: "分享码格式非法" });
    }
    const planId = travelShareStore.resolve(code);
    if (!planId) {
      return reply.code(404).send({ ok: false, error: `分享码无效：${code}` });
    }
    const plan = requirePlan(reply, planId);
    if (!plan) return;
    return { ok: true, plan };
  });
}
