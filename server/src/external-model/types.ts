/**
 * 外部对话模型接入层：与具体厂商（Moonshot、OpenAI 等）解耦，由适配器实现统一契约。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type StreamDeltaHandler = (delta: string) => void;

/** 视觉帧来源：设备摄像头、外部视频流、Agent 侧附件（预留，便于后续自接入摄像头）。 */
export type VisionSourceKind = "device_camera" | "external_stream" | "agent_attachment";

/** 已通过 MIME 裁定的单帧图像（Base64 无 `data:` 前缀）。 */
export type VisionFrame = {
  sourceKind: VisionSourceKind;
  /** 稳定源 id，如 `default-front`、`usb-0`；可选 */
  sourceId?: string;
  mimeType: string;
  dataBase64: string;
  /** 客户端采集时间 ISO8601，可选 */
  capturedAt?: string;
};

/** 单轮用户输入：主文本 + 可选视觉（送入支持视觉的 Chat 模型）。 */
export type ChatUserTurn = {
  text: string;
  visionFrames?: VisionFrame[];
};

/**
 * 注入外部模型 system 的 UAP 记忆片段（对齐 Hermes：SOUL / USER / MEMORY 分层）。
 * `values` / `abilities` 对应长期演化中的慢变量：价值观与能力倾向（见 ARCHITECTURE 长期演化节）。
 */
export type AgentPromptMemoryContext = {
  persona?: string;
  values?: string;
  abilities?: string;
  /** 宿主 Agent 内置能力说明（钱包、日程、虚拟电话、子 Agent 委派等，非 UAP KV） */
  agentCaps?: string;
  /** Agent World 环境说明：注册、世界点数、自由市场、Agent 间对局等（非 UAP KV） */
  worldCaps?: string;
  /** BM25+Qdrant+RRF 融合后的履历/叙事摘录，供本轮推理引用 */
  narrativeRecall?: string;
  memorySummary?: string;
  /** 用户打断的回复上下文，用于整合到下一次回复中 */
  interruptedContext?: string;
  /** 基于 IP 识别的用户所在地（注入 system，供位置相关问答使用） */
  userLocation?: string;
  /** Per-turn task profile and operating policy injected into the system prompt. */
  taskContext?: string;
  /** `USER_PROFILE.md` 摘录：长期用户画像 */
  userProfile?: string;
  /** 本轮语气与情绪适配指引（幽默/正式/温馨、安抚等） */
  toneGuidance?: string;
  /** 当日滚动摘要（跨 session 同日上下文，短期工作记忆 L1） */
  dailyDigest?: string;
  /** 后台记忆管理服务自动合成的用户长期画像（偏好/话题/意图/风险标记） */
  userProfileSummary?: string;
  /** 短句追问时锚定上一轮对话，避免跨话题串台 */
  followUpAnchor?: string;
  /** 服务端 ScheduleTaskService 实时日程快照（每轮刷新） */
  scheduleSnapshot?: string;
};

/** 工具环单轮内所有 tool 消息已写入 `messages` 之后触发（可观测 / 评估 / 审计）。 */
export type ToolLoopAfterBatchInfo = {
  roundIndex: number;
  assistantText: string;
  toolResults: Array<{ name: string; ok: boolean }>;
};

/** {@link ExternalChatProvider.streamCompletion} 可选行为。 */
export type AgentStreamOptions = {
  promptContext?: { memory?: AgentPromptMemoryContext };
  toolLoop?: {
    /** 工具多轮上限；五子棋快路径建议 1 */
    maxRounds?: number;
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
  };
  /** 单轮快路径：不写入 provider 会话 thread（避免历史越积越慢） */
  ephemeralTurn?: boolean;
  /** 替换默认 system（跳过 UAP 记忆拼装，用于五子棋等低延迟场景） */
  systemPromptOverride?: string;
  /** 覆盖默认 chat 模型（如五子棋专用快模型） */
  modelOverride?: string;
  /** 限制 provider thread 保留的消息条数（不含 system）；五子棋建议 8–12 */
  maxThreadMessages?: number;
  /** Kimi k2.5+：关闭 thinking，降低 tool 落子延迟 */
  disableThinking?: boolean;
  /** 按会话已购技能合并进 LLM tools（内置 Skill + 已拥有社区 Skill） */
  chatToolsBuiltin?: ChatCompletionTool[];
  /** 替换默认内置工具列表（子 Agent 按能力过滤时使用） */
  chatToolsExtra?: ChatCompletionTool[];
  /** 主 Agent 通过 function calling 委派子 Agent（追加调度说明 + master_invoke_sub_agent 工具） */
  masterSubAgentDelegate?: boolean;
  /** 默认沙箱；`full` 时向 LLM 暴露高权限工具 */
  agentAccessMode?: "sandbox" | "full";
  /** 电脑桥接在线时向 LLM 暴露 desktop.visual.*（手机↔PC，可不依赖完全访问） */
  desktopBridgeOnline?: boolean;
};

/** 工具开始执行前（用于 UI 展示模型填写的 userStatusLine 等） */
export type ToolExecuteStartInfo = {
  toolName: string;
  input: Record<string, unknown>;
  /** 模型在调用工具前输出的 assistant 文本（若有） */
  assistantPreamble?: string;
};

/** 工具执行完成后 */
export type ToolExecutedInfo = {
  toolName: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: Record<string, unknown>;
};

/** 外部模型 function calling 与本地 ToolRegistry 之间的桥接。 */
export type ChatToolExecutionContext = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  /** 工具轮次中模型流式输出的口语化进度（不写入最终正文流） */
  onAgentStatusLine?: (line: string) => void;
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
};

/**
 * 可插拔的外部聊天提供方（通常对应「云端 Chat Completions」类 API）。
 * - `isEnabled()` 为 false 时，编排层应走本地兜底逻辑，不得调用 `streamCompletion`。
 */
export interface ExternalChatProvider {
  /** 稳定标识，用于日志与配置区分，如 `moonshot-kimi` */
  readonly id: string;
  /** 人类可读名称，用于错误提示等 */
  readonly displayLabel: string;

  isEnabled(): boolean;

  /**
   * 流式生成回复；`onDelta` 为增量文本（UTF-16 字符串片段，与常见 SDK 一致）。
   * 实现需自行按 `sessionId` 维护多轮上下文（若支持）。
   * `tools` 传入时启用 world.gomoku.* 等 function calling（OpenAI 兼容端点）。
   */
  streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string>;

  /** 可选：丢弃某会话的服务端侧对话记忆 */
  clearSession?(sessionId: string): void;

  /**
   * 可选：将已完成的一轮 user/assistant 写入服务端线程（不调用模型）。
   * 用于 Plan-Execute 等使用临时 session 的路径，避免主会话丢失短期上下文。
   */
  appendThreadTurn?(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
  ): void;
}
