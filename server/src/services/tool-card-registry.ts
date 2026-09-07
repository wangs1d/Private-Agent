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
}

export interface ToolCardPayload {
  title: string;
  items: ToolCardItem[];
  footer?: string;
  /** 前端 _SpecializedCard 的卡型：weather/schedule/wallet/order/file 或空串=通用 */
  cardType: string;
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
};

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

/** 已带结构化标记的正文不重复附卡（防双重包裹，与 travel/media 同语义） */
const STRUCTURED_MARKERS = [
  "[AGENT_RESULT_CARD_START]",
  "[CONTENT_SUMMARY_V2_START]",
  "[RENDER_AS:",
  "[DATA_BRIEF_START]",
  "[VIDEO_MEDIA_START]",
  "[CHAT_MEDIA_START]",
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
