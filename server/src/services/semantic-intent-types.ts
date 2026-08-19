/**
 * 语义意图解析结果。
 *
 * 基于 LLM 对用户消息的深度理解，输出结构化意图标签、实体、子意图，
 * 以及是否需要向用户澄清。结果 feed 给下游路由决策和工具选择。
 */

/** 提取的实体 */
export type IntentEntity = {
  type: string;   // 实体类型：time / location / person / amount / object / action / ...
  value: string;  // 实体值
};

/** 建议的短口语化澄清问题（面向用户） */
export type ClarificationQuestion = {
  question: string; // 如"你是想问天气，还是想设置提醒？"
  options?: string[]; // 可选候选项，如["查天气", "设置提醒"]
};

/** 意图类别 */
export type IntentCategory =
  | "query"          // 知识查询/信息检索
  | "command"        // 指令性操作（打开/执行/创建等）
  | "schedule"       // 日程/提醒设置
  | "chat"           // 纯闲聊/寒暄/情绪表达
  | "tool_call"      // 明确指定工具调用
  | "multi_step"     // 多步复杂任务
  | "clarification"  // 对上轮澄清的回答
  | "unknown";       // 无法确定

/** 语义意图解析结果 */
export type SemanticIntent = {
  /** 主意图摘要（一句话概括用户想做什么） */
  intent: string;
  /** 意图类别 */
  category: IntentCategory;
  /** 置信度 0-1 */
  confidence: number;
  /** 提取的实体列表 */
  entities: IntentEntity[];
  /** 子意图（复杂句子拆分） */
  subIntents: string[];
  /** 是否需要向用户澄清 */
  clarificationNeeded: boolean;
  /** 澄清问题（clarificationNeeded=true 时必填） */
  clarificationQuestion?: ClarificationQuestion;
  /** 建议的路由模式 */
  preferredMode: "fast" | "complex";
  /** 建议的工具域（如 "weather" / "calendar" / "desktop"） */
  preferredToolDomain?: string;
  /** 原始 LLM 返回文本（调试用） */
  raw?: string;
};

/** 语义意图解析服务契约 */
export interface SemanticIntentParser {
  parseIntent(
    sessionId: string,
    userText: string,
    context?: { previousIntent?: SemanticIntent; clarificationAnswer?: string },
  ): Promise<SemanticIntent>;
}