/**
 * 工具结果 → 卡片注册表（B 阶段：结构化直出卡）。
 *
 * 解决「文本很难被触发」的另一半根因：带 schema 的工具结果不该依赖 LLM
 * 抄写成 markdown 列表再被正则猜回来。注册 builder 后，卡由代码从工具
 * 结构化回执**确定性构建**，LLM 的口头回复只作前导正文——LLM 写不写列表
 * 语法都不影响上卡。
 *
 * 与既有确定性路径的分工：
 *   - travel.plan-itinerary → attachTravelItineraryCard（双面板卡，含冷层回捞）
 *   - 媒体搜索 → mediaCards 结构化字段（chat.assistant_done 独立下发）
 *   - search 原始 JSON 回显 → detectRawSearchResultJson 抢救（未注册工具的兜底）
 * 新工具按需在 BUILDERS 注册即可，builder 返回 null（结构异常/空数据）时
 * 自动回退既有文本路由，零破坏。
 *
 * 卡 payload 与 AgentResultFormatter 的 AgentResultPayload 同构
 * （前端 agent_result_parser.dart / AgentResultCard 直接消费，无需前端改动）。
 */

/** 与 agent-result-formatter 的 items 类型推断一致：check/warn/num */
export interface ToolCardItem {
  type: "check" | "warn" | "num";
  text: string;
  /** 搜索结果卡等场景的跳转链接（前端 _SearchResultCard 整条可点击） */
  url?: string;
  source?: string;
  /** A/B 对比类条目的分侧标注 */
  side?: string;
  sideLabel?: string;
  /** product_compare 卡：分侧大图（商品图/试色图），随 side 标注归属 */
  image?: string;
}

export interface ToolCardPayload {
  title: string;
  items: ToolCardItem[];
  footer?: string;
  /** 前端 _SpecializedCard 的卡型：weather/schedule/wallet/order/file 或空串=通用 */
  cardType: string;
  /** product_compare 卡：分侧大图头部（A/B 两列并排，试色/商品图） */
  sides?: Array<{
    side: string;
    label: string;
    priceLabel?: string;
    image?: string;
  }>;
  /** product_compare 卡：参数对比（已转置：维度为行、sides 为列） */
  compare?: {
    dims: string[];
    rows: Array<{ label: string; values: string[] }>;
  };
  /** product_compare 卡：评测/试色视频入口 */
  videos?: Array<{ title: string; url?: string; source?: string }>;
}

type ToolCardBuilder = (result: Record<string, unknown>) => ToolCardPayload | null;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** ISO 时间「2026-09-10T08:00:00」→「09-10 08:00」；纯字符串截取，不经 Date，跨时区稳定 */
function shortTime(value: unknown): string {
  const raw = str(value);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return raw;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

const BUILDERS: Record<string, ToolCardBuilder> = {
  /**
   * search_web / info.search → search_result 卡（L1 确定性绑定）。
   *
   * 搜索是最高频的结构化工具，此前依赖 routeRender 的 search_result hint 从
   * LLM 修正文里切卡（模型写成散文就漏）；现在直接从工具回执 items 构建，
   * 模型口头回复只作前导。items 形态与 detectRawSearchResultJson 的抢救
   * 目标一致（title/url/snippet/source），前端 _SearchResultCard 直接消费。
   */
  "search_web": (r) => buildSearchCardFromItems(r.items),
  "info.search": (r) => buildSearchCardFromItems(r.items),

  /**
   * shopping.suggest → product_compare 卡（二分化对比）。
   * 候选按 side A/B/C 分侧（≤3）：sides 承载大图头部（商品图/试色图），
   * items 承载依据(check)与注意点(warn)并带 side/sideLabel 归属；
   * compare 承载转置参数表；videos 承载试色/评测视频入口。
   * 客户端 agent_result_parser 对 cardType=product_compare 消费以上字段。
   */
  "shopping.suggest": (r) => {
    const rec = r.recommendation as
      | {
          query?: unknown;
          candidates?: Array<{
            productId?: unknown;
            brand?: unknown;
            name?: unknown;
            priceLabel?: unknown;
            image?: unknown;
            reasons?: unknown;
            cautions?: unknown;
            videos?: unknown;
          }>;
          compare?: { dims?: unknown; rows?: unknown };
        }
      | undefined
      | null;
    if (!rec || !Array.isArray(rec.candidates) || rec.candidates.length === 0) return null;

    const sides: NonNullable<ToolCardPayload["sides"]> = [];
    const items: ToolCardItem[] = [];
    const videos: NonNullable<ToolCardPayload["videos"]> = [];
    const sideNames = ["A", "B", "C"];
    let index = 0;
    for (const c of rec.candidates.slice(0, 3)) {
      const side = sideNames[index] ?? String(index + 1);
      const brand = str(c.brand);
      const name = str(c.name);
      const label = [brand, name].filter(Boolean).join(" ") || `候选${index + 1}`;
      sides.push({
        side,
        label,
        priceLabel: str(c.priceLabel) || undefined,
        image: str(c.image) || undefined,
      });
      for (const t of (Array.isArray(c.reasons) ? c.reasons : []).filter((x) => typeof x === "string")) {
        items.push({ type: "check", text: t as string, side, sideLabel: label });
      }
      for (const t of (Array.isArray(c.cautions) ? c.cautions : []).filter((x) => typeof x === "string")) {
        items.push({ type: "warn", text: t as string, side, sideLabel: label });
      }
      for (const v of (Array.isArray(c.videos) ? c.videos : []).filter(
        (x): x is { title?: unknown; url?: unknown; source?: unknown } => typeof x === "object" && x !== null,
      )) {
        const title = str((v as { title?: unknown }).title);
        if (title) {
          videos.push({
            title,
            url: str((v as { url?: unknown }).url) || undefined,
            source: str((v as { source?: unknown }).source) || undefined,
          });
        }
      }
      index += 1;
    }

    // 参数对比（已由引擎转置：label=维度，values 与 sides 一一对应）
    const cmp = rec.compare;
    const compare =
      cmp && Array.isArray(cmp.dims) && Array.isArray(cmp.rows)
        ? {
            dims: cmp.dims.filter((d): d is string => typeof d === "string"),
            rows: cmp.rows
              .filter(
                (row): row is { label: string; values: string[] } =>
                  typeof row === "object" &&
                  row !== null &&
                  typeof (row as { label?: unknown }).label === "string" &&
                  Array.isArray((row as { values?: unknown }).values),
              )
              .map((row) => ({
                label: row.label,
                values: (row.values as unknown[]).filter((v): v is string => typeof v === "string"),
              })),
          }
        : undefined;

    const first = rec.candidates[0];
    const query = str(r.query) || str(r.item) || "选品";
    return {
      title:
        rec.candidates.length > 1
          ? `对比结论 · 二选一并排看`
          : `推荐结论 · ${first ? [str(first.brand), str(first.name)].filter(Boolean).join(" ") : query}`,
      cardType: "product_compare",
      sides,
      items,
      ...(compare && compare.rows.length > 0 ? { compare } : {}),
      ...(videos.length > 0 ? { videos } : {}),
      footer: "参数来自商品库，价格以实际渠道为准",
    };
  },

  "weather.get_local": (r) => {
    const weatherText = str(r.weatherText);
    const summary = str(r.summary);
    if (!weatherText && !summary) return null;
    const items: ToolCardItem[] = [];
    if (weatherText) items.push({ type: "num", text: weatherText });
    const range = str(r.todayRangeC);
    if (range) items.push({ type: "num", text: `气温 ${range}` });
    const humidity = num(r.humidityPct);
    if (humidity != null) items.push({ type: "num", text: `湿度 ${humidity}%` });
    const wind = num(r.windKmh);
    if (wind != null) items.push({ type: "num", text: `风速 ${wind} km/h` });
    const rain = num(r.peakRainPct);
    if (rain != null) items.push({ type: "num", text: `峰值降水概率 ${rain}%` });
    const location = str(r.locationLabel);
    return {
      title: summary || `${location ? location + " " : ""}天气实况`,
      items,
      footer: str(r.clothingAdvice) || undefined,
      cardType: "weather",
    };
  },

  "wallet.get_balance": (r) => {
    const balance = num(r.balance);
    if (balance == null) return null;
    const currency = str(r.currency) || "CNY";
    return {
      title: "钱包余额",
      items: [{ type: "num", text: `${balance} ${currency}` }],
      footer: str(r.summary) || undefined,
      cardType: "wallet",
    };
  },

  "calendar.list_tasks": (r) => {
    const tasks = Array.isArray(r.tasks) ? r.tasks : [];
    if (tasks.length === 0) return null;
    const items: ToolCardItem[] = tasks.slice(0, 8).map((t) => {
      const rec = (t ?? {}) as Record<string, unknown>;
      const title = str(rec.title) || str(rec.reminderMessage) || "（无标题）";
      const time = shortTime(rec.nextRunAt) || shortTime(rec.runAt);
      return { type: "num", text: time ? `${time} ${title}` : title };
    });
    const count = num(r.count) ?? tasks.length;
    return {
      title: "日程安排",
      items,
      footer: count > 8 ? `共 ${count} 项，仅显示前 8 项` : `共 ${count} 项`,
      cardType: "schedule",
    };
  },

  // 跨平台比价结果：组内最低价升序，每组一行「¥价格 [平台] 商品名（店铺）」
  "shopping.compare.prices": (r) => {
    const groups = Array.isArray(r.groups) ? r.groups : [];
    if (groups.length === 0) return null;
    const items: ToolCardItem[] = [];
    let shown = 0;
    for (const g of groups) {
      if (shown >= 8) break;
      const rec = (g ?? {}) as Record<string, unknown>;
      const offers = Array.isArray(rec.offers) ? rec.offers : [];
      if (offers.length === 0) continue;
      const best = (offers[0] ?? {}) as Record<string, unknown>;
      const price = num(best.priceCny);
      const platform = str(best.platform);
      const title = str(best.title);
      const shop = str(best.shop);
      const similar = rec.matchType === "similar" ? "（疑似同款）" : "";
      const priceText = price != null ? `¥${price}` : "价格待查";
      items.push({
        type: "num",
        text: `${priceText} [${platform || "未知平台"}] ${title.slice(0, 40)}${shop ? `（${shop.slice(0, 12)}）` : ""}${similar}`,
      });
      shown += 1;
    }
    if (items.length === 0) return null;
    const bestOffer = (r.bestOffer ?? {}) as Record<string, unknown>;
    const bestPlatform = str(bestOffer.platform);
    const bestPrice = num(bestOffer.priceCny);
    const footer =
      bestPrice != null && bestPlatform
        ? `最低价 ¥${bestPrice} 来自 ${bestPlatform} · 信息为平台实时抓取，以下单结算页为准`
        : "信息为平台实时抓取，以下单结算页为准";
    return {
      title: `比价结果：${str(r.query)}`,
      items,
      footer,
      cardType: "",
    };
  },

  // 本地订单列表：so_* 单号 + 状态 + 金额
  "shopping.order.list": (r) => {
    const orders = Array.isArray(r.orders) ? r.orders : [];
    if (orders.length === 0) return null;
    const statusLabel: Record<string, string> = {
      pending_payment: "待支付",
      paid: "已支付",
      shipped: "已发货",
      completed: "已完成",
      cancelled: "已取消",
      failed: "失败",
    };
    const items: ToolCardItem[] = orders.slice(0, 8).map((o) => {
      const rec = (o ?? {}) as Record<string, unknown>;
      const platform = str(rec.platform);
      const title = str(rec.title) || "（无标题）";
      const amount = num(rec.amountCny);
      const status = statusLabel[str(rec.status)] ?? (str(rec.status) || "未知");
      return {
        type: amount != null && amount > 0 ? "num" : "check",
        text: `[${platform}] ${title.slice(0, 36)} · ${status}${amount != null && amount > 0 ? ` ¥${amount}` : ""}`,
      };
    });
    const count = num(r.count) ?? orders.length;
    return {
      title: "购物订单",
      items,
      footer: count > 8 ? `共 ${count} 条，仅显示前 8 条` : `共 ${count} 条`,
      cardType: "order",
    };
  },
};

/** 搜索回执 items → search_result 卡 payload；空结果返回 null（回退文本路由） */
function buildSearchCardFromItems(rawItems: unknown): ToolCardPayload | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const items: ToolCardItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (items.length >= 8) break;
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const title = str(rec.title);
    const url = str(rec.url);
    if (!title && !url) continue;
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    const snippet = str(rec.snippet);
    const source = str(rec.source);
    const desc = [snippet, source ? `来源:${source}` : ""].filter(Boolean).join("  ");
    const text = desc ? `${title || url}: ${desc}` : title || url;
    items.push({ type: "num", text, url: url || undefined, source: source || undefined });
  }
  if (items.length === 0) return null;
  return {
    title: "搜索结果",
    items,
    footer: `共 ${items.length} 条结果`,
    cardType: "search_result",
  };
}

/** 查注册 builder；未注册返回 null */
export function lookupToolCardBuilder(toolName: string): ToolCardBuilder | null {
  return BUILDERS[toolName.trim()] ?? null;
}

/** 由结构化结果建卡 payload；结构异常/空数据返回 null（调用方回退文本路由） */
export function buildToolCard(
  toolName: string,
  result: Record<string, unknown>,
): ToolCardPayload | null {
  const builder = lookupToolCardBuilder(toolName);
  if (!builder) return null;
  try {
    return builder(result);
  } catch {
    return null;
  }
}

/**
 * 工具循环路径的天气结果确定性附卡（L1）。
 *
 * 与 attachSearchResultCardFromExecuted 同理：weather.get_local 已并入进程内
 * 延迟目录检索（不强制路由），常规对话轮 LLM 在 tool-loop 内自主调用天气工具，
 * 末轮只输出口语正文、reply.toolName 为空 → 单工具直跑路径的
 * processAssistantText({toolName,toolResult}) 拿不到回执，天气卡恒附不上
 * （真实回归：天气回答恒为纯文本）。这里从 onExternalToolExecuted 聚合的
 * 真实结果建 weather 卡；多次调用（多地对比）合并为一张多地卡，每个城市一行。
 * 正文已带结构化标记时不动（单工具直跑路径已附卡，防双重包裹）。
 */
export function attachWeatherResultCardFromExecuted(
  text: string,
  executed: ReadonlyArray<{ toolName: string; result: Record<string, unknown> }>,
): string {
  if (containsStructuredMarker(text)) return text;
  const weatherResults = executed
    .filter((mt) => mt.toolName === "weather.get_local")
    .map((mt) => mt.result);
  if (weatherResults.length === 0) return text;
  const payload =
    weatherResults.length === 1
      ? buildToolCard("weather.get_local", weatherResults[0])
      : buildMergedWeatherCard(weatherResults);
  if (!payload || payload.items.length === 0) return text;
  return buildCardMarker(payload, text);
}

/** 多次天气调用 → 一张多地 weather 卡：每个城市一行「地点 天气，气温」，建议取最后一条 */
function buildMergedWeatherCard(
  results: ReadonlyArray<Record<string, unknown>>,
): ToolCardPayload | null {
  const items: ToolCardItem[] = [];
  let title = "";
  let footer = "";
  for (const r of results) {
    const location = str(r.locationLabel);
    const weatherText = str(r.weatherText) || str(r.summary);
    const range = str(r.todayRangeC);
    const rain = num(r.peakRainPct);
    if (!weatherText && !range) continue;
    const parts = [weatherText, range ? `气温 ${range}` : ""].filter(Boolean);
    if (rain != null) parts.push(`降水 ${rain}%`);
    items.push({
      type: "num",
      text: `${location ? location + " " : ""}${parts.join("，")}`,
    });
    if (!title) title = str(r.summary) || (location ? `${location} 天气实况` : "天气实况");
    footer = str(r.clothingAdvice) || footer;
  }
  if (items.length === 0) return null;
  return {
    title: results.length > 1 ? "多地天气" : title,
    items,
    footer: footer || undefined,
    cardType: "weather",
  };
}

/**
 * 已带「卡片/摘要类」标记的正文不重复附卡（防双重包裹）。
 * 注意 [RENDER_AS:xxx]（structured/brief 等正文形态声明）**不在拦截集**：
 * 富文本正文 + 尾部来源卡是并存的正确形态（结构化回答不排斥附上搜索来源），
 * 此前整段拦截会让带意图词的搜索轮次永远丢卡（真实场景回归发现）。
 */
const STRUCTURED_MARKERS = [
  "[AGENT_RESULT_CARD_START]",
  "[CONTENT_SUMMARY_V2_START]",
  "[IMAGE_RESULT_START]",
];

function containsStructuredMarker(text: string): boolean {
  return STRUCTURED_MARKERS.some((m) => text.includes(m));
}

/** 与 agent-result-formatter 的 cardId 规则一致（cardType 非空才生成） */
function buildCardMarker(payload: ToolCardPayload, leadText: string): string {
  const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const json = JSON.stringify({
    avatar: "NB",
    avatarStyle: "default",
    title: payload.title,
    items: payload.items,
    footer: payload.footer ?? "",
    cardType: payload.cardType,
    actions: [],
    speak: "",
    cardId,
    // 扩展卡型的附加协议字段（product_compare 的分侧大图/转置对比表/视频入口）
    ...(payload.sides ? { sides: payload.sides } : {}),
    ...(payload.compare ? { compare: payload.compare } : {}),
    ...(payload.videos ? { videos: payload.videos } : {}),
  });
  const parts: string[] = [];
  if (leadText.trim()) parts.push(leadText.trim());
  parts.push(`[AGENT_RESULT_CARD_START]\n${json}\n[AGENT_RESULT_CARD_END]`);
  return parts.join("\n\n");
}

/**
 * 尝试把注册工具的结构化结果附卡到回复文本上。
 * 返回 null 表示未附卡（工具未注册/builder 建卡失败/正文已含结构化标记），
 * 调用方回退既有文本路由；返回值即最终文本（LLM 口头回复作前导 + 卡标记）。
 */
export function tryAttachToolResultCard(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string | null {
  if (!toolName || !toolResult || typeof toolResult !== "object") return null;
  if (!lookupToolCardBuilder(toolName)) return null;
  if (containsStructuredMarker(text)) return null;
  const payload = buildToolCard(toolName, toolResult);
  if (!payload || payload.items.length === 0) return null;
  return buildCardMarker(payload, text);
}

/**
 * 工具循环路径的搜索结果确定性附卡（L1）。
 *
 * tool-loop 内执行的 search_web/info.search 不经过 reply.toolName/toolResult
 * （与媒体/行程同理），必须从 onExternalToolExecuted 聚合的真实结果附卡。
 * 多次搜索的条目按 url 去重合并为一张 search_result 卡（上限 8 条），
 * 避免逐次附卡刷屏。正文已带结构化标记时不动（优先级让位给 L2/其他 L1 路径）。
 *
 * yieldToSearchMedia（意图仲裁，2026-09-22）：本轮搜索类媒体
 * （search_images/search_images_batch/search_videos）有真实产出时整卡让位——
 * 照片/视频已是本轮主形态，找图场景再附 8 条文字列表属冗余。媒体 0 产出时
 * 调用方不传该标志，文字卡照常附（兜底保证本轮仍有结构化结果）。
 */
export function attachSearchResultCardFromExecuted(
  text: string,
  executed: ReadonlyArray<{ toolName: string; result: Record<string, unknown> }>,
  opts?: { yieldToSearchMedia?: boolean },
): string {
  if (opts?.yieldToSearchMedia) return text;
  if (containsStructuredMarker(text)) return text;
  const searchResults = executed.filter((mt) =>
    mt.toolName === "search_web" || mt.toolName === "info.search",
  );
  if (searchResults.length === 0) return text;
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const mt of searchResults) {
    const items = Array.isArray(mt.result.items) ? mt.result.items : [];
    for (const it of items) {
      if (merged.length >= 12) break;
      const url = it && typeof it === "object" ? str((it as Record<string, unknown>).url) : "";
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      merged.push(it);
    }
  }
  const payload = buildSearchCardFromItems(merged);
  if (!payload || payload.items.length === 0) return text;
  return buildCardMarker(payload, text);
}
