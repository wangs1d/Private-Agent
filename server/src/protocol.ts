export type EventEnvelope = {
  type: string;
  payload: Record<string, unknown>;
};

export type WalletAction = "freeze" | "debit" | "refund" | "purchase";

export const ClientEventType = {
  SessionInit: "session.init",
  ChatUserMessage: "chat.user_message",
  WalletSimulateRequest: "wallet.simulate.request",
  /** AIP v0.1：结构化跨 Agent 消息（与工具 aip.dispatch 等价）。 */
  AipDispatch: "aip.dispatch",
  /** 电脑端桥接：若服务端配置了 DESKTOP_BRIDGE_TOKEN 则须提交；无 token 模式无需发送本事件 */
  DesktopBridgeRegister: "desktop.bridge.register",
  /** 电脑端桥接：执行完成后回传结果（与 desktop.bridge.invoke 的 jobId 对应）。 */
  DesktopBridgeResult: "desktop.bridge.result",
} as const;

export const ServerEventType = {
  ChatAssistantChunk: "chat.assistant_chunk",
  ChatAssistantDone: "chat.assistant_done",
  ToolCall: "tool.call",
  ToolResult: "tool.result",
  WalletSimulateResult: "wallet.simulate.result",
  AgentPeerMessage: "agent.peer_message",
  /** 每日天气简报（日程 weather_brief 触发，需已建立 WS session） */
  WeatherBrief: "weather.brief",
  /** Agent 虚拟电话来电（6 位号码线路；可含 TTS mp3 base64） */
  VirtualPhoneIncoming: "agent.phone.incoming",
  /** 电脑端桥接绑定成功 */
  DesktopBridgeRegisterAck: "desktop.bridge.register_ack",
  /** 发往电脑端：执行一轮纯视觉桌面任务 */
  DesktopBridgeInvoke: "desktop.bridge.invoke",
  /** 手机端等与 userId 对齐的 WS：电脑桥接在线状态、最近桌面任务结果摘要 */
  DesktopBridgeSync: "desktop.bridge.sync",
  ErrorEvent: "error.event",
} as const;
