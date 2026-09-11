/**
 * 任务路由类型与高精度闲聊短路（2026-09-05 双面架构，根源化收敛）。
 *
 * 设计契约（不再使用话题关键词做路由）：
 *   - "这轮需不需要工具"由 L1 语义意图分类器判定（llm-task-router），
 *     语义理解天然泛化到未出现过的表达（"比特币多少钱"无需价格词表）。
 *   - 本模块只保留两类话题无关的确定性信号：
 *       1) 高精度纯闲聊短路（锚定全文匹配的寒暄/口头禅——这类句子结构上
 *          不可能需要工具，可安全直答零成本）；
 *       2) 降级路径的保守原则（无法语义判定时，除高精度闲聊外一律落任务面——
 *          错放对话面 = 零工具静默失败，错放任务面只是慢一点）。
 *   - 判错的纠错不在路由层，而在执行出口：TurnOutcomeGate（任务面续波）与
 *     对话面误判转任务（agent-core），路由不需要一次判对。
 */

/** 执行车道：chat=对话面（直答/前台工具直办）；task=任务面（后台执行）。 */
export type LlmExecutionMode = "chat" | "task";

export type TurnPlane = import("./intent-router.js").TurnPlane;
export type TurnCapability = import("./intent-router.js").TurnCapability;
export type TurnTier = import("./intent-router.js").TurnTier;

export type RouteDecision = {
  reasons: string[];
  /** 是否需要对回复做短句分段（对话面分段，任务面信息性内容不分段）。 */
  segmentable: boolean;
  /** 语义路由识别的意图标签 + 置信度（降级路径可能缺省）。 */
  intent?: import("./intent-router.js").IntentLabel;
  confidence?: number;
  /** 执行平面：chat=对话面零工具直答；task=任务面后台执行。 */
  plane: TurnPlane;
  /** 任务面能力束（对话面为空数组）。 */
  capabilities: TurnCapability[];
  /** 任务面工具波预算（对话面 0）。 */
  budget: number;
  /** 模型档位。 */
  tier: TurnTier;
  /**
   * 语义路由顺带产出的轻量情绪/话题分析（与每轮路由 LLM 调用合并，
   * 省掉 MoodInferenceService 的独立每轮调用）。路由超时/降级/未产出时缺省，
   * 消费方（agent-core → mood-inference-service.ingestRouteAux）缺省时回退独立分析。
   */
  auxAnalysis?: {
    sentimentScore: number;
    emotionTags: string[];
    topics: string[];
  };
};

/** 由车道派生词法级执行计划（降级路径用）。 */
export function planFieldsForLane(lane: LlmExecutionMode): {
  plane: TurnPlane;
  capabilities: TurnCapability[];
  budget: number;
  tier: TurnTier;
} {
  return lane === "task"
    ? { plane: "task", capabilities: ["full"], budget: 2, tier: "flash" }
    : { plane: "chat", capabilities: [], budget: 0, tier: "flash" };
}

/* ────────────────────────────────────────────────────────────
 * 前台自决模式（2026-09-05 引入，2026-09-07 退役为「触发权威」）
 *
 * 失败模式已被实证：前台模型收到 task.dispatch/search_web schema 仍口头
 * 推脱（"这条路不通/翻不到"），触发是概率事件，出口词表闸永远慢一步。
 * 2026-09-07 前置路由门：「要不要办事」由 routeTurnByLlm 在主回复之前判定，
 * plane=task 由程序层确定性路由到任务执行器。前台白名单里的 task.dispatch
 * 保留为分类假阴性的安全网（+ 出口诚实闸/闪避闸兜底），不再是唯一触发路径。
 * isForegroundDispatchMode 现仅控制：标签协议灰度与前台人格指引选择。
 * ──────────────────────────────────────────────────────────── */

export function isForegroundDispatchMode(): boolean {
  const raw = process.env.AGENT_FOREGROUND_DISPATCH?.trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

/**
 * 遗留灰度：前台文本标签协议（[dispatch:...]，默认关闭）。
 *
 * 2026-09-06 P0 修复：前台默认回归原生 function calling（task.dispatch +
 * search_web 小工具集常驻，API 结构化 tool_calls 通道）。文本协议的失败模式
 * 是"模型不写标签 = 静默零工具"，无法在协议内修复，故退役为灰度回退项。
 * 设 AGENT_FOREGROUND_TAG_PROTOCOL=1 可回退旧行为（前台零工具 + 标签协议）。
 */
export function isForegroundTagProtocolEnabled(): boolean {
  const raw = process.env.AGENT_FOREGROUND_TAG_PROTOCOL?.trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}

/* ────────────────────────────────────────────────────────────
 * 任务面双通道（2026-09-05 前后台架构，先轻后重）
 *
 * 快速通道（默认起步）：跳过 planner，可见工具 = 桥工具（tool_discover/
 * tool_call），一切业务工具由 tool router（BM25 目录）按需召回——执行侧
 * 上下文零业务 schema，Flash 档单点查证直查直答。
 * 完整通道：快速通道产出道歉式/空 → 升级 planner + 预算波 + Pro 档。
 * 判定不在路由层：失败信号是执行结果本身（isApologyStyleFallback），由
 * 派发方（dispatchBackgroundTask）裁决升级。
 * ──────────────────────────────────────────────────────────── */

/** 延迟目录桥（元工具，不算业务工具）：快速通道可见集的构成。 */
export const TASK_TOOL_BRIDGE_NAMES: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_discover",
  "tool_describe",
  "tool_call",
]);

/* ────────────────────────────────────────────────────────────
 * 高精度纯闲聊短路（唯一保留的词法信号）
 *
 * 特征：锚定全文匹配（^...$）、命中即整句就是寒暄/口头禅/应答词——
 * 结构上不可能携带工具诉求，因此可以零 LLM 成本直判对话面。
 * 刻意不包含任何"话题词"（价格/天气/新闻/最新…），也不做长度+否定词
 * 的组合猜测——那类信号是词表打地鼠的根源，已全部删除。
 * ──────────────────────────────────────────────────────────── */

/** 整句问候/礼貌用语（多语言，锚定全文）。 */
const CHAT_ONLY_RE =
  /^(你好|hello|hi|hey|早上好|下午好|晚上好|谢谢|thanks|thank you|bye|再见|你是谁)[!！。.，,？?\s]*$/i;

/** 口头禅/应答词/情绪涂鸦（锚定全文）。 */
const CASUAL_CHAT_RE =
  /^(在吗|还在吗|哈哈|haha|lol|ok|okay|嗯|嗯嗯|欸|诶|哎|唉|哦|噢|喔|在|忙吗|睡了吗|吃了吗|收到|行|好|好嘞|好的|好的呀|好的呢|谢啦|谢谢啦|bye bye|晚安)[!！。.，,？?\s]*$/i;

/** 高长度上限：超长文本即使形似寒暄也不短路（防拼接绕过）。 */
const CHAT_SHORT_CIRCUIT_MAX_LEN = 16;

/**
 * 判断整条消息是否为高精度纯闲聊（可安全零工具直答）。
 * 仅供 L0 短路与降级路径使用——不承担"识别工具需求"的职责。
 */
export function isHighPrecisionChatText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > CHAT_SHORT_CIRCUIT_MAX_LEN) return false;
  return CHAT_ONLY_RE.test(t) || CASUAL_CHAT_RE.test(t);
}

/**
 * 判断回复是否需要做短句分段。
 * 对话面（闲聊/知识问答）分段模拟真人节奏；任务面（工具/搜索结果）不分段。
 */
export function determineSegmentable(plane: TurnPlane): boolean {
  return plane === "chat";
}
