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
  /**
   * 客户端为该 user 消息生成的稳定 id（与 WebSocket `chat.user_message.messageId` 一致）。
   * Provider 会把它登记到 ChatThreadStore 的反向索引，供后续「编辑/删除/替换并重发」使用。
   * 未传或为空时按「无 id」处理，相关操作将无法按 id 命中。
   */
  clientMessageId?: string;
};

/**
 * 注入外部模型 system 的 UAP 记忆片段（SOUL / USER / MEMORY 分层）。
 * `values` / `abilities` 对应长期演化中的慢变量：价值观与能力倾向（见 ARCHITECTURE 长期演化节）。
 */
export type AgentPromptMemoryContext = {
  persona?: string;
  /**
   * 结构化人格内核（personality 域）的可读文本，注入 system prompt 稳定前缀。
   * 由 PromptContextBuilder 从 MemoryCortex.getPersonalityCore 拉取并格式化，
   * 防止单次对话导致人格漂移。
   */
  personalityCore?: string;
  values?: string;
  abilities?: string;
  /** 宿主 Agent 内置能力说明（钱包、日程、虚拟电话、子 Agent 委派等，非 UAP KV） */
  agentCaps?: string;
  /** Agent World 环境说明：注册、世界点数、自由市场、Agent 间对局等（非 UAP KV） */
  worldCaps?: string;
  /** BM25+Qdrant+RRF 融合后的履历/叙事摘录，供本轮推理引用 */
  narrativeRecall?: string;
  memorySummary?: string;
  memoryCurrentMission?: string;
  memoryPreferences?: string;
  memoryFacts?: string;
  memoryCommitments?: string;
  memoryOpenLoops?: string;
  sessionRecap?: string;
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
  relationshipGuidance?: string;
  /** 当日滚动摘要（跨 session 同日上下文，短期工作记忆 L1） */
  dailyDigest?: string;
  /** 后台记忆管理服务自动合成的用户长期画像（偏好/话题/意图/风险标记） */
  userProfileSummary?: string;
  /**
   * 记忆目录（元认知）：MemoryInventory 统计的记忆规模/时间分布/高频主题摘要。
   * 让 LLM "知道自己记住了什么"，用户问"你知道我什么"时有真实依据可答。
   * 由 PromptContextBuilder 同步读 MemoryInventory 缓存注入（cognize 阶段刷新）。
   */
  memoryInventory?: string;
  memoryContinuity?: string;
  relationshipMemory?: string;
  lifeThemeMemory?: string;
  dreamMemory?: string;
  /**
   * 主动跨天 recall：用「昨天的 userText」作为 query 跑一次 narrative recall，
   * 让 LLM 即使当前话题与昨天无关也能看到昨天的关键事件。
   * 解决「前天说后天要去玩，今天提及时 agent 能关联记忆」的连续性问题。
   */
  yesterdayHighlight?: string;
  /** 短句追问时锚定上一轮对话，避免跨话题串台 */
  followUpAnchor?: string;
  /** 服务端 ScheduleTaskService 实时日程快照（每轮刷新） */
  scheduleSnapshot?: string;
  /**
   * 当前精确时间（年/月/日/时/分/秒 + 星期 + 时区），每轮注入。
   * 与对话历史中每条消息的 `[ts:...]` 前缀对应，供 LLM 做时间维度计算与对齐。
   */
  currentTime?: string;
  /**
   * 元认知评估结果：MetaCognitionCortex.assess() 的输出。
   * 包含 uncertaintyMarkers / confidence / shouldReflect 等字段的可读摘要，
   * 让 LLM 知道自己当前对哪些点不确定、是否应该先反思再答。
   * 由 agent-core 从 brainCenter.metaCognition.assess() 拉取并格式化注入。
   */
  metaCognition?: string;
  /**
   * 当前情绪状态摘要：LimbicCortex/EmotionModulator 的 VAD 值可读化输出。
   * 让 LLM 知道自己当前的情绪（如低落、兴奋、关注），影响回复语气。
   * 由 agent-core 从 brainCenter.limbicCortex.getEmotion() 拉取并格式化注入。
   */
  emotionState?: string;
  /**
   * 工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围。
   * complex 路由时注入，建议 LLM 按规划顺序调用工具，避免乱试或遗漏关键工具。
   */
  toolPlan?: string;
  /**
   * 可复用技能轻量索引（Level 0 渐进式召回）。
   *
   * 只含 name + description + skillType + tags 的紧凑列表（不含 doc 全文），
   * 让 LLM 感知"我有这些沉淀的技能"，需要时再用 skill.view 工具加载全文（Level 1）。
   * 由 PromptContextBuilder 从 SkillManager.list() 提取并压缩注入。
   */
  skillIndex?: string;
  /**
   * 当前工作记忆摘要（活跃目标 / 已知槽位 / 待办），来自 WorkingMemoryCortex.toSummary。
   * 作为独立块注入 system prompt（不再拼入 narrativeRecall），避免被 formatNarrativeRecallPrompt
   * 的 slice(0,4) 截断或块结构被拍平。解决"上下文跳转、不能针对当前话回复"的连续性问题。
   */
  workingMemorySummary?: string;
  /**
   * 最近对话回顾（thread 较短时注入，用于指代消解与话题衔接）。
   * 仅在 thread 消息 < 12 条时填充（与消息数组重复时跳过），块内含"非用户最新指令"提示。
   * 作为独立块注入，避免被 formatNarrativeRecallPrompt 当作召回条目丢弃。
   */
  recentConversationHistory?: string;
  /**
   * 语义意图理解结果：LLM 对用户本轮句子的真实意图解析。
   * 作为独立块注入，让主 LLM 明确知道"用户想做什么"，避免答非所问。
   */
  semanticIntent?: string;
  /**
   * FastVerdict 输出规范（仅 fast 模式 + FAST_VERDICT_ENABLED 时注入）。
   * 要求 fast 在回复末尾附加隐藏结构化块 `<<<verdict:{json}>>>`，
   * 供服务端流式解析取出与剥离（判定难度 + 产出给 complex 的封闭任务规范）。
   * 该块不展示给用户。
   */
  fastVerdictInstruction?: string;
  /**
   * Agent 主动建议（ProactivityHub advise 模式）。
   * ProactivityHub 把"不想打断用户"的主动意图（如过劳提醒、日程建议）排入
   * AdviceStore，PromptContextBuilder 在下一轮对话 drain 出来注入此块，
   * 由 agent 在正常回复中自然带出。无建议时不注入（零开销）。
   */
  proactiveAdvice?: string;
};

/** 工具环单轮内所有 tool 消息已写入 `messages` 之后触发（可观测 / 评估 / 审计）。 */
export type ToolLoopAfterBatchInfo = {
  roundIndex: number;
  assistantText: string;
  toolResults: Array<{ name: string; ok: boolean }>;
};

export type ToolExposureProfile =
  | "none"
  | "light"
  | "contextual"
  | "full"
  | "delegate"
  | "scoped";

export type ToolRankingHint = {
  preferredNamespaces?: string[];
  cautiousNamespaces?: string[];
};

/** {@link ExternalChatProvider.streamCompletion} 可选行为。 */
export type AgentStreamOptions = {
  promptContext?: { memory?: AgentPromptMemoryContext };
  toolLoop?: {
    /** 工具多轮上限；建议 1 */
    maxRounds?: number;
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
  };
  /** 单轮快路径：不写入 provider 会话 thread（避免历史越积越慢） */
  ephemeralTurn?: boolean;
  /** 替换默认 system（跳过 UAP 记忆拼装，用于低延迟场景） */
  systemPromptOverride?: string;
  /** 覆盖默认 chat 模型（如专用快模型） */
  modelOverride?: string;
  /** 限制 provider thread 保留的消息条数（不含 system）；建议 8–12 */
  maxThreadMessages?: number;
  /** Kimi k2.5+：关闭 thinking，降低 tool 落子延迟 */
  disableThinking?: boolean;
  /** 按会话已购技能合并进 LLM tools（内置 Skill + 已拥有社区 Skill） */
  chatToolsBuiltin?: ChatCompletionTool[];
  /** 替换默认内置工具列表（子 Agent 按能力过滤时使用） */
  chatToolsExtra?: ChatCompletionTool[];
  /** 主 Agent 通过 function calling 委派子 Agent（追加调度说明 + master_invoke_sub_agent 工具） */
  masterSubAgentDelegate?: boolean;
  /** 已废弃：沙箱模式已移除，Agent 始终以 full 运行；字段保留仅为协议兼容 */
  agentAccessMode?: "sandbox" | "full";
  /** 电脑桥接在线时向 LLM 暴露 desktop.visual.*（手机↔PC，可不依赖完全访问） */
  desktopBridgeOnline?: boolean;
  /** 手机桥接在线时向 LLM 暴露 phone.*（远程控制真实手机，可不依赖完全访问） */
  phoneBridgeOnline?: boolean;
  toolExposureProfile?: ToolExposureProfile;
  toolRankingHint?: ToolRankingHint;
  /** 强制保留的工具名列表(绕过 contextual 筛选)。状态机模式用此字段确保白名单工具始终可见。 */
  pinnedToolNames?: string[];
  /**
   * RuntimeKernel minimal 模式控制位：true 时 provider 跳过身份/风格/时间戳说明类后缀追加，
   * 但仍保留功能性后缀（工具说明/主 Agent 调度/用户可见进度/访问权限）。
   * 配合 RuntimeKernel.buildSessionSystem() 实现"层 A 不进 prompt"。
   */
  suppressRuntimeSuffixes?: boolean;
  /**
   * 功能性后缀开关（仅 suppressRuntimeSuffixes=true 时生效）：
   * - true/undefined（默认）：保留工具说明/主 Agent 调度/用户可见进度等功能性后缀
   * - false：极致节省模式，所有功能性后缀也剥离（不推荐生产）
   */
  functionalSuffixes?: boolean;
  /**
   * 中断信号：用户发新消息或取消时,调用方 abort 此 signal,
   * provider 底层 fetch/SDK 收到后真正中断 HTTP 流式请求(节省 tokens/算力)。
   * 未传时无法中断(向后兼容)。
   */
  signal?: AbortSignal;
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
  /** 查询工具缓存（命中则跳过 executeTool 的安全检查/BodyGateway 等中间层） */
  getCachedToolResult?: (
    name: string,
    args: Record<string, unknown>,
  ) => { ok: boolean; result: Record<string, unknown> } | null;
  /** 工具轮次中模型流式输出的口语化进度（不写入最终正文流） */
  onAgentStatusLine?: (line: string) => void;
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
};

/**
 * 工具调用协议族。
 *
 * 让上层调用方能根据协议族选择正确的适配器，而非假设全部走 OpenAI 格式。
 * - `openai`：OpenAI Chat Completions 的 tool_calls / tool_call_id 格式
 * - `anthropic`：Anthropic Messages API 的 tool_use / tool_result block 格式
 * - `gemini`：Gemini functionCall / functionResponse 格式
 * - `custom`：自研协议（如世界模型原生 function-calling）
 */
export type ToolCallingProtocol = "openai" | "anthropic" | "gemini" | "custom";

/**
 * Provider 能力声明。
 *
 * 让上层调用方在不试探的前提下知道 provider 支持哪些特性，
 * 用于"换大脑"时按能力路由（而非按模型名字符串）。
 */
export interface ProviderCapabilities {
  /** 工具调用协议族，缺省 "openai"（向后兼容） */
  toolCallingProtocol?: ToolCallingProtocol;
  /** 是否支持并行工具调用（parallel_tool_calls） */
  supportsParallelToolCalls?: boolean;
  /** 是否支持视觉输入（vision frames） */
  supportsVision?: boolean;
  /** 最大上下文窗口（token 数），缺省 0 表示未知 */
  maxContextTokens?: number;
  /** 是否支持 reasoning / thinking 字段（如 Kimi k2.5+ disableThinking） */
  supportsThinking?: boolean;
  /** 是否支持流式输出 */
  supportsStreaming?: boolean;
}

/**
 * 可插拔的外部聊天提供方（通常对应「云端 Chat Completions」类 API）。
 * - `isEnabled()` 为 false 时，编排层应走本地兜底逻辑，不得调用 `streamCompletion`。
 */
export interface ExternalChatProvider {
  /** 稳定标识，用于日志与配置区分，如 `moonshot-kimi` */
  readonly id: string;
  /** 人类可读名称，用于错误提示等 */
  readonly displayLabel: string;

  /**
   * 能力声明：让上层按能力路由而非按模型名。
   * 缺省（未实现 getter）时按 "openai" 协议处理（向后兼容）。
   */
  readonly capabilities?: ProviderCapabilities;

  isEnabled(): boolean;

  /**
   * 流式生成回复；`onDelta` 为增量文本（UTF-16 字符串片段，与常见 SDK 一致）。
   * 实现需自行按 `sessionId` 维护多轮上下文（若支持）。
   * `tools` 传入时启用 function calling（OpenAI 兼容端点）。
   */
  streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string>;

  /**
   * 可选：丢弃某会话的服务端侧对话记忆
   */
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
