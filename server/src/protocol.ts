export type EventEnvelope = {
  type: string;
  payload: Record<string, unknown>;
};

export type WalletAction = "freeze" | "debit" | "refund" | "purchase";

export const ClientEventType = {
  SessionInit: "session.init",
  ChatUserMessage: "chat.user_message",
  /** 客户端「Agent 处理中」UI 显隐；false 时服务端锁定本轮，不再合并后续消息 */
  ChatAgentProcessingUi: "chat.agent_processing_ui",
  /** 客户端请求清除聊天历史（服务端同步清除 ChatThreadStore + 持久化） */
  ChatClearHistory: "chat.clear_history",
  WalletSimulateRequest: "wallet.simulate.request",
  /** AIP v0.1：结构化跨 Agent 消息（与工具 aip.dispatch 等价）。 */
  AipDispatch: "aip.dispatch",
  /** 电脑端桥接：若服务端配置了 DESKTOP_BRIDGE_TOKEN 则须提交；无 token 模式无需发送本事件 */
  DesktopBridgeRegister: "desktop.bridge.register",
  /** 电脑端桥接：执行完成后回传结果（与 desktop.bridge.invoke 的 jobId 对应）。 */
  DesktopBridgeResult: "desktop.bridge.result",
  /** 手机桥接注册：携带 PHONE_BRIDGE_TOKEN 验证 */
  PhoneBridgeRegister: "phone.bridge.register",
  /** 手机桥接：执行完成后回传结果（与 phone.bridge.invoke 的 jobId 对应）。 */
  PhoneBridgeResult: "phone.bridge.result",
  /** 用户发起虚拟电话呼叫Agent */
  VirtualPhoneUserCall: "phone.user_call_agent",
  /** 用户直接呼叫自己的Agent（无需输入ID，服务端从session推断） */
  VirtualPhoneCallMyAgent: "phone.call_my_agent",
  /** 用户对「其他 Agent 虚拟来电」的响应：接听 / 拒接 / 委托 Agent 代接 */
  VirtualPhoneIncomingResponse: "phone.incoming_response",
  /** 球形 Agent 具身交互：唤醒、发消息、聚焦聊天等 */
  AgentEmbodimentInteract: "agent.embodiment.interact",
  /** 客户端回报球形窗口在屏幕上的位置（配合 embodiment.observe 闭环） */
  AgentEmbodimentState: "agent.embodiment.state",
  /** 用户对主动联系的反馈，写回用户理解与联系偏好 */
  CompanionContactFeedback: "companion.contact_feedback",
  /** 心跳检测 */
  Ping: "ping",
} as const;

export const ServerEventType = {
  ChatAssistantChunk: "chat.assistant_chunk",
  ChatAssistantDone: "chat.assistant_done",
  /**
   * 即时确认应答：在多步/工具型请求开始处理时立即推送一段短文本，
   * 缓解用户等待焦虑。messageId 使用 `interim-${traceId}`，与正式回复的
   * `assistant-${traceId}` 解耦，客户端可独立渲染为"待办气泡"，在收到
   * 首条 chat.assistant_chunk 时自动让位。
   */
  ChatAssistantInterim: "chat.assistant_interim",
  /**
   * 「分阶段异步对话交互 v2」阶段 0：客户端在用户发消息的同一帧就应展示
   * 顶栏「正在思考…」占位 + 计时器。服务端在路由/委派开始时立即推一条，
   * 用于打点 T0（首字延迟测量起点）。
   */
  ChatTurnStarted: "chat.turn_started",
  /**
   * 「分阶段异步对话交互 v2」阶段 1：路由结束、意图已识别。
   * 携带 mode + 可选的 plan（plan_execute 拆解出的步骤）和 subAgents
   * （master_delegate 要派出的子 Agent 列表），让 UI 立刻渲染结构化骨架。
   */
  ChatIntentDetected: "chat.intent_detected",
  /**
   * 「分阶段异步对话交互 v2」阶段 2：执行事件流（多次）。
   * 替换此前的 chat.agent_status 自由文本，把工具调用 / 子 Agent 启停 /
   * 模型内部 thought 都按 kind 结构化下发，UI 按 kind 决定卡片样式。
   */
  ChatExecutionEvent: "chat.execution_event",
  /** 模型生成的口语化进度/状态行（如委派子 Agent），供客户端替代「思考中」 */
  ChatAgentStatus: "chat.agent_status",
  /** 日程/提醒任务已创建或更新，客户端应刷新日程视图 */
  ScheduleTasksChanged: "schedule.tasks_changed",
  /** 定时提醒到点触发（服务端调度器执行后推送） */
  ScheduleReminderFired: "schedule.reminder_fired",
  ToolCall: "tool.call",
  ToolResult: "tool.result",
  WalletSimulateResult: "wallet.simulate.result",
  AgentPeerMessage: "agent.peer_message",
  /** 每日天气简报（日程 weather_brief 触发，需已建立 WS session） */
  WeatherBrief: "weather.brief",
  /** Agent 自动化任务到点执行完成（需已建立 WS session 才能实时收到） */
  ScheduleAgentTaskFired: "schedule.agent_task_fired",
  /** Agent 虚拟电话来电（6 位号码线路；可含 TTS mp3 base64） */
  VirtualPhoneIncoming: "agent.phone.incoming",
  /** 虚拟电话通话状态变更（用户拨打Agent时的振铃/接通/挂断等） */
  VirtualPhoneCallStatus: "agent.phone.call_status",
  /**
   * 虚拟电话振铃开始事件 —— 前摇阶段首帧。
   * 客户端收到后应进入「振铃中」UI：播放振铃音、显示来电者信息、
   * 渐入动画、倒计时。此时不含 TTS 正文音频。
   * 随后服务端会推送 agent.phone.call_connecting 进入接通阶段。
   */
  VirtualPhoneRingingStart: "agent.phone.ringing_start",
  /**
   * 虚拟电话接通事件 —— 前摇结束，正式进入通话。
   * 包含 TTS 音频和正文 transcript。
   * 仅在 ringing_start 之后发送；若不需要前摇则直接发 incoming（向后兼容）。
   */
  VirtualPhoneCallConnecting: "agent.phone.call_connecting",
  /** 电脑端桥接绑定成功 */
  DesktopBridgeRegisterAck: "desktop.bridge.register_ack",
  /** 发往电脑端：执行一轮纯视觉桌面任务 */
  DesktopBridgeInvoke: "desktop.bridge.invoke",
  /** 手机端等与 userId 对齐的 WS：电脑桥接在线状态、最近桌面任务结果摘要 */
  DesktopBridgeSync: "desktop.bridge.sync",
  /** 手机桥接：绑定成功 */
  PhoneBridgeRegisterAck: "phone.bridge.register_ack",
  /** 发往手机端：执行远程控制命令 */
  PhoneBridgeInvoke: "phone.bridge.invoke",
  /** 手机桥接状态同步 */
  PhoneBridgeSync: "phone.bridge.sync",
  /** 球形 Agent 权威视觉状态（mood/energy/caption/委派 phase） */
  AgentEmbodimentPatch: "agent.embodiment.patch",
  /** 主 Agent 具身控制：3D 漫游、移动、停驻等（球形机器人身体） */
  AgentEmbodimentCommand: "agent.embodiment.command",
  ErrorEvent: "error.event",
  /** 晨间简报：调度器到点触发后推送 */
  MorningBriefing: "morning.briefing",
  /** Agent 推断的用户心情变化（实时通知） */
  MoodInferred: "mood.inferred",
  /** 心跳响应 */
  Pong: "pong",
} as const;

// ============================================================
// 「分阶段异步对话交互 v2」事件载荷类型
// ============================================================

/**
 * 阶段 0 载荷：路由开始打点。
 * - t0: 服务端接收 chat.user_message 的 epoch ms（用于客户端对齐首字延迟）
 */
export type ChatTurnStartedPayload = {
  sessionId: string;
  traceId: string;
  t0: number;
};

/**
 * 路由模式枚举（与 LlmExecutionMode 同步）：
 *   fast_chat       单轮流式（闲聊 / 极短消息），不进入 v2 阶段化链路
 *   master_only     master 自己单轮回答，简单 direct task
 *   master_delegate 派子 Agent 协作（含 subAgents 字段）
 *   plan_execute    计划-执行循环（含 plan 字段）
 *   direct_llm      直接 LLM + 工具调用
 */
export type ChatIntentMode =
  | "fast_chat"
  | "master_only"
  | "master_delegate"
  | "plan_execute"
  | "direct_llm";

/** plan_execute 拆解出的单个步骤。 */
export type ChatPlanStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "ok" | "err";
};

/** master_delegate 要派出的子 Agent 规划。 */
export type ChatSubAgentPlan = {
  id: string;
  role: string;
  task: string;
};

/**
 * 阶段 1 载荷：意图已识别。
 * - reasons: 路由命中的判定原因（调试用）
 * - plan: 仅 plan_execute 模式携带
 * - subAgents: 仅 master_delegate 模式携带
 */
export type ChatIntentDetectedPayload = {
  sessionId: string;
  traceId: string;
  mode: ChatIntentMode;
  reasons: string[];
  plan?: ChatPlanStep[];
  subAgents?: ChatSubAgentPlan[];
};

/** 执行事件类型（结构化区分 UI 渲染）。 */
export type ChatExecutionKind =
  | "thought" // 模型内部 monologue
  | "tool_call" // 工具开始调用
  | "tool_result" // 工具调用结果
  | "agent_start" // 子 Agent 开始
  | "agent_done" // 子 Agent 完成
  | "plan_step" // plan_execute 拆解出的步骤状态更新
  | "log"; // 兜底：自由文本日志（v1 过渡期兼容）

/** 阶段 2 载荷：执行事件流。 */
export type ChatExecutionEventPayload = {
  sessionId: string;
  traceId: string;
  /** 事件唯一 id（同 traceId 内单调递增，便于客户端去重 / 排序） */
  eventId: string;
  kind: ChatExecutionKind;
  /** 该事件发生时间 epoch ms */
  at: number;
  // ---- 按 kind 选填 ----
  thought?: string;
  toolCall?: {
    id: string;
    name: string;
    /** 摘要化的入参（避免把大对象塞进 WS） */
    argsPreview?: string;
  };
  toolResult?: {
    id: string;
    name: string;
    /** 摘要化的结果预览 */
    preview?: string;
    ok: boolean;
    elapsedMs: number;
  };
  agentStart?: {
    id: string;
    role: string;
    task?: string;
  };
  agentDone?: {
    id: string;
    role: string;
    ok: boolean;
    elapsedMs: number;
  };
  /** plan_execute 步骤状态更新（kind=plan_step 时携带） */
  planStep?: {
    id: string;
    title: string;
    status: "pending" | "running" | "ok" | "err";
  };
  /** 兜底：v1 过渡期自由文本 */
  log?: string;
};

