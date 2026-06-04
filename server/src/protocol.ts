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
  WalletSimulateRequest: "wallet.simulate.request",
  /** AIP v0.1：结构化跨 Agent 消息（与工具 aip.dispatch 等价）。 */
  AipDispatch: "aip.dispatch",
  /** 电脑端桥接：若服务端配置了 DESKTOP_BRIDGE_TOKEN 则须提交；无 token 模式无需发送本事件 */
  DesktopBridgeRegister: "desktop.bridge.register",
  /** 电脑端桥接：执行完成后回传结果（与 desktop.bridge.invoke 的 jobId 对应）。 */
  DesktopBridgeResult: "desktop.bridge.result",
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
} as const;

export const ServerEventType = {
  ChatAssistantChunk: "chat.assistant_chunk",
  ChatAssistantDone: "chat.assistant_done",
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
  /** 电脑端桥接绑定成功 */
  DesktopBridgeRegisterAck: "desktop.bridge.register_ack",
  /** 发往电脑端：执行一轮纯视觉桌面任务 */
  DesktopBridgeInvoke: "desktop.bridge.invoke",
  /** 手机端等与 userId 对齐的 WS：电脑桥接在线状态、最近桌面任务结果摘要 */
  DesktopBridgeSync: "desktop.bridge.sync",
  /** 球形 Agent 权威视觉状态（mood/energy/caption/委派 phase） */
  AgentEmbodimentPatch: "agent.embodiment.patch",
  /** 主 Agent 具身控制：3D 漫游、移动、停驻等（球形机器人身体） */
  AgentEmbodimentCommand: "agent.embodiment.command",
  ErrorEvent: "error.event",
} as const;
