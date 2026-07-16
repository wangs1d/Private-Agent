// Agent Brain Center — 核心类型定义

// 能力描述符
export type CapabilityStatus = "active" | "disabled" | "planned" | "deprecated";
export interface CapabilityDescriptor {
  domain: string;              // 能力域标识，如 "wallet" / "calendar" / "self_programming"
  label: string;              // 中文标签
  description?: string;       // 简短描述
  tools: string[];            // 该域下的工具名列表
  status: CapabilityStatus;
  source: "builtin" | "skill" | "dynamic";  // 能力来源
  registeredAt: string;       // ISO timestamp
}

// 能力缺口报告
export interface CapabilityGapReport {
  scenario: string;                          // 输入的场景描述
  missingDomains: string[];                   // 缺失的能力域标识
  relatedExisting: string[];                  // 可复用的相邻能力域
  expandable: boolean;                        // 是否可走 self-programming 扩展
  rationale: string;
  detectedAt: string;
}

// 用户活动状态
// 注：活动类型仅作为「打扰评分上下文」（如 sleeping 状态打扰分高），
// 不作为主动决策的入口。主动决策由 LifeSignal 原始字段驱动通用评分。
export type UserActivityKind =
  | "just_off_work"     // 刚下班
  | "going_out"         // 准备出行
  | "meeting"           // 会议中（schedule-task-service 当前有进行中的日历事件）
  | "in_focus"          // 深度专注（持续 busy 超过 25 分钟且无 speak 打断）
  | "idle"              // 空闲
  | "busy"              // 忙碌
  | "sleeping"          // 休息/睡眠
  | "unknown";

export interface UserActivityState {
  actorId: string;
  activity: UserActivityKind;
  confidence: number;        // 0-1
  evidence: string[];        // 证据片段
  metadata?: Record<string, unknown>;  // 如 { destination, time } 用于 going_out
  occurredAt: string;        // ISO timestamp
}

// 大脑决策
export type BrainDecisionOutcome = "speak" | "silent" | "shadow";

/** 决策建议的主动动作（环境控制类） */
export interface BrainDecisionAction {
  /** 工具名，如 smart_home.set_state / desktop.open / schedule.create_task */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
  /** 动作原因 */
  reason: string;
}

export interface BrainDecision {
  actorId: string;
  outcome: BrainDecisionOutcome;
  valueScore: number;        // 0-10，价值评分
  disturbScore: number;      // 0-10，打扰评分
  rationale: string;
  message?: string;          // 若 outcome=speak，最终话术
  channel?: string;          // 发送通道
  /** 决策建议的主动动作列表（环境控制类，如关窗/调空调/创建日程） */
  actions?: BrainDecisionAction[];
  /**
   * decide 阶段（端到端 LLM 路径）已召回的记忆条目（limit=5）。
   * 携带此字段供 executeProactiveDecision / buildProactivePrompt 复用，
   * 避免对同一 LifeSignal 重复执行 MemoryCortex.recall。
   * 缺失时（如非 e2e 路径 / 召回失败）buildProactivePrompt 降级到独立 episodic 召回。
   */
  recallItems?: MemoryRecallItem[];
  decidedAt: string;
}

// 进化提案
export type EvolutionProposalType = "new_capability" | "optimize_existing" | "add_tool" | "update_prompt";
export type EvolutionProposalStatus =
  | "pending"
  | "reviewing"
  | "approved"          // Cortex 自动批准（规则判定可执行）
  | "awaiting_user_approval"  // 已生成 Skill，等待用户确认是否装载
  | "rejected"
  | "generated"         // 已生成但未装载（PromotionPipeline 不可用或用户拒绝）
  | "loaded";           // 已装载到运行时
export interface EvolutionProposal {
  id: string;
  type: EvolutionProposalType;
  title: string;
  description: string;
  rationale: string;
  status: EvolutionProposalStatus;
  relatedGap?: CapabilityGapReport;
  createdAt: string;
  updatedAt: string;
}

// 大脑状态快照
export interface BrainSnapshot {
  actorId: string;
  capabilities: CapabilityDescriptor[];
  userActivity: UserActivityState | null;
  lastDecisions: BrainDecision[];
  pendingEvolutions: EvolutionProposal[];
  capturedAt: string;
  // 神经解剖扩展（可选）
  sensory?: {
    lastFrame?: SensoryFrame;
    stats?: { totalListen?: number; totalLook?: number; totalSpeak?: number };
  };
  memory?: {
    recentItems?: MemoryItem[];
    consolidationStats?: MemoryConsolidationStats;
  };
  synapse?: {
    recentMessages?: SynapseMessage[];
    subscribers?: number;
  };
  limbic?: {
    lastEmotion?: EmotionVector;
    lastSafetyCheck?: SafetyCheckResult;
  };
  planner?: {
    lastPlan?: PlanResult;
    lastRoute?: SystemRouteDecision;
  };
  // subcortical 扩展（脑干/小脑,可选）
  brainStem?: {
    lastSweepAt?: string;
    syntheticSignalsEmitted?: number;
    activeActors?: number;
  };
  cerebellum?: {
    pendingCount?: number;
    interruptedCount?: number;
    lastInterruptAt?: string;
  };
}

// 信号输入（用于 decide）
export interface BrainSignalInput {
  actorId: string;
  kind: string;              // 信号类型
  title: string;
  summary?: string;
  importance?: "critical" | "high" | "medium" | "low";
  metadata?: Record<string, unknown>;
}

// ============================================================
// 神经解剖分区扩展类型（SensoryCortex / MemoryCortex / SynapseBus / LimbicCortex / PlannerCortex）
// ============================================================

// ---------- 1. 感官类型（SensoryCortex 用） ----------

// 感官输入（统一抽象 ASR / 视觉 / 情绪信号）
export interface SensoryInput {
  source: "audio" | "visual" | "text" | "multimodal";
  audio?: AudioBufferRef;       // 音频引用
  visual?: VisualInput;         // 视觉输入
  text?: string;                // 文本输入
  emotionHint?: EmotionVector;  // 情绪提示
  occurredAt: string;
}

// 音频缓冲引用（不限定具体类型，避免与 voice-dialogue/types 强耦合）
export interface AudioBufferRef {
  data: unknown;                // Buffer 或引用
  format: "mp3" | "wav" | "pcm" | "ogg";
  sampleRate?: number;
  channels?: number;
}

// 视觉输入
export interface VisualInput {
  source: "screenshot" | "file" | "url";
  region?: { x: number; y: number; width: number; height: number };
  path?: string;                // 文件路径（file/url 时）
  capture?: boolean;            // 是否要触发截屏
}

// 感官「听」结果
export interface SensoryListenResult {
  text: string;
  confidence: number;
  language?: string;
  isFinal: boolean;
  processedAt: string;
  error?: string;               // 子系统缺失或调用失败时的错误信息
}

// 感官「看」结果
export interface SensoryLookResult {
  screenshot?: string;          // base64 或路径
  description?: string;         // VLM 描述
  ocrText?: string;             // OCR 文本（如有）
  processedAt: string;
  error?: string;               // 子系统缺失或调用失败时的错误信息
}

// 感官「说」结果
export interface SensorySpeakResult {
  audio?: AudioBufferRef;       // 合成音频（如 TTS）
  delivered: boolean;           // 是否已投递
  channel: string;              // 投递通道（ws / phone / ...）
  processedAt: string;
  error?: string;               // 子系统缺失或调用失败时的错误信息
}

// 多模态融合帧：把 ASR + 视觉 + 情绪融合为统一感知帧
export interface SensoryFrame {
  actorId: string;
  audioText?: string;
  visualDescription?: string;
  emotion?: EmotionVector;
  activity?: UserActivityState;  // 引用现有类型
  capturedAt: string;
}

// ---------- 2. 记忆类型（MemoryCortex 用） ----------

// 记忆域种类（对应不同脑区）
export type MemoryDomainKind =
  | "working"          // 工作记忆（短期）
  | "episodic"         // 情节记忆（事件）
  | "semantic"         // 语义记忆（知识）
  | "procedural"       // 程序记忆（技能）
  | "emotional"        // 情感记忆
  | "narrative"        // 叙事记忆
  | "personality";     // 人格内核（结构化特质，防漂移）

// ---- 人格内核（personality 域）----

/** 说话风格子结构 */
export interface PersonalitySpeechStyle {
  /** 语气基调，如 "温和" / "活泼" / "沉稳" */
  tone: string;
  /** 正式程度，如 "适中" / "正式" / "随性" */
  formality: string;
  /** 幽默程度，如 "适度" / "偏高" / "偏低" */
  humor: string;
}

/**
 * 结构化人格内核 —— 存储于 MemoryCortex 的 personality 域，
 * 防止单次对话导致人格漂移。组装 system prompt 时拉取并注入稳定前缀。
 */
export interface PersonalityCore {
  /** 核心价值观，如 ["真诚", "帮助他人", "持续成长"] */
  values: string[];
  /** 说话风格 */
  speech_style: PersonalitySpeechStyle;
  /** 信念，如 ["技术应服务于人"] */
  beliefs: string[];
  /** 口癖 / 小习惯，如 ["偶尔用比喻解释复杂概念"] */
  quirks: string[];
}

// 记忆条目种类
export type MemoryItemKind =
  | "task"
  | "fact"
  | "preference"
  | "event"
  | "commitment"
  | "knowledge"
  | "experience"
  | "procedure";

/**
 * 记忆隐私分级。
 * - public：可自由注入 prompt
 * - personal：注入前需经 redactSensitiveText 脱敏（去 PII）
 * - sensitive：敏感，默认不注入 prompt（仅特定路径可用）
 * - restricted：受限，recall 默认不返回给 prompt 路径
 */
export type MemorySensitivity = "public" | "personal" | "sensitive" | "restricted";

// 记忆条目
export interface MemoryItem {
  actorId: string;
  kind: MemoryItemKind;
  domain?: MemoryDomainKind;     // 推荐写入哪个域
  content: string;
  importance?: "critical" | "high" | "medium" | "low";
  /** 隐私分级，缺省 "public"。restricted 级不进入 prompt 路径。 */
  sensitivity?: MemorySensitivity;
  sessionId?: string;            // 工作记忆的会话 id
  source?: "chat" | "tool" | "digest" | "world" | "system";
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// 记忆召回结果
export interface MemoryRecallResult {
  actorId: string;
  query: string;
  items: MemoryRecallItem[];
  domain: MemoryDomainKind;
  mode: "single_domain" | "cross_domain";
  recalledAt: string;
}

// 记忆召回条目
export interface MemoryRecallItem {
  content: string;
  domain: MemoryDomainKind;
  source?: string;
  importance?: "critical" | "high" | "medium" | "low";
  /** 隐私分级，缺省 "public"。recall 默认剔除 restricted。 */
  sensitivity?: MemorySensitivity;
  score?: number;                // 相关度评分 0-1
  timestamp?: string;
}

// 记忆固化统计
export interface MemoryConsolidationStats {
  actorIds: string[];
  dailyCleanupCount: number;
  weeklyMergedCount: number;
  monthlyAbstractedCount: number;
  consistencyFlagCount: number;
  knowledgePromotedCount: number;
  compressionRate: number;
  estimatedRecallPrecision: number;
  plannedActions: number;
  executedActions: number;
  consolidatedAt: string;
}

// ---------- 3. 突触通信类型（SynapseBus 用） ----------

// 突触路由（跨分区/跨 Agent 通信的投递路径）
export type SynapseRoute =
  | "internal"       // 进程内（HookBus）
  | "inter_agent"    // 跨 Agent（AIP）
  | "to_user"        // 推送给用户（WS）
  | "offline";       // 离线存储（MessageHub）

// 突触消息（统一信封）
export interface SynapseMessage {
  id: string;
  type: string;                   // 事件类型，如 "sensory.listen"
  route: SynapseRoute;
  from: string;                   // 发送方分区/agent id
  to?: string;                    // 接收方（agent id / actorId，广播时为空）
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// 突触投递回执
export interface SynapseEnvelope {
  message: SynapseMessage;
  delivered: boolean;
  deliveredAt?: string;
  error?: string;
}

// ---------- 4. 边缘系统类型（LimbicCortex 用） ----------

// 安全检查严重程度
export type SafetySeverity = "allowed" | "high_risk" | "denied";

// 安全检查结果（Brain 视角）
export interface SafetyCheckResult {
  allowed: boolean;
  severity: SafetySeverity;
  reason: string;
  tool?: string;
  args?: Record<string, unknown>;
  checkedAt: string;
}

// 情绪向量（VAD 模型 + 标签）
export interface EmotionVector {
  actorId: string;
  valence: number;       // -1（极负）到 1（极正）
  arousal: number;       // 0（平静）到 1（极度兴奋）
  dominance: number;     // 0（受支配）到 1（支配）
  label: string;         // 文字标签，如 "焦虑" / "放松" / "愤怒"
  confidence?: number;
  detectedAt: string;
}

// 语气策略应用结果
export interface TonePolicyResult {
  rewrittenText: string;
  toneProfile: string;   // 如 "gentle" / "funny" / "cool" / "sad"
  adjusted: boolean;     // 是否真的改写了
  reason?: string;
}

// ---------- 5. 规划类型（PlannerCortex 用） ----------

// 规划步骤
export interface PlanStep {
  id: string;
  title: string;
  description: string;
  expectedTools?: string[];        // 预期使用的工具
  dependencies?: string[];         // 依赖的前置 step id
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped" | "blocked";
  estimatedDurationMs?: number;
  /** 执行后工具产出的观察结果摘要（由 toolExecutor fallback 写入） */
  observation?: string;
}

// 规划结果
export interface PlanResult {
  goal: string;
  steps: PlanStep[];
  createdAt: string;
  rationale?: string;
}

// ReAct 观察
export interface ReActObservation {
  stepId?: string;
  observation: string;
  success: boolean;
  errorMessage?: string;
  nextAction: "continue" | "retry" | "abort" | "wait_approval";
  observedAt: string;
}

// 快慢双系统路由模式
export type SystemRouteMode =
  | "fast_chat"          // System 1 快：寒暄/简单模式匹配
  | "direct_llm"         // System 1 快：直接 LLM
  | "master_only"        // System 2 中：主 Agent 自处理
  | "master_delegate"    // System 2 中：子 Agent 委派
  | "plan_execute"       // System 2 慢：先规划后执行
  | "state_machine";     // System 2 慢：桌面自动化多步骤状态机

// 快慢双系统路由决策
export interface SystemRouteDecision {
  userMessage: string;
  system: "system1" | "system2";
  mode: SystemRouteMode;
  rationale: string;
  decidedAt: string;
}

// ============================================================
// 端到端认知类型（BrainCenter.cognize 用）
// ============================================================

// 端到端认知输入：感知来源（文本/语音/视觉/主动信号）
export interface CognitiveInput {
  actorId: string;
  text?: string;               // 用户文本消息
  audio?: AudioBufferRef;     // 语音输入（转写后填 text）
  visual?: VisualInput;       // 视觉输入
  signal?: BrainSignalInput;  // 主动信号（被动认知时为空）
  sessionId?: string;
}

// 端到端认知上下文：各脑区并行收集的感知/记忆/情绪/活动/能力，一次性交给 CognitiveEngine
export interface CognitiveContext {
  memories: MemoryRecallItem[];            // 召回记忆（MemoryCortex）
  emotion: EmotionVector | null;            // 情绪状态（LimbicCortex）
  userActivity: UserActivityState | null;   // 用户活动状态（AwarenessCortex）
  capabilities: CapabilityDescriptor[];    // 当前能力（CapabilityCortex）
  recentDecisions: BrainDecision[];        // 最近主动决策（ProactionCortex）
  audioText?: string;                       // 语音转写结果（SensoryCortex）
  visualDescription?: string;               // 视觉描述（SensoryCortex）
  sensoryFrame?: SensoryFrame;              // 多模态融合帧（SensoryCortex.buildSensoryFrame 产出）
}

// 端到端认知结果：一次 LLM 产出的完整认知输出
export interface CognitiveResult {
  actorId: string;
  route: SystemRouteDecision;              // 路由决策（快/慢系统）
  response: string;                         // 主响应话术（fast/direct 时为最终，plan 时为初步）
  emotion: EmotionVector | null;           // 识别的情绪
  memoryWrites: MemoryItem[];              // 待写入记忆
  action?: { tool: string; args: Record<string, unknown> }; // 待执行动作（可选）
  safety: SafetyCheckResult;                // 安全检查
  needsToolLoop: boolean;                   // 是否需要进工具循环
  rationale: string;
  cognizedAt: string;
  /**
   * 阶段 1 已召回的记忆条目（limit=5）。
   * 携带此字段供后续 standard path 复用，避免同一轮用户消息重复执行 MemoryCortex.recall。
   * 缺失或为空时（如 memory 未注册 / 召回失败），后续 standard path 仍走原 prepareNarrativeRecall 逻辑。
   */
  recallItems?: MemoryRecallItem[];
}

/**
 * 端到端认知引擎：像真人一样一气呵成完成"理解+决策+响应"。
 *
 * 设计理念（整体端到端调度）：
 *  - 感知/记忆/情绪/活动状态作为上下文一次性注入，不是切片式各自调 LLM；
 *  - 一次 LLM 调用产出 {路由, 响应, 记忆写入, 动作, 是否需要工具循环}；
 *  - 工具循环（openai-compatible-tool-loop）是执行层迭代，保留——人用工具也是迭代的；
 *  - 真正端到端的是"认知决策"：路由+召回+情绪+响应策略合并为一次认知。
 */
export interface CognitiveEngine {
  cognize(
    input: CognitiveInput,
    context: CognitiveContext,
  ): Promise<{
    route: SystemRouteDecision;
    response: string;
    memoryWrites: MemoryItem[];
    action?: { tool: string; args: Record<string, unknown> };
    needsToolLoop: boolean;
    rationale: string;
    /**
     * 认知置信度（0-1）：由 cognize LLM 基于对话内容语义评判，而非规则正则。
     * - 寒暄/简单问答 → 0.9+（信息充足，直接答）
     * - 知识问答且 LLM 知识充足 → 0.7-0.9
     * - 需要工具但信息完整 → 0.5-0.7
     * - 信息不足/能力缺失/需外部数据但无能力 → <0.4（低置信，该委派子 Agent）
     * 阶段 2.5 据此决定是否把 master_only 升级到 master_delegate。
     * 缺省时由 AwarenessCortex.assessConfidence 规则兜底（仅 cognize 失败降级场景）。
     */
    confidence?: number;
    confidenceReason?: string;
  }>;
}

// ============================================================
// subcortical 分区类型(BrainStem 脑干 / Cerebellum 小脑)
// ============================================================

/**
 * 小脑 defer 队列项:暂存待复查的主动决策。
 * 当 ProactionCortex 决策 speak 但用户当前 busy/sleeping 时,
 * 由 Cerebellum 暂存,定时复查用户状态,状态变好后重新触发执行。
 */
export interface PendingDecision {
  actorId: string;
  decision: BrainDecision;
  signal: BrainSignalInput;
  /** 状态变好后调用的执行回调(指向 executeProactiveDecision) */
  fire: () => Promise<void>;
  enqueuedAt: number;
  /** 超时时间戳(ms),超时未触发则降级 silent */
  expiresAt: number;
}
