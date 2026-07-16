/** 子 Agent 类型 — 按能力维度划分（3 个核心） */
export type SubAgentType =
  | "life"
  | "tech"
  | "info";

export interface SubAgentResult {
  taskId: string;
  agentType: SubAgentType;
  success: boolean;
  result: string;
  metadata?: Record<string, unknown>;
  executionTime?: number;
}

export type BackgroundSubAgentStatus =
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed";

export type BackgroundSubAgentAction =
  | "confirm"
  | "retry"
  | "continue_processing";

/** 主 Agent 后台委派的子 Agent 任务（不阻塞当前 tool 批次）。 */
export interface BackgroundSubAgentJob {
  taskId: string;
  agentType: SubAgentType;
  agentName: string;
  sessionId: string;
  chatUserMessageId?: string;
  status: BackgroundSubAgentStatus;
  startedAt: number;
  completedAt?: number;
  taskDescription?: string;
  priorContext?: string;
  accessMode?: "sandbox" | "full";
  report?: string;
  error?: string;
  availableActions?: BackgroundSubAgentAction[];
}

export interface BackgroundSubAgentUpdate {
  taskId: string;
  agentType: SubAgentType;
  agentName: string;
  status: BackgroundSubAgentStatus;
  sessionId: string;
  chatUserMessageId?: string;
  startedAt: number;
  completedAt?: number;
  availableActions?: BackgroundSubAgentAction[];
  report?: string;
  error?: string;
  userFacingText: string;
}

export type RetryStrategy = "none" | "with_hint" | "simplify" | "reassign";

export interface SubAgentRetryConfig {
  enabled: boolean;
  maxAttempts: number;
  strategy: RetryStrategy;
  hintTemplate: (error: string, attempt: number) => string;
}

/**
 * Agent 角色标识：主 Agent 或某类子 Agent。
 * - "master"：主 Agent，既是消息发送方（指令/通知）也是监督方（看所有协作）
 * - SubAgentType：life/tech/info 等子 Agent
 */
export type AgentRole = SubAgentType | "master";

/**
 * 消息接收方：特定角色或广播。
 * - "broadcast"：所有 Agent（主 Agent + 所有子 Agent）都能看到
 * - AgentRole：点对点发给特定角色
 */
export type MessageRecipient = AgentRole | "broadcast";

export interface InterAgentMessage {
  id: string;
  fromAgent: AgentRole;
  /** 接收方：特定角色或 "broadcast"（所有 Agent 可见） */
  toAgent: MessageRecipient;
  content: string;
  timestamp: number;
  relatedTaskId?: string;
  /** 消息类型：handoff（接力）/ ask_peer（咨询）/ notice（通知）/ directive（指令） */
  kind?: "handoff" | "ask_peer" | "notice" | "directive";
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
  | "code_dev"         /** 代码开发：编写、调试、审查 */
  | "system_ops"       /** 系统运维：服务器、部署、API调试 */
  | "search_info"      /** 搜索调研：比价、查询、翻译（只查不买） */
  | "deep_rpa";        /** 深度RPA：多步复杂流程自动化 + 批量操作 + 长时间运行 */

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
  /**
   * 模型配置（可选）：
   * - modelOverride: 覆盖默认 chat 模型（如专用推理模型）
   *
   * 优先级：capability.modelConfig > 环境变量 SUBAGENT_<TYPE>_MODEL > 主 Agent 默认模型
   * 一般不在代码中硬编码（不同部署环境用不同模型），通过环境变量配置更灵活。
   * 此字段保留用于未来在 capability 中声明推荐模型。
   */
  modelConfig?: {
    modelOverride?: string;
  };
}

export interface SubTask {
  id: string;
  description: string;
  assignedAgent: SubAgentType;
  priority: number;
  dependencies: string[];
  estimatedComplexity: "low" | "medium" | "high";
  /**
   * 主 Agent 直接指令：告诉子 Agent 该怎么做（执行策略/约束/注意事项）。
   * 与 description（做什么）互补——description 是任务目标，directive 是执行方式。
   * 由主 Agent 在 master.invoke_sub_agent 调用时显式传入，体现主→子直接通信。
   */
  directive?: string;
}
