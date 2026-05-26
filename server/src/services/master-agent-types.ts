/** 子 Agent 类型 — 按能力维度划分（5个核心） */

export type SubAgentType =
  | "life"
  | "tech"
  | "info"
  | "creative"
  | "security";

export interface SubAgentResult {
  taskId: string;
  agentType: SubAgentType;
  success: boolean;
  result: string;
  metadata?: Record<string, unknown>;
  executionTime?: number;
}

export type BackgroundSubAgentStatus = "running" | "completed" | "failed";

/** 主 Agent 后台委派的子 Agent 任务（不阻塞当前 tool 批次）。 */
export interface BackgroundSubAgentJob {
  taskId: string;
  agentType: SubAgentType;
  agentName: string;
  status: BackgroundSubAgentStatus;
  startedAt: number;
  completedAt?: number;
  report?: string;
  error?: string;
}

export type RetryStrategy = "none" | "with_hint" | "simplify" | "reassign";

export interface SubAgentRetryConfig {
  enabled: boolean;
  maxAttempts: number;
  strategy: RetryStrategy;
  hintTemplate: (error: string, attempt: number) => string;
}

export interface InterAgentMessage {
  id: string;
  fromAgent: SubAgentType;
  toAgent: SubAgentType;
  content: string;
  timestamp: number;
  relatedTaskId?: string;
}

export interface ParallelExecutionConfig {
  enabled: boolean;
  maxParallelTasks: number;
  dependencyDetection: boolean;
}

export interface SemanticDedupConfig {
  enabled: boolean;
  threshold: number;
  method: "jaccard" | "word_overlap";
}

/**
 * 高级能力标签 — 描述子Agent的业务能力维度
 *
 * 注意：视觉操控（desktop.visual.run_task）是**通用基础设施工具**，
 * 不属于任何特定Agent的专属能力。所有拥有 desktop/visual 工具白名单
 * 的子Agent都可以使用它，就像人类的所有角色都能"用眼睛看屏幕"一样。
 *
 * 区别仅在于使用的场景和深度：
 * - life: 偶尔用（订酒店时顺手操作一下网站）
 * - tech: 深度用（专门用它做复杂自动化流程、批量操作）
 */
export type AgentCapabilityTag =
  | "wallet"           /** 钱包操作：余额、转账、充值、交易记录 */
  | "purchase"         /** 消费购物：wallet.purchase 全50+类别通用 */
  | "social"           /** 社交交互：好友、消息、红包、动态 */
  | "daily_life"       /** 日常生活：天气、日程、提醒、闹钟 */
  | "entertainment"     /** 娱乐休闲：游戏、音乐、电影对局 */
  | "code_dev"         /** 代码开发：编写、调试、审查 */
  | "system_ops"       /** 系统运维：服务器、部署、API调试 */
  | "search_info"      /** 搜索调研：比价、查询、翻译（只查不买） */
  | "deep_rpa"        /** 深度RPA：多步复杂流程自动化 + 批量操作 + 长时间运行 */
  | "content_creation"  /** 内容创作：文案、策划、创意写作、PPT大纲 */
  | "security_audit";   /** 安全审计：风险检测、权限审批、异常拦截 */

export interface SubAgentCapability {
  type: SubAgentType;
  name: string;
  description: string;
  keywords: string[];
  /** 工具白名单：该子Agent可用的工具名前缀/关键词匹配 */
  tools: string[];
  /**
   * 能力标签：描述该子Agent的业务能力维度。
   *
   * 视觉操控（desktop.visual.run_task）不在标签中，
   * 因为它是通用基础设施，通过 tools 白名单控制访问权限。
   * 只要 tools 包含 "desktop"/"visual"，该Agent就能使用视觉操控。
   */
  capabilities: AgentCapabilityTag[];
}

export interface SubTask {
  id: string;
  description: string;
  assignedAgent: SubAgentType;
  priority: number;
  dependencies: string[];
  estimatedComplexity: "low" | "medium" | "high";
}
