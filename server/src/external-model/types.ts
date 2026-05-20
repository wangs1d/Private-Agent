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
  /** 个人房世界点数、已解锁技能等（非 UAP KV，由运行时拼装） */
  worldCaps?: string;
  /** BM25+Qdrant+RRF 融合后的履历/叙事摘录，供本轮推理引用 */
  narrativeRecall?: string;
  memorySummary?: string;
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
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
  };
  /** 按会话已购技能合并进 LLM tools（内置 Skill + 已拥有社区 Skill） */
  chatToolsExtra?: ChatCompletionTool[];
  /** 替换默认内置工具列表（子 Agent 按能力过滤时使用） */
  chatToolsBuiltin?: ChatCompletionTool[];
};

/** 外部模型 function calling 与本地 ToolRegistry 之间的桥接。 */
export type ChatToolExecutionContext = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  onToolExecuted?: (info: {
    toolName: string;
    input: Record<string, unknown>;
    ok: boolean;
    result: Record<string, unknown>;
  }) => void;
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
   * `tools` 传入时启用 world.doudizhu.* 等 function calling（OpenAI 兼容端点）。
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
}
