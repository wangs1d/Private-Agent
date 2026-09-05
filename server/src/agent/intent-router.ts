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

// ── 双面架构路由契约（2026-09-05）──
// 路由不再回答"走哪个脑"，只回答"这轮的执行计划"：
//   plane        对话面（零工具直答）或 任务面（后台 plan-and-execute）
//   capabilities 任务面需要的能力束（对话面恒空）
//   budget       任务面工具波上限（对话面 0）
//   tier         模型档位（fast=Flash / complex=Pro）
// 旧二值车道字段（lane/toolset/arbiter）已随 fast/complex 双脑架构一起删除。
export type TurnPlane = "chat" | "task";
export type TurnCapability = "search" | "media" | "write" | "desktop" | "full";
export type TurnTier = "fast" | "complex";

export type IntentRoutePlan = {
  /** 执行平面：对话面（零工具）或任务面（后台执行） */
  plane: TurnPlane;
  /** 任务面能力束 */
  capabilities: TurnCapability[];
  /** 任务面工具波预算 */
  budget: number;
  /** 模型档位 */
  tier: TurnTier;
};

/**
 * 意图 → 执行契约路由表（唯一权威）。
 * 对话面（chat/knowledge_qa/meta_capability）：零工具直答，时间/位置走上下文注入。
 * 任务面：realtime_lookup/media_retrieval 轻预算单点执行（tier fast）；
 *         action_write/multi_step_task 全量能力 + 高预算（tier complex）。
 */
export const INTENT_ROUTING_TABLE: Record<IntentLabel, IntentRoutePlan> = {
  chat: { plane: "chat", capabilities: [], budget: 0, tier: "fast" },
  knowledge_qa: { plane: "chat", capabilities: [], budget: 0, tier: "fast" },
  realtime_lookup: { plane: "task", capabilities: ["search"], budget: 2, tier: "fast" },
  media_retrieval: { plane: "task", capabilities: ["media", "search"], budget: 2, tier: "fast" },
  action_write: { plane: "task", capabilities: ["full"], budget: 3, tier: "complex" },
  multi_step_task: { plane: "task", capabilities: ["full"], budget: 3, tier: "complex" },
  meta_capability: { plane: "chat", capabilities: [], budget: 0, tier: "fast" },
};

export function isIntentLabel(value: unknown): value is IntentLabel {
  return typeof value === "string" && (INTENT_LABELS as readonly string[]).includes(value);
}

export function routePlanForIntent(intent: IntentLabel): IntentRoutePlan {
  return INTENT_ROUTING_TABLE[intent];
}

/** 解析容错：宽松变体 → 规范标签（近似词兼容；旧二值输出已随双脑架构删除）。 */
const INTENT_ALIASES: Record<string, IntentLabel> = {
  chat: "chat",
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
