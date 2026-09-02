/**
 * 意图路由表（2026-09-02 架构收敛：分类与决策分离）。
 *
 * 根因回顾：此前路由器直接回答"走 fast 还是 complex"——模型在替架构做主，
 * 判错即静默失败，只能靠正则打地鼠。新契约：L1 分类器只在封闭意图标签集内
 * 做语义理解（输出标签+置信度），车道/工具束由这张**纯代码路由表**确定性映射
 * ——模型提案，代码裁决。每个标签的执行契约（车道/工具束/仲裁严格度）可测试、
 * 可观测、可演进：加新能力 = 加一行路由表 + 一组黄金用例，不动 prompt 主逻辑。
 */

export type IntentLabel =
  | "chat" // 寒暄/情绪/观点/闲聊，凭上下文即可答
  | "knowledge_qa" // 常识/知识问答，不依赖实时信息
  | "realtime_lookup" // 需外部实时信息：新闻/某人近况/最新消息/价格/热搜/比分
  | "media_retrieval" // 找图/照片/视频/壁纸
  | "action_write" // 写数据/有副作用：日程/提醒/发消息/下单
  | "multi_step_task" // 多步操作/软件设备操控/其他办事
  | "meta_capability"; // 问能力/系统状态

export const INTENT_LABELS: readonly IntentLabel[] = [
  "chat",
  "knowledge_qa",
  "realtime_lookup",
  "media_retrieval",
  "action_write",
  "multi_step_task",
  "meta_capability",
];

export type IntentLane = "fast" | "complex";
export type IntentToolset = "light" | "search" | "media" | "full";

export type IntentRoutePlan = {
  lane: IntentLane;
  /** 该意图应暴露的工具束（fast 已内置 light+search+media；complex 为全量） */
  toolset: IntentToolset;
  /** 出口仲裁严格度：strict = 无成功的实质工具结果即升级（防含糊收场） */
  arbiter: "strict" | "standard";
};

/**
 * 意图 → 执行契约路由表（唯一权威）。
 * realtime_lookup / media_retrieval 走 fast：搜索/媒体工具已在 fast 上下文
 * （链路 AnySearch 优先、多引擎兜底），配合 strict 出口仲裁保证"真的去搜"；
 * action_write / multi_step_task 涉及副作用或多步，下沉 complex 全量工具。
 */
export const INTENT_ROUTING_TABLE: Record<IntentLabel, IntentRoutePlan> = {
  chat: { lane: "fast", toolset: "light", arbiter: "standard" },
  knowledge_qa: { lane: "fast", toolset: "light", arbiter: "standard" },
  realtime_lookup: { lane: "fast", toolset: "search", arbiter: "strict" },
  media_retrieval: { lane: "fast", toolset: "media", arbiter: "strict" },
  action_write: { lane: "complex", toolset: "full", arbiter: "standard" },
  multi_step_task: { lane: "complex", toolset: "full", arbiter: "standard" },
  meta_capability: { lane: "fast", toolset: "light", arbiter: "standard" },
};

export function isIntentLabel(value: unknown): value is IntentLabel {
  return typeof value === "string" && (INTENT_LABELS as readonly string[]).includes(value);
}

export function routePlanForIntent(intent: IntentLabel): IntentRoutePlan {
  return INTENT_ROUTING_TABLE[intent];
}

/** 解析容错：宽松变体 → 规范标签（旧二值输出/近似词兼容）。 */
const INTENT_ALIASES: Record<string, IntentLabel> = {
  chat: "chat",
  fast: "chat",
  smalltalk: "chat",
  chitchat: "chat",
  knowledge: "knowledge_qa",
  knowledge_qa: "knowledge_qa",
  qa: "knowledge_qa",
  fact: "knowledge_qa",
  lookup: "realtime_lookup",
  realtime: "realtime_lookup",
  realtime_lookup: "realtime_lookup",
  search: "realtime_lookup",
  news: "realtime_lookup",
  media: "media_retrieval",
  media_retrieval: "media_retrieval",
  image: "media_retrieval",
  photo: "media_retrieval",
  write: "action_write",
  action: "action_write",
  action_write: "action_write",
  reminder: "action_write",
  schedule: "action_write",
  task: "multi_step_task",
  complex: "multi_step_task",
  multi_step: "multi_step_task",
  multi_step_task: "multi_step_task",
  desktop: "multi_step_task",
  meta: "meta_capability",
  meta_capability: "meta_capability",
  capability: "meta_capability",
};

/**
 * 解析 L1 分类器的结构化输出：`{"intent":"...","confidence":0.0~1.0}`。
 * 容错链：剥 [ts:] 前缀 → 截取首个 {...} → JSON.parse → 标签校验（含别名表）
 * → JSON 失败时降级为全文标签词扫描。任何路径失败返回 null（调用方降级词法层）。
 */
export function parseIntentJson(
  raw: string | undefined | null,
): { intent: IntentLabel; confidence: number } | null {
  const text = (raw ?? "")
    .replace(/^\[ts:[^\]]*\]\s*/gm, "")
    .trim();
  if (!text) return null;

  let parsed: { intent?: unknown; confidence?: unknown } | null = null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1)) as { intent?: unknown; confidence?: unknown };
    } catch {
      parsed = null;
    }
  }

  let intent: IntentLabel | null = null;
  let confidence = 0.75;

  const rawIntent = parsed?.intent;
  if (typeof rawIntent === "string") {
    const key = rawIntent.trim().toLowerCase();
    intent = isIntentLabel(key) ? key : (INTENT_ALIASES[key] ?? null);
  }
  if (!intent && parsed) {
    // JSON 合法但 intent 非法 → 仍尝试从全文扫描标签词
    intent = scanIntentWord(text);
    confidence = 0.5; // 非规范输出，置信度打折
  }
  if (!intent) {
    // JSON 整体失败 → 全文扫描（含旧二值输出的兼容）
    intent = scanIntentWord(text);
    if (intent) confidence = 0.5;
  }
  if (!intent) return null;

  const rawConfidence = parsed?.confidence;
  if (typeof rawConfidence === "number" && Number.isFinite(rawConfidence)) {
    confidence = Math.max(0, Math.min(1, rawConfidence));
  } else if (typeof rawConfidence === "string") {
    const n = Number(rawConfidence);
    if (Number.isFinite(n)) confidence = Math.max(0, Math.min(1, n));
  }
  return { intent, confidence };
}

/** 全文扫描首个出现的意图词（宽松降级路径）。 */
function scanIntentWord(text: string): IntentLabel | null {
  const lower = text.toLowerCase();
  for (const [alias, label] of Object.entries(INTENT_ALIASES)) {
    if (lower.includes(alias)) return label;
  }
  return null;
}
