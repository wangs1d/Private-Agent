/**
 * 内置 Skill：旅游规划（travel.*）
 *
 * 来源：3D-Travel 项目的人工智能行程规划引擎（规则引擎 + POI 缓存 + 目的地知识库）
 * 被本项目 agent 直接接管：用户表达出行需求时，agent 调用以下 skill 完成规划。
 *
 * 能力组：
 *   - travel.plan-itinerary   主入口：生成完整行程（按天拆分景点/酒店/餐厅/交通/价格）
 *   - travel.search-poi       浏览目的地 POI（景点/酒店/餐厅）
 *   - travel.destination-info 目的地实用信息（签证/货币/最佳季节/应急等）
 *   - travel.compute-route    两点间交通计算
 *
 * 数据流：缓存优先 → 网络实时搜索（高德/OSM，失败自动降级）→ 内置知识库/合成兜底。
 */
import type { SkillDefinition } from "../types.js";
import type { PlanningService } from "./travel-planning-service.js";
import { travelItineraryStore } from "./travel-itinerary-store.js";
import { travelPlanStore } from "./travel-plan-store.js";

type Deps = {
  travelPlanningService: PlanningService;
};

/**
 * 生成结果中按天行程的摘要（LLM 工具返回值）。
 *
 * 瘦身原则：本返回值会整体进入 LLM 上下文。行程明细（按天条目/时间/坐标/
 * 图片/评论/价格/贴士）一律不下发——前端经 travelItineraryStore →
 * travel_itinerary 卡结构化直读完整数据并展开双面板，全程不经过 LLM。
 * LLM 只需要知道「规划成功了、大致是什么」：目的地/天数/日期/总花费 +
 * 少量亮点名（让口头转述自然），外加展示指令（禁止复述 JSON/逐条罗列）。
 * 5 天行程可省数千 token/轮。
 */
function summarizeItinerary(result: unknown): Record<string, unknown> {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, error: "规划引擎未返回有效结果" };
  const days = Array.isArray(r.days) ? (r.days as Array<Record<string, unknown>>) : [];
  // 亮点：每天前 2 个条目名（只取名字，无任何明细），总量封顶 10 个
  const highlights: string[] = [];
  for (const day of days) {
    const items = Array.isArray(day?.items) ? (day.items as Array<Record<string, unknown>>) : [];
    for (const it of items.slice(0, 2)) {
      if (highlights.length >= 10) break;
      const name = typeof it?.name === "string" ? it.name.trim() : "";
      if (name) highlights.push(name);
    }
    if (highlights.length >= 10) break;
  }
  const pricing = r.pricingSummary as Record<string, unknown> | null | undefined;
  const totalFinal = Number(pricing?.totalFinal);
  return {
    ok: true,
    id: r.id,
    title: r.title,
    destination: r.destination,
    startDate: r.startDate,
    endDate: r.endDate,
    dayCount: days.length,
    ...(Number.isFinite(totalFinal) && totalFinal > 0 ? { totalCost: Math.round(totalFinal) } : {}),
    ...(highlights.length > 0 ? { highlights } : {}),
    displayNote:
      "完整行程已生成，前端会自动展开行程卡（双面板规划界面）向用户展示全部明细，" +
      "且卡片会保留在回复中供用户随时回看。" +
      "请勿在回复中复述 JSON、逐条罗列行程或重复任何明细数据；" +
      "用一两句话自然告知用户行程已排好（目的地/天数/亮点一句带过）即可。",
  };
}

export function createTravelPlanningBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { travelPlanningService } = deps;

  /** 1. 生成完整行程（主入口） */
  const plan_itinerary: SkillDefinition = {
    metadata: {
      name: "travel.plan-itinerary",
      version: "1.0.0",
      displayName: "生成旅游行程规划",
      description:
        "根据用户的目的地、天数与偏好生成完整结构化行程：按天拆分景点/酒店/餐厅，含时间安排、交通衔接、建议游览时长、小贴士、预订提示与价格汇总。" +
        "当用户提出「帮我规划去X的行程」「去X玩几天怎么安排」「X旅游攻略」「X自由行」等出行需求时调用。" +
        "参数：input 为自然语言需求（如「去成都玩5天，喜欢美食和古迹，预算中等」）；destination 可显式指定目的地；days 指定天数；preferences 为偏好标签数组。" +
        "若 input 已含目的地/天数/偏好则无需重复传参。生成后可配合 travel.destination-info 补充签证/货币等实用信息。",
      kind: "builtin",
      tags: ["travel", "行程规划", "旅游", "攻略", "itinerary", "自由行", "出行"],
      icon: "🗺️",
      parameters: [
        { name: "input", type: "string", required: true, description: "用户自然语言需求（如「去成都玩5天，喜欢美食和古迹」）" },
        { name: "destination", type: "string", required: false, description: "目的地（如 成都/大理/东京），input 已含时可不传" },
        { name: "days", type: "number", required: false, description: "行程天数，默认 3" },
        { name: "preferences", type: "array", required: false, description: "偏好标签数组（如 ['美食','古迹','亲子']）" },
      ],
      outputSchema: {
        ok: "是否成功",
        id: "行程 ID",
        title: "行程标题",
        destination: "目的地",
        startDate: "开始日期 YYYY-MM-DD",
        endDate: "结束日期 YYYY-MM-DD",
        days: "按天行程 [{date, items:[{itemId,type,name,startTime,latitude,longitude,priceInfo,...}]}]",
        pois: "行程涉及 POI 摘要列表",
        travelInfo: "目的地实用信息",
        pricingSummary: "价格汇总",
      },
      permissions: ["network:external"],
      // 冷启动（缓存未命中：地理编码+POI搜索）仍需 10~30s，保留 120s；
      // 图片/评论/视频已改为本地媒体库直读 + 后台离线回填，不再占用请求时间
      timeoutMs: 120_000,
    },
    handler: async (input) => {
      const rawInput = typeof input.input === "string" ? input.input.trim() : "";
      if (!rawInput) {
        return { ok: false, error: "缺少必填参数 input：请描述出行需求，如「去成都玩5天，喜欢美食和古迹」" };
      }
      try {
        const result = await travelPlanningService.generateItinerary({
          input: rawInput,
          destination: typeof input.destination === "string" && input.destination.trim() ? input.destination.trim() : undefined,
          days: typeof input.days === "number" && input.days > 0 ? input.days : undefined,
          preferences: Array.isArray(input.preferences) ? input.preferences.filter((p): p is string => typeof p === "string") : undefined,
        });
        // 写入结构化行程数据桥：travel_itinerary 卡前端可直接消费，无需文本正则
        travelItineraryStore.set({
          toolName: "travel.plan-itinerary",
          ts: Date.now(),
          planId: String(result.id ?? ""),
          destination: result.destination,
          title: result.title,
          startDate: result.startDate ?? "",
          endDate: result.endDate ?? "",
          days: (result.days ?? []).map((day) => ({
            date: day.date ?? "",
            items: (day.items ?? []).map((item) => ({
              type: item.type,
              name: item.name,
              startTime: item.startTime ?? item.name,
              latitude: item.latitude,
              longitude: item.longitude,
              address: item.address ?? "",
              priceInfo: item.priceInfo ?? "",
              description: item.description ?? "",
              tips: item.tips,
              images: item.images,
              splatUrl: item.splatUrl,
              reviews: item.reviews,
              videos: item.videos,
            })),
          })),
        });
        // 冷层落盘：完整明细按 planId 持久化，供跨轮/跨重启的 travel.get-itinerary
        // 按需回查；LLM 上下文只留 summarizeItinerary 的极简回执
        travelPlanStore.save({
          planId: String(result.id ?? ""),
          destination: result.destination,
          title: result.title,
          startDate: result.startDate ?? "",
          endDate: result.endDate ?? "",
          requestInput: rawInput,
          preferences: Array.isArray(input.preferences)
            ? input.preferences.filter((p): p is string => typeof p === "string")
            : undefined,
          totalCost: (result as { pricingSummary?: { totalFinal?: number } }).pricingSummary
            ?.totalFinal,
          days: (result.days ?? []).map((day) => ({
            date: day.date ?? "",
            items: (day.items ?? []).map((item) => ({
              type: item.type,
              name: item.name,
              startTime: item.startTime ?? item.name,
              latitude: item.latitude,
              longitude: item.longitude,
              address: item.address ?? "",
              priceInfo: item.priceInfo ?? "",
              description: item.description ?? "",
              tips: item.tips,
              images: item.images,
              splatUrl: item.splatUrl,
              reviews: item.reviews,
              videos: item.videos,
            })),
          })),
        });
        return summarizeItinerary(result);
      } catch (err) {
        return {
          ok: false,
          error: `行程规划失败：${err instanceof Error ? err.message : String(err)}`,
          hint: "可换个表达方式描述目的地/天数/偏好后重试，或先用 travel.search-poi 确认目的地支持情况",
        };
      }
    },
  };

  /** 2. 浏览目的地 POI */
  const search_poi: SkillDefinition = {
    metadata: {
      name: "travel.search-poi",
      version: "1.0.0",
      displayName: "搜索目的地景点/酒店/餐厅",
      description:
        "搜索指定目的地的景点、酒店、餐厅三类 POI（含名称/评分/地址/坐标，命中缓存直接返回，未命中自动实时搜索并缓存）。" +
        "当用户想了解「X 有什么好玩的/好吃的/住的」或在规划前查看目的地的 POI 候选时调用。可与 travel.plan-itinerary 配合使用。",
      kind: "builtin",
      tags: ["travel", "POI", "景点", "酒店", "餐厅", "目的地", "搜索"],
      icon: "📍",
      parameters: [
        { name: "destination", type: "string", required: true, description: "目的地名称（如 成都/大理/东京）" },
        { name: "type", type: "string", required: false, enum: ["attraction", "hotel", "restaurant"], description: "只返回指定类型 POI" },
      ],
      outputSchema: {
        destination: "目的地",
        center: "中心坐标",
        attractions: "景点列表 [{id,name,latitude,longitude,address,rating,tags}]",
        hotels: "酒店列表",
        restaurants: "餐厅列表",
        fromCache: "是否命中缓存",
      },
      permissions: ["network:external"],
      timeoutMs: 30_000,
    },
    handler: async (input) => {
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      if (!destination) {
        return { ok: false, error: "缺少必填参数 destination" };
      }
      try {
        const type = typeof input.type === "string" ? input.type : undefined;
        const result = await travelPlanningService.searchDestination(destination, type as any);
        const pick = (list: Array<Record<string, unknown>>) =>
          list.slice(0, 20).map((p) => ({
            id: p.id,
            name: p.name,
            latitude: p.latitude,
            longitude: p.longitude,
            address: p.address,
            rating: p.rating,
            tags: p.tags,
          }));
        return {
          ok: true,
          destination: result.destination,
          center: result.center,
          count: {
            attractions: result.attractions.length,
            hotels: result.hotels.length,
            restaurants: result.restaurants.length,
          },
          attractions: type && type !== "attraction" ? [] : pick(result.attractions as any),
          hotels: type && type !== "hotel" ? [] : pick(result.hotels as any),
          restaurants: type && type !== "restaurant" ? [] : pick(result.restaurants as any),
          fromCache: result.fromCache,
        };
      } catch (err) {
        return { ok: false, error: `POI 搜索失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  /** 3. 目的地实用信息 */
  const destination_info: SkillDefinition = {
    metadata: {
      name: "travel.destination-info",
      version: "1.0.0",
      displayName: "查询目的地实用信息",
      description:
        "查询目的地的实用出行信息：签证类型、货币汇率、时区、语言、电压插座、最佳旅行季节、紧急电话、海关禁忌与旅行小贴士。" +
        "当用户询问「去X需要签证吗」「X 用什么货币」「X 最佳旅游时间」「X 有什么注意事项」或规划行程后需要补充目的地常识时调用。",
      kind: "builtin",
      tags: ["travel", "签证", "货币", "最佳季节", "时差", "目的地", "攻略"],
      icon: "🛂",
      parameters: [
        { name: "destination", type: "string", required: true, description: "目的地名称（如 巴厘岛/东京/巴黎）" },
      ],
      outputSchema: {
        ok: "是否成功",
        destination: "目的地",
        visa: "签证要求 {required,type,notes}",
        currency: "货币 {name,code,symbol,rateToCNY}",
        timezone: "时区 {name,offset}",
        language: "主要语言数组",
        voltage: "电压",
        socket: "插座类型",
        bestSeason: "最佳季节 {months,description}",
        emergency: "紧急联系电话",
        customs: "海关/习俗禁忌",
        tips: "旅行小贴士数组",
      },
      permissions: [],
      timeoutMs: 10_000,
    },
    handler: async (input) => {
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      if (!destination) {
        return { ok: false, error: "缺少必填参数 destination" };
      }
      try {
        const info = await travelPlanningService.getDestinationInfo(destination);
        return { ok: true, ...info };
      } catch (err) {
        return { ok: false, error: `目的地信息查询失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  /** 4. 两点间交通计算 */
  const compute_route: SkillDefinition = {
    metadata: {
      name: "travel.compute-route",
      version: "1.0.0",
      displayName: "计算两点间交通",
      description:
        "计算两个地点之间的交通方式、预计耗时与距离。" +
        "from/to 支持「地名」（自动地理编码）或「纬度,经度」坐标。当用户询问「从A到B多远/多久」「两个景点之间怎么走」时调用。",
      kind: "builtin",
      tags: ["travel", "交通", "路线", "距离", "耗时", "route"],
      icon: "🚗",
      parameters: [
        { name: "from", type: "string", required: true, description: "起点（地名或「纬度,经度」）" },
        { name: "to", type: "string", required: true, description: "终点（地名或「纬度,经度」）" },
      ],
      outputSchema: {
        ok: "是否成功",
        mode: "交通方式（walking/driving/transit/cycling/taxi）",
        durationMin: "预计耗时（分钟）",
        distanceKm: "距离（公里）",
        note: "备注",
      },
      permissions: ["network:external"],
      timeoutMs: 15_000,
    },
    handler: async (input) => {
      const from = typeof input.from === "string" ? input.from.trim() : "";
      const to = typeof input.to === "string" ? input.to.trim() : "";
      if (!from || !to) {
        return { ok: false, error: "缺少必填参数 from 或 to" };
      }
      try {
        const result = await travelPlanningService.computeRoute(from, to);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: `交通计算失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  /** 5. 行程明细回查（冷层按需读取，替代把明细常驻上下文） */
  const get_itinerary: SkillDefinition = {
    metadata: {
      name: "travel.get-itinerary",
      version: "1.0.0",
      displayName: "回查已生成的行程明细",
      description:
        "按 planId 或目的地回查已生成的行程明细（分天条目：时间/名称/价格/地址/贴士）。" +
        "行程规划完成后对话中只保留摘要，用户追问行程细节（如「第一天住哪」「第二天怎么安排」「酒店多少钱」）" +
        "或要求调整某天安排时调用此工具按需读取。不传 day 返回逐天概览（条目名级），传 day 返回该天完整明细。" +
        "两者都不传时返回最近几份行程列表（供确认用户指的是哪份）。",
      kind: "builtin",
      tags: ["travel", "行程", "回查", "明细", "itinerary"],
      icon: "🔎",
      parameters: [
        { name: "planId", type: "string", required: false, description: "行程 ID（回执中的 id 字段，如 plan-1788076649218）" },
        { name: "destination", type: "string", required: false, description: "目的地（无 planId 时按目的地匹配最近一份）" },
        { name: "day", type: "number", required: false, description: "天序号（1 起）。传入时返回该天完整明细，否则返回逐天概览" },
      ],
      outputSchema: {
        ok: "是否成功",
        plan: "行程概要 {planId,title,destination,startDate,endDate,dayCount,totalCost}",
        days: "逐天概览 [{date, items:[{type,name,startTime,priceInfo}]}]（不传 day 时）",
        dayDetail: "单天完整明细（传 day 时）：{date, items:[…含地址/描述/贴士/坐标]}",
        hint: "展示提示",
      },
      permissions: [],
      timeoutMs: 5_000,
    },
    handler: async (input) => {
      const planId = typeof input.planId === "string" ? input.planId.trim() : "";
      const destination = typeof input.destination === "string" ? input.destination.trim() : "";
      const day = typeof input.day === "number" && input.day > 0 ? Math.floor(input.day) : 0;

      let plan = planId ? travelPlanStore.get(planId) : null;
      if (!plan && destination) plan = travelPlanStore.findByDestination(destination);
      if (!plan) {
        const recent = travelPlanStore.listSummaries(5);
        if (recent.length === 0) {
          return { ok: false, error: "还没有已保存的行程", hint: "可先用 travel.plan-itinerary 生成行程" };
        }
        return {
          ok: true,
          recentPlans: recent,
          hint: "未指定 planId/destination，以上是最近生成的行程列表；请确认后带上 planId 再查明细",
        };
      }

      const overview = {
        planId: plan.planId,
        title: plan.title,
        destination: plan.destination,
        startDate: plan.startDate,
        endDate: plan.endDate,
        dayCount: plan.days.length,
        ...(plan.totalCost != null ? { totalCost: plan.totalCost } : {}),
      };

      if (day > 0) {
        const d = plan.days[day - 1];
        if (!d) {
          return { ok: true, plan: overview, error: `只有 ${plan.days.length} 天，没有第 ${day} 天` };
        }
        return {
          ok: true,
          plan: overview,
          dayDetail: d,
          hint: "以上是完整天明细，仅用于回答用户本次追问；不要逐条复述，对话保持自然",
        };
      }

      // 概览：条目名级（不含描述/贴士/坐标），控制 token
      return {
        ok: true,
        plan: overview,
        days: plan.days.map((d) => ({
          date: d.date,
          items: d.items.map((it) => ({
            type: it.type,
            name: it.name,
            startTime: it.startTime,
            priceInfo: it.priceInfo,
          })),
        })),
        hint: "需要某天完整明细（地址/贴士/坐标）时带上 day 参数再调",
      };
    },
  };

  return [plan_itinerary, search_poi, destination_info, compute_route, get_itinerary];
}

/**
 * 注册旅游规划内置 Skills 到 SkillManager。
 */
export function registerTravelPlanningBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createTravelPlanningBuiltinSkills(deps)) {
    register(s);
  }
}