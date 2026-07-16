/**
 * Agent 自主任务状态机 - 数据模型定义
 *
 * 设计目标:脱离纯 Prompt 上下文管理任务进度,用外部持久化状态机做全局进度管理。
 * LLM 只负责:顶层任务拆解 + 每一步原子动作决策 + 反思纠错。
 * 状态机负责:整体流程调度、断点续跑、人工干预、重试。
 *
 * 状态流转:
 *   pending → planning → executing ↔ verifying → done
 *                                    ↓
 *                          awaiting_approval → executing (批准) / failed (拒绝)
 *                                    ↓
 *                                  failed (重试耗尽)
 *                                    ↓
 *                                  paused (人工暂停)
 */

/** 任务顶层状态 */
export type AgentTaskStatus =
  | "pending"          // 刚入队,等待开始
  | "planning"         // LLM 正在拆解子任务
  | "executing"        // 正在执行某一步原子动作
  | "verifying"        // 正在校验上一步结果
  | "awaiting_approval"// 等待人工审批(高危操作)
  | "done"             // 全部完成
  | "failed"           // 失败(重试耗尽或不可恢复)
  | "paused";          // 人工暂停

/** 子任务状态 */
export type SubTaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

/** 单个子任务 */
export interface SubTask {
  id: string;
  /** 子任务描述(自然语言,如"打开微信""在搜索框输入联系人名M") */
  description: string;
  status: SubTaskStatus;
  /** 已尝试次数(用于重试控制) */
  attempts: number;
  /** 最大尝试次数,默认 3 */
  maxAttempts: number;
  /** 最后一次错误信息 */
  lastError?: string;
  /** 完成时记录的结果摘要 */
  resultSummary?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/** 历史记录条目:记录每一轮 LLM 交互 */
export interface TaskHistoryEntry {
  /** 轮次序号(从 1 开始) */
  round: number;
  /** 当时所处的状态机阶段 */
  phase: AgentTaskStatus;
  /** 时间戳 ISO */
  timestamp: string;
  /** LLM 产出的文本(反思/规划/回复) */
  assistantText?: string;
  /** LLM 产出的工具调用(若有) */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** 工具执行结果 */
  toolResults?: Array<{
    id: string;
    name: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  /** 状态机迁移记录 */
  stateTransition?: {
    from: AgentTaskStatus;
    to: AgentTaskStatus;
    reason: string;
  };
  /** 注入给 LLM 的环境感知(截图描述/UIA 快照等) */
  environmentSnapshot?: string;
}

/** Agent 自主任务 */
export interface AgentTask {
  /** 任务 ID(唯一,用于持久化和查询) */
  id: string;
  /** 用户标识 */
  actorId: string;
  /** WS 会话 ID(用于事件回传) */
  sessionId: string;
  /** 触发任务的原始用户消息 ID */
  chatUserMessageId?: string;
  /** 用户原始目标(自然语言) */
  goal: string;
  /** 当前状态 */
  status: AgentTaskStatus;
  /** LLM 拆解出的子任务列表 */
  subtasks: SubTask[];
  /** 当前执行的子任务 ID */
  currentSubtaskId?: string;
  /** 已执行轮次(每轮 = 1次 LLM 调用) */
  currentRound: number;
  /** 最大轮次(防失控,默认 30) */
  maxRounds: number;
  /** 完整历史记录(每轮一条) */
  history: TaskHistoryEntry[];
  /** 是否需要人工审批(高危操作标志) */
  requiresApproval: boolean;
  /** 审批人(批准/拒绝的用户标识) */
  approvedBy?: string;
  /** 审批时间 */
  approvedAt?: string;
  /** 失败原因(状态为 failed 时) */
  error?: string;
  /** 全局重试次数 */
  retryCount: number;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 任务优先级(数字越小优先级越高,默认 10) */
  priority: number;
  /** 任务标签(用于分类,如"desktop_automation"/"research"/"coding") */
  tags: string[];
}

/** 持久化 JSON 文件结构 */
export interface AgentTaskPersistShape {
  tasks: Record<string, AgentTask>;
}

/** 创建任务的输入 */
export interface CreateAgentTaskInput {
  actorId: string;
  sessionId: string;
  chatUserMessageId?: string;
  goal: string;
  maxRounds?: number;
  priority?: number;
  tags?: string[];
}

/** 状态机迁移事件 */
export interface StateTransitionEvent {
  taskId: string;
  from: AgentTaskStatus;
  to: AgentTaskStatus;
  reason: string;
  timestamp: string;
  /** 附带的上下文(如错误信息、子任务 ID 等) */
  context?: Record<string, unknown>;
}

/** 任务进度事件(推送给前端) */
export interface TaskProgressEvent {
  taskId: string;
  actorId: string;
  sessionId: string;
  type:
    | "task_created"
    | "state_transition"
    | "subtask_started"
    | "subtask_completed"
    | "subtask_failed"
    | "round_started"
    | "round_completed"
    | "tool_call"
    | "tool_result"
    | "approval_required"
    | "approval_granted"
    | "approval_denied"
    | "task_completed"
    | "task_failed"
    | "log";
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** LLM 单轮调用的输入(状态机 → LLM) */
export interface LlmStepInput {
  /** 任务目标 */
  goal: string;
  /** 当前子任务描述(若已拆解) */
  currentSubtask?: SubTask;
  /** 已完成的子任务摘要 */
  completedSubtasks: string[];
  /** 剩余子任务摘要 */
  remainingSubtasks: string[];
  /** 最近 N 轮的历史摘要(压缩,不传完整内容) */
  recentHistory: string[];
  /** 当前环境感知(截图描述 / UIA 快照 / 进程列表等) */
  environmentSnapshot?: string;
  /** 当前是哪个阶段(planning / executing / verifying) */
  phase: AgentTaskStatus;
  /** 当前轮次 / 最大轮次 */
  roundInfo: { current: number; max: number };
}

/** LLM 单轮调用的输出(LLM → 状态机) */
export interface LlmStepOutput {
  /** LLM 产出的文本(反思 / 规划 / 回复) */
  text?: string;
  /** LLM 产出的工具调用(若有) */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** LLM 建议的状态迁移(可选,状态机可采纳或忽略) */
  suggestedTransition?: {
    to: AgentTaskStatus;
    reason: string;
  };
  /** LLM 拆解出的子任务(仅 planning 阶段) */
  plannedSubtasks?: string[];
  /** LLM 标记当前子任务完成(仅 executing/verifying 阶段) */
  markSubtaskDone?: boolean;
  /** LLM 标记整个任务完成 */
  markTaskDone?: boolean;
  /** LLM 请求人工审批(高危操作) */
  requestApproval?: {
    action: string;
    reason: string;
  };
}

/** 高危操作判定结果 */
export interface SafetyCheckResult {
  /** 是否高危 */
  isHighRisk: boolean;
  /** 高危原因 */
  reason?: string;
  /** 建议的处理方式 */
  action: "allow" | "require_approval" | "deny";
  /** 命中的规则名 */
  matchedRule?: string;
}
