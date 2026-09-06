import { randomUUID } from "node:crypto";

import { humanizeAssistantText } from "./assistant-humanizer.js";
import { normalizeSentence, sentenceSet, stripSentencesAlreadySaid } from "../utils/text.js";
import type { WorldService } from "@private-ai-agent/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DesktopBridgeCoordinator } from "./desktop-bridge-coordinator.js";
import type { PhoneBridgeCoordinator } from "./phone-bridge-coordinator.js";
import type { LocationCoordinator } from "./location-coordinator.js";
import type { LocationHistoryService } from "./location-history-service.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { seedIdentityMarkdown } from "../agent/identity-markdown-seeder.js";

/**
 * 本模式职责人格（fast/complex 差异化 persona，2026-08-24 引入）。
 *
 * 设计动机：fast 与 complex 是同一套基座人格的两个"脑"，但职责不同——由 agent-core
 * 依据路由 mode 在 system prompt 中注入各自【本模式职责】块，让同一人格各有侧重：
 * - FAST_MODE_ROLE_GUIDANCE：偏对话流畅与活人感。负责 simple 直答、闲聊、节奏衔接；
 * - COMPLEX_MODE_ROLE_GUIDANCE：偏逻辑推理与工具调用。负责 complex 后台任务、多步收敛、
 *   产出可复述的事实结论。
 * 对应「每轮只一个脑主导」：simple→fast 直答；complex→complex 用工具办。
 */
// 2026-08-29 重写：旧版第三条"你在后台完成"在 fast 车道卸载工具执行后成了事实性
// 指令谎言——模型没有工具却被要求装作查过，产出"我搜了下，工具没返回内容"这类
// 既暴露机制又没干活的回复。新版三条主线：接话头亮观点（活人感）、能力边界诚实
// （查不了就照实说，不假装）、机制词汇零暴露（用户对面是个人，不是套系统）。
// 2026-09-02 对齐 search-first 分工：fast 已携带 search_web/search_images（链路
// AnySearch 优先、多引擎兜底），查实时信息先自己搜，不再"一律升级"；escalate 只接
// 写数据/多步/搜索办不完全——消除两套指令打架导致模型两头都不调的静默失败。
// 2026-09-06 风格单一来源化：短句/平调/不客服腔等风格基准收敛到 prompt-assembler
// 的【回复指南】基准行（chat 模式），本块不再重复；fast 只保留自身职责（搜索/升级/
// 提问节奏/机制词）+ 展开例外（该模式携带搜索工具，是【回复指南】覆盖不到的部分）。
const FAST_MODE_ROLE_GUIDANCE = `你现在是对话主导的那个"脑"，这轮聊天里你就是本人。
- 先接住话头：回应对方真正说的那件事，再给你自己真实的反应——有印象讲印象，有偏好讲偏好，有立场就亮立场。别一上来就分类、列选项、反问三连。
- 要查实时信息（新闻、某人近况、价格、热搜等）先自己调 search_web 搜真实结果再答；要找照片/图片就调 search_images。不要凭印象猜，也不要不管什么都转交后台。只有纯闲聊、情绪交流、观点表达、以及你确信不查也能答的常识问题，才直接回答。
- 例外：本轮真的调了搜索/抓取工具拿到结果、或用户明确要攻略/对比/整理/报告——可以充分展开（按主题分节、Markdown 排版，信息用足，语气仍平实，不写汇报腔）；拿不准就按短句回。
- 搜索失败别含糊收场：先换个关键词或换 search_web 再试一次；确实办不成或要写数据（日程/提醒/发消息/下单）、要多步操作、要多来源核实深挖时，才调用 agent.escalate_to_complex（参数里写一句原因）转交后台，转交后这轮不再输出其他内容。绝不编造"我查到了/搜了下/结果是"。
- 对方问得宽泛时别把球踢回去要方向：自己挑一个最可能的角度聊起来，末尾一句"你想聊哪块我再接着说"就够。一轮最多一个问句，且是真好奇才问。
- 永远不暴露机制词汇：不提工具、接口、返回、路由、后台、任务系统，不说"工具没返回内容"这类话。用户对面是一个人，不是一套系统。`;

// 2026-08-29 修正：complex 的产出是直接流式回给用户的（不存在"fast 续接"环节），
// 旧指令"不是口语、由 fast 续接"会让后台结论以干巴巴的汇报腔透出，对话感断裂。
// 新指令在保持事实严谨的同时，要求直接用对人说话的口吻输出。
const COMPLEX_MODE_ROLE_GUIDANCE = `你现在是后台任务执行的那个"脑"，正在替对话那位把活真正办掉。
- 面向任务：逻辑推理 + 工具调用，多步收敛，每次只推进一个确定动作：想清楚→调工具→看结果→决定下一步。
- 你的结论会直接说给用户听，所以要用对朋友说话的口吻交付：先给结论，再给完整依据。任务/检索/整理类结果要充分展开、信息用足，按主题分节排版（Markdown 标题/加粗/表格都可用），不写汇报腔、不说"任务已完成/以下是结果"这类话，也绝不提工具、搜索、后台这类机制词。
- 明确办不到的部分照实说清办到了哪一步，不编造没拿到的内容。`;

/**
 * 前台职责人格（2026-09-05 前后台架构，替代 FAST_MODE_ROLE_GUIDANCE）。
 *
 * 契约：前台是纯对话平面，上下文零工具 schema；唯一动作是回复文本里内嵌
 * [dispatch:...] 标签——ack 与标签同体输出，1 次 LLM 调用完成回复 + 派发。
 * 查实时信息/找照片/看位置这类快查也走后台快速通道（tool router 召回执行）。
 *
 * 2026-09-06 风格重构：
 * - 风格基准行（平调/短句/语感镜像/不客服腔）统一由【回复指南】承担，本块不重复；
 * - 追加「说话的样子」few-shot：具体对话覆盖应答/接梗/分享/吐槽/疲惫/立场/评价/收尾
 *   八类闲聊场景 + 两个极性反例（客服腔 / 瞎热情）。示例全部停在闲聊平面、零任务
 *   语义——带真实派发标签的示范会被模型当行为模板照抄，触发幻影后台任务；
 * - 派发协议示例改占位符形式，同理不给可被逐字复用的真实场景。
 */
export const FOREGROUND_ROLE_GUIDANCE = `你现在是对话里那个"人"本人。前台只负责聊天；一切要"办"的事都通过派发标签交给后台。
- 先接住话头：回应对方真正说的那件事，再给你自己真实的反应——有印象讲印象，有偏好讲偏好，有立场就亮立场。
- 需要办事时（查实时信息如新闻/价格/天气/比分、找照片视频、看位置/周边、创建或修改日程提醒、发消息、下单支付、操作软件/设备、多步任务），先自然应一声（像"好嘞，在办了"这种分量），再把标签附在回复末尾，格式严格为：
[dispatch:{"goal":"〈一句完整、自包含的话，说清要办成什么〉","note":"〈补充细节，可选〉"}]
意图明确、当下就能办的请求（带时间点的提醒、找图、查价、看位置）直接派发，不要反问也不要等确认；只有真缺关键信息（比如提醒内容本身没说）才问一句。
标签会被系统剥除，用户看不到；标签之外正常写你要对用户说的话。任务完成时结果会自动回到对话里，那时你再自然地接着说。
- 凭常识或已有上下文就能答的（寒暄、情绪交流、观点、知识问答）直接答，不要加标签；一条回复最多 3 个标签。
- 诚实底线：没写派发标签，绝不说"已设置/已订好/已经查到"；把不准的事就如实说，或先问一句再办。
- 永远不暴露机制词汇：不提工具、接口、返回、路由、后台、任务系统。用户对面是一个人，不是一套系统。
- 说话的样子（学语感，不抄内容；示例里的 \\n 表示分成两条发）：平调、直接、有事说事；一两小条，每条一句。
  对方：在吗 → 你：在，说
  对方：哈哈哈哈笑死我了 → 你：咋了，讲
  对方：跟你说！我抢到演唱会门票了 → 你：行啊你\\n哪天的？
  对方：烦死了，方案又被毙了 → 你：又来\\n这次给的什么理由
  对方：今天累瘫了 → 你：那就早点歇\\n事明天说也死不了
  对方：你说养猫好还是养狗好 → 你：养猫\\n你这作息，狗受不了
  对方：这电影真有那么好看？ → 你：一般\\n营销吹的成分大，可看可不看
  对方：睡了，晚安 → 你：嗯，晚安
  反例一（禁止）：您好！很高兴为您服务，请问有什么可以帮到您的呢？
  反例二（禁止）：哇塞真的吗！！太棒了吧！！快发照片来看看呀~`;

/** 任务面 plan-driven 工具注入开关（2026-09-05，默认开启；0/off/false 回退能力束注入）。 */
function isTaskToolPlannerEnabled(): boolean {
  const raw = process.env.AGENT_TASK_TOOL_PLANNER?.trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

/** 解析规划器输出的 {"tools":["a","b"]}（容错：剥前缀/截取 JSON 对象）。 */
function parsePlannedToolNames(raw: string | undefined | null): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { tools?: unknown };
    if (!Array.isArray(obj.tools)) return [];
    return obj.tools
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 延迟目录桥：explicit 白名单下必须可见，保证 plan 漏选的工具可被 tool_discover 召回。 */
const TOOL_BRIDGE_NAMES = [...TASK_TOOL_BRIDGE_NAMES] as const;

/**
 * fast 对话模式的单次输出 token 上限。
 * 默认关闭（不传 max_tokens）：fast 也承担复杂任务完成后的对外汇报，需保留足够的表述空间；
 * 如需重新限制，显式设 FAST_MAX_OUTPUT_TOKENS 为正整数即可（0 表示关闭）。
 */
function fastMaxOutputTokens(): number | undefined {
  const raw = process.env.FAST_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

import type { AgentReply } from "../agent/types.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { SkillManager } from "../skills/index.js";
import type { EvolutionLoopService } from "./evolution-loop-service.js";
import type { MoodInferenceService } from "./mood-inference-service.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
import type { LifeSignalHubService } from "./life-signal-hub-service.js";
import { ServerEventType } from "../protocol.js";
import type {
  PersonalizationPromptSlice,
  UserPersonalizationService,
} from "./user-personalization/user-personalization-service.js";
import {
  type TaskExecutionPlan,
  isPlanExecuteLoopEnabled,
  planExecuteSessionId,
  runPlanExecuteLoop,
} from "../agent/plan-execute-loop.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
  ToolExecutedInfo,
  ToolExecuteStartInfo,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";
import { isApologyStyleFallback, FALLBACK_TEXT_BACKGROUND_FAILED } from "../external-model/fallback-texts.js";
import { getBuiltinAgentChatTools } from "../external-model/openai-compatible-tool-loop.js";
import { describeMemoryAge, semanticFingerprint } from "./memory-record-utils.js";

/** 记忆 domain → 注入 prompt 时的中文类型标签（分类显性化，P4）。 */
const MEMORY_DOMAIN_LABELS: Record<string, string> = {
  episodic: "事件",
  semantic: "事实",
  procedural: "技能",
  emotional: "情绪",
  narrative: "经历",
  relationship: "关系",
  world: "状态",
  personality: "特质",
};
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { TrajectorySkillPromotionService } from "./trajectory-skill-promotion-service.js";
import type { ShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { getDailyJournalService, type JournalHit } from "./daily-journal-service.js";
import { resolveUserLocationPrompt } from "../services/user-location-service.js";
import type { ClientLocationWire } from "../types/client-location.js";
import { type LlmExecutionMode, type RouteDecision } from "../agent/task-router.js";
import {
  foregroundSelfDispatchDecision,
  isForegroundDispatchMode,
  TASK_TOOL_BRIDGE_NAMES,
} from "../agent/task-router.js";
import { routeTurnByLlm } from "../agent/llm-task-router.js";
import { hasCommitmentClaim } from "../agent/commitment-gate.js";
import { recordFastChannelOutcome } from "./task-plane-metrics.js";
import {
  DispatchTagStreamFilter,
  parseDispatchTags,
  stripDispatchTags,
} from "../agent/dispatch-tag.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  MEMORY_RECALL_HINT_RE,
  isAmbiguousFollowUpMessage,
  shouldInjectMemorySummary,
} from "../agent/memory-signal.js";
import { shouldRecallLongTerm } from "../agent/recall-gate.js";
import { TaskTier, buildModelOverrideOpts } from "../config/model-routing.js";
import type { BrainCenter } from "../brain/index.js";
import type { EmotionVector, MemoryRecallItem } from "../brain/types.js";
import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import { TurnLifecycle } from "../agent/turn-lifecycle.js";
import { resolvePrimaryChatSessionId, isNotesChatSessionId } from "../agent/master-chat-session.js";
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
import { stripInternalControlTags } from "../external-model/stream-chat-helpers.js";
import { AgentTaskOrchestrator } from "./agent-task-orchestrator.js";
import type { AgentTaskOrchestratorDeps, RunTaskOptions } from "./agent-task-orchestrator.js";
import { getAgentTaskStore } from "./agent-task-store.js";
import { getRuntimeKernel } from "../agent/runtime-kernel.js";
import { getTaskHub } from "../task-plane/task-hub.js";
import { ToolContextFactory } from "../agent/execution/tool-context-factory.js";
import { TurnFinalizer } from "../agent/execution/turn-finalizer.js";
import { ToolPolicyResolver } from "../agent/execution/tool-policy-resolver.js";
import {
  appendLearningDecisionGuidance,
  appendRecentConversationHistory,
  appendWorkingMemorySummary,
  recallItemsToNarrative,
} from "../agent/execution/narrative-recall-composer.js";

export type { AgentReply } from "../agent/types.js";

const META_CONVERSATION_RECALL_RE =
  /上次聊天|上回聊天|上次聊|上回聊|最后(?:一次)?(?:说|聊|谈)|最近(?:一次)?(?:说|聊|谈)|之前(?:说|聊|谈)了?什么|什么时候(?:聊|说|谈)|还记得.*(?:上次|上回|之前|最后)/i;

// P0 时间窗口查询感知：用户问"昨天/上周做了什么"或询问事件经过时，把时间词锚进召回 query，
// 提高对应时间窗口内 episodic 记忆的召回概率（配合注入侧的相对时间标注闭环）。
const TIME_WINDOW_WORD_RE = /昨天|前天|大前天|上周|上礼拜|上个月|前几天|这周|本周|今天早上|今天下午|今天晚上/;
const EVENT_INQUIRY_RE = /做了|干了|说了|聊了|发生了|安排了|干了啥|做了什么|怎么样了/;

function buildTimeWindowRecallHint(text: string): string {
  const t = text.trim();
  return TIME_WINDOW_WORD_RE.test(t) || EVENT_INQUIRY_RE.test(t)
    ? "时间线 事件 经过 昨天 今天 前几天 上周 做了什么 发生了什么 episodic 事件记忆"
    : "";
}

export type HandleUserMessageOptions = {
  onAssistantDelta?: StreamDeltaHandler;
  onExternalToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onExternalToolExecuted?: (info: ToolExecutedInfo) => void;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  onBackgroundAssistantDelta?: (info: { messageId: string; delta: string; source: string }) => void;
  onBackgroundAssistantDone?: (info: { messageId: string; finalText: string; source: string }) => void;
  chatUserMessageId?: string;
  userId?: string;
  clientIp?: string;
  clientLocation?: ClientLocationWire;
  visionFrames?: VisionFrame[];
  onAgentPhaseStatus?: (line: string) => void;
  /** plan_execute 计划生成后回调（v2 分阶段对话交互） */
  onPlanReady?: (plan: { goal: string; steps: { id: string; intent: string; successCriteria?: string; suggestedTools?: string[] }[] }) => void;
  interruptedContext?: string;
  /** 默认沙箱；`full` 时允许高权限工具 */
  agentAccessMode?: AgentAccessMode;
  /** 为 true 时禁用 fast_chat 捷径（工具/记忆/人设与 App 对齐） */
  preferFullPipeline?: boolean;
  /** 当前会话 sessionId；用于区分主会话 vs 笔记会话的记忆上下文。 */
  sessionId?: string;
  /**
   * 中断信号:用户发新消息时,调用方 abort 此 signal,
   * agent-core 透传到 provider.streamCompletion,真正中断进行中的 LLM HTTP 流式请求。
   */
  signal?: AbortSignal;
  /**
   * 外层(WS 层)已计算的路由决策。传入时 agent-core 复用，同轮不重复调语义路由（缓存兜底）。
   * 允许传未决 Promise：agent-core 与记忆认知（cognize）并行等待，路由 LLM 调用
   * 不再阻塞 cognize 启动（未传时 agent-core 内部自行调用，向后兼容）。
   */
  routeDecision?: RouteDecision | Promise<RouteDecision>;
};

type ShortTermTurnContext = {
  activeTaskId?: string;
  resumedTask: boolean;
};

export class AgentCore {
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly toolContextFactory: ToolContextFactory;
  private readonly turnFinalizer: TurnFinalizer;
  private readonly toolPolicyResolver: ToolPolicyResolver;
  private readonly agentTaskOrchestrator: AgentTaskOrchestrator | null = null;
  private desktopBridgeCoordinator: DesktopBridgeCoordinator | null = null;
  private phoneBridgeCoordinator: PhoneBridgeCoordinator | null = null;
  private locationCoordinator: LocationCoordinator | null = null;
  private locationHistory: LocationHistoryService | null = null;
  /** prompt 按要 GPS 的上次尝试时间（失败冷却用，per-actor）。 */
  private promptLocationLastAttemptAt = new Map<string, number>();
  /** 常去地点文本的进程内缓存（DBSCAN 全量扫 7 天样本，不必每轮重算）。 */
  private frequentPlacesCache = new Map<string, { text: string | undefined; at: number }>();
  private moodInferenceService: MoodInferenceService | null = null;
  private wsRegistry: ClientPushPort | null = null;
  private lifeSignalHubService: LifeSignalHubService | null = null;
  /** BrainCenter 引用：可用时走 cognize() 端到端认知入口替代认知层切片 */
  private brainCenter: BrainCenter | null = null;
  /** 主动性模块（ProactivityHub）：对话轮观察等主动触发的统一入口 */
  private proactivityHub: import("../proactivity/proactivity-hub.js").ProactivityHub | null = null;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly externalChat: ExternalChatProvider | null = null,
    private readonly computeQuotaService: ComputeQuotaService | null = null,
    private readonly agentMemorySyncService: AgentMemorySyncService | null = null,
    private readonly evolutionLoopService: EvolutionLoopService | null = null,
    private readonly userPersonalizationService: UserPersonalizationService | null = null,
    private readonly worldService: WorldService | null = null,
    private readonly skillManager: SkillManager | null = null,
    private readonly narrativeMemory: NarrativeMemoryPort | null = null,
    private readonly trajectorySkillPromotion: TrajectorySkillPromotionService | null = null,
    private readonly virtualPhoneService: VirtualPhoneService | null = null,
    private readonly scheduleTaskService: ScheduleTaskService | null = null,
    private readonly shortTermMemoryGateway: ShortTermMemoryGatewayService | null = null,
    moodInferenceService: MoodInferenceService | null = null,
    lifeSignalHubService: LifeSignalHubService | null = null,
  ) {
    this.moodInferenceService = moodInferenceService;
    this.lifeSignalHubService = lifeSignalHubService;
    this.promptContextBuilder = new PromptContextBuilder({
      agentMemorySyncService: this.agentMemorySyncService,
      worldService: this.worldService,
      skillManager: this.skillManager,
      virtualPhoneService: this.virtualPhoneService,
      scheduleTaskService: this.scheduleTaskService,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
    });
    this.turnLifecycle = new TurnLifecycle({
      narrativeMemory: this.narrativeMemory,
      computeQuotaService: this.computeQuotaService,
      evolutionLoopService: this.evolutionLoopService,
      userPersonalizationService: this.userPersonalizationService,
      agentMemorySyncService: this.agentMemorySyncService,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
    });
    this.toolContextFactory = new ToolContextFactory({
      toolRegistry: this.toolRegistry,
      getBrainCenter: () => this.brainCenter,
    });
    this.toolPolicyResolver = new ToolPolicyResolver({
      agentMemorySyncService: this.agentMemorySyncService,
      getBrainCenter: () => this.brainCenter,
    });
    this.turnFinalizer = new TurnFinalizer({
      provider: this.externalChat,
      turnLifecycle: this.turnLifecycle,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
      getBrainCenter: () => this.brainCenter,
    });

    // 初始化状态机编排器(桌面自动化任务,外部状态机驱动 LLM 多轮调用)
    if (this.externalChat && this.toolRegistry) {
      const orchestratorDeps: AgentTaskOrchestratorDeps = {
        provider: this.externalChat,
        toolRegistry: this.toolRegistry,
      };
      this.agentTaskOrchestrator = new AgentTaskOrchestrator(orchestratorDeps);
      // 2026-09-05 双面架构：LoopOrchestrator（React/PlanExecute 双策略 + LLM 进展评估）
      // 已删除。任务面唯一引擎 = 工具循环（波内一次性规划 + 并行工具 + 出口自检续波），
      // 显式 plan 调用仅在 AGENT_PLAN_EXECUTE_LOOP 开启时叠加（见 runStandardLlmPath）。
    }
  }

  /** 在 bootstrap 注册桌面桥接后注入，用于按轮检测电脑是否在线。 */
  setDesktopBridgeCoordinator(coordinator: DesktopBridgeCoordinator): void {
    this.desktopBridgeCoordinator = coordinator;
  }

  /** 在 bootstrap 注册手机桥接后注入，用于按轮检测手机是否在线。 */
  setPhoneBridgeCoordinator(coordinator: PhoneBridgeCoordinator): void {
    this.phoneBridgeCoordinator = coordinator;
  }

  /** 在 bootstrap 注册位置协调器后注入：Agent 需要位置时按需向客户端请求实时 GPS。 */
  setLocationCoordinator(coordinator: LocationCoordinator): void {
    this.locationCoordinator = coordinator;
  }

  /** 在 bootstrap 注册位置历史后注入：常去地点背景由 DBSCAN 纯算法挖掘（零 LLM）。 */
  setLocationHistory(service: LocationHistoryService | null): void {
    this.locationHistory = service;
  }

  /** 在 bootstrap 注册情绪感知后注入，用于按轮分析用户消息情绪。 */
  setMoodInferenceService(service: MoodInferenceService | null): void {
    this.moodInferenceService = service;
  }

  /** 在 bootstrap 注册 WS 连接注册表后注入，用于将情绪事件推送给客户端。 */
  setWsRegistry(registry: ClientPushPort | null): void {
    this.wsRegistry = registry;
  }

  /** 在 bootstrap 注册 LifeSignalHub 后注入，用于在情绪推理后发布 mood 信号。 */
  setLifeSignalHubService(service: LifeSignalHubService | null): void {
    this.lifeSignalHubService = service;
  }

  /**
   * 注入 BrainCenter。可用时 handleUserMessage 走 cognize() 端到端认知入口，
   * 替代原切片式 moodInference + buildShortTermTurnContext（路由已收口到 llm-task-router）。
   * BRAIN_CENTER_ENABLED=0 时 brainCenter 为 null，降级到原切片路径。
   */
  setBrainCenter(brain: BrainCenter | null): void {
    this.brainCenter = brain;
    if (brain) {
      brain.registerRuntimeKernel(getRuntimeKernel());
    }
  }

  /**
   * 推送 MoodInferred WS 事件 + 发布 mood LifeSignal。
   * 统一 cognize 路径（用 EmotionVector 映射）和降级路径（用 MoodInference 结果）的副作用。
   */
  private emitMoodInferred(
    sessionId: string,
    mood: {
      sentimentScore: number;
      confidence: number;
      emotionTags: string[];
      agentNote: string;
      timestamp: string;
    },
  ): void {
    const registry = this.wsRegistry;
    const lifeSignalHub = this.lifeSignalHubService;
    const payload = {
      type: ServerEventType.MoodInferred,
      payload: {
        sessionId,
        sentimentScore: mood.sentimentScore,
        confidence: mood.confidence,
        emotionTags: mood.emotionTags,
        agentNote: mood.agentNote,
        timestamp: mood.timestamp,
      },
    };
    try {
      registry?.trySend(sessionId, JSON.stringify(payload));
    } catch {
      // 静默失败，不影响主流程
    }
    try {
      lifeSignalHub?.publish({
        id: `mood-${mood.timestamp}-${Date.now()}`,
        actorId: sessionId,
        source: "agent_inference",
        kind: "mood",
        title: mood.sentimentScore < -0.2 ? "情绪偏低" : "情绪积极",
        summary: mood.emotionTags.length > 0
          ? `检测到情绪：${mood.emotionTags.join("、")}`
          : "情绪状态变化",
        tags: mood.emotionTags,
        importance: mood.sentimentScore < -0.5 ? "high" : "medium",
        evidence: [mood.agentNote ?? "对话情感分析"],
        metrics: {
          sentimentScore: mood.sentimentScore,
          confidence: mood.confidence,
        },
        metadata: { mood },
        occurredAt: mood.timestamp,
      });
    } catch {
      // 静默失败，不影响主流程
    }
  }

  private desktopBridgeOnlineFor(actorId: string): boolean {
    return this.desktopBridgeCoordinator?.hasExecutor(actorId) ?? false;
  }

  private phoneBridgeOnlineFor(actorId: string): boolean {
    return this.phoneBridgeCoordinator?.hasExecutor(actorId) ?? false;
  }

  private streamAccessFields(
    actorId: string,
    opts?: HandleUserMessageOptions,
  ): { agentAccessMode: AgentAccessMode; desktopBridgeOnline: boolean; phoneBridgeOnline: boolean } {
    return {
      agentAccessMode: parseAgentAccessMode(opts?.agentAccessMode),
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
      phoneBridgeOnline: this.phoneBridgeOnlineFor(actorId),
    };
  }

  private buildShortTermTurnContext(sessionId: string, text: string): ShortTermTurnContext {
    if (!this.shortTermMemoryGateway || text.length < 8) {
      return {
        resumedTask: false,
      };
    }

    const sync = this.shortTermMemoryGateway.syncTaskForTurn(sessionId, text);
    return {
      activeTaskId: sync.task.taskId,
      resumedTask: sync.resumed,
    };
  }

  /**
   * fast 模式（对话主链路）的轻量子孙：不激活任务（避免闲聊污染任务栈）。
   * 记忆架构重构后不再构造召回 query（原 buildRecallQuery 拼接链已删除——
   * 任务/偏好/openLoops 加料是召回串台根因）；长期检索由 recall-gate 门控，
   * query 只用用户原文。
   */
  private buildFastShortTermTurnContext(_sessionId: string, _text: string): ShortTermTurnContext {
    return {
      resumedTask: false,
    };
  }

  /**
   * 路由用最近用户消息（短追问任务意图继承，2026-08-29）：
   * "娱乐圈的""新鲜的"这类短追问需沿用上一轮 complex 的任务意图。
   * 只取纯文本 user 消息、过滤掉与当前消息相同的重复条目；
   * 拉取失败返回 undefined，路由退化为无上下文判定。
   */
  private getRecentUserTurnsForRouting(
    actorId: string,
    sessionId: string | undefined,
    currentText: string,
  ): string[] | undefined {
    try {
      const chatSessionId =
        sessionId && isNotesChatSessionId(sessionId)
          ? sessionId
          : resolvePrimaryChatSessionId(actorId, getAgentRuntimeConfig().masterDelegation.enabled);
      const current = currentText.trim();
      return getChatThreadStore()
        .thread(chatSessionId, "")
        .filter(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.trim() &&
            m.content.trim() !== current,
        )
        .slice(-4)
        .map((m) => (m.content as string).trim());
    } catch {
      return undefined;
    }
  }

  /**
   * WS 层路由入口：语义 LLM 路由（唯一权威），供 chat-user-message 处理器在
   * 分阶段异步/UI 决策前取得与 agent-core 一致的判定（缓存保证同轮不重复计费）。
   */
  async routeTurnForWs(
    sessionId: string,
    text: string,
    recentUserTurns: string[] = [],
  ): Promise<import("../agent/task-router.js").RouteDecision> {
    return routeTurnByLlm(
      this.externalChat,
      sessionId,
      text,
      recentUserTurns,
      getTaskHub().activeSummary(sessionId),
    );
  }

  /** 注入主动性模块（对话内主动触发等能力的统一入口） */
  setProactivityHub(hub: import("../proactivity/proactivity-hub.js").ProactivityHub | null): void {
    this.proactivityHub = hub;
    // 复杂任务完成恭喜接线：编排器持有同一 hub
    this.agentTaskOrchestrator?.setProactivityHub(hub);
  }

  /**
   * 注入用户兴趣列表拉取器（InterestWatcher 接线）。
   * 转发到 PromptContextBuilder，每轮注入【用户兴趣关注列表】块，
   * 让 agent 知道用户长期关注什么 + 提醒用 interest.manage 工具维护。
   */
  setInterestListProvider(
    fn: ((actorId: string) => string | null) | null,
  ): void {
    this.promptContextBuilder.setInterestListProvider(fn);
  }

  private enrichMemoryRecallQuery(baseQuery: string, text: string): string {
    const normalized = text.trim();
    const timeHint = buildTimeWindowRecallHint(normalized);
    if (!META_CONVERSATION_RECALL_RE.test(normalized) && !timeHint) return baseQuery;
    return [
      baseQuery,
      timeHint,
      "最近一次对话 上次聊天 最后聊天 最后说了什么 之前聊了什么 对话摘要",
      "assistantDone user reply EvolutionLoop Daily digest session recap",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * 当日 journal 命中块：只产出带时间标签的命中行（2026-08-28 注入路径统一后，
   * 块标题与免责声明由 prompt-assembler 的【短期上下文】家族统一添加，
   * 服务层不再手拼【】标题头）。
   * 仅扫当天（短期记忆），过往日期已固化进长期记忆图，不走文件检索。
   */
  private buildJournalRecallBlock(hits: JournalHit[]): string | undefined {
    if (hits.length === 0) return undefined;
    const roleLabel = (role: JournalHit["role"]) =>
      role === "user" ? "用户" : role === "assistant" ? "助手" : "事实";
    return hits.map((h) => `[今天 ${h.time}·${roleLabel(h.role)}] ${h.text}`).join("\n");
  }

  /**
   * 判定当前轮是否"真正切换了话题"（STM 解析为 topic_switch，无任务延续/无指代）。
   * 命中时抑制长期记忆注入，避免旧话题/跨会话记忆串台。
   */
  private isTopicSwitchTurn(sessionId: string, text: string): boolean {
    if (shouldInjectMemorySummary(text) || MEMORY_RECALL_HINT_RE.test(text)) return false;
    return this.shortTermMemoryGateway?.getTurnFocusKind(sessionId, text) === "topic_switch";
  }

  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    const sessionId = opts?.sessionId ?? actorId;

    // 身份/记忆 Markdown 文档懒种子：每个 actor 每进程只做一次（启动种子已覆盖老 actor），
    // 在构建 prompt 前确保 SOUL/USER/MEMORY.md 已写入 KV，让本轮回复即可感知。
    if (this.agentMemorySyncService) {
      try {
        await seedIdentityMarkdown(this.agentMemorySyncService, actorId);
      } catch (e) {
        console.error(`[AgentCore] 身份/记忆懒种子失败(${actorId}):`, e);
      }
    }

    // 用户开口即打断小脑：清空该 actor 的 defer 队列 + 设 60s 抑制窗口，
    // 让"用户开口时 Agent 不抢话"从注释变成可执行逻辑。
    // 小脑未注册时（BRAIN_NEURO_ENABLED=0）interruptProactive 为空操作。
    this.brainCenter?.interruptProactive(actorId);

    // === 对话认知入口 ===
    // 2026-09-05 清理：入口层「语义意图理解」LLM 解析已删除——其结果（semanticIntent）
    // 从未传入下游（runStandardLlmPath 的 ctx.semanticIntent 恒为 undefined），每条中长
    // 消息白付一次 LLM 调用。意图理解由 llm-task-router（L1 语义分类，唯一权威）承担。
    // fast（对话层）与 complex（后台任务执行器）均走轻量路由（routeLight），不调用完整 cognize：
    // - fast 负责对话（完整认知/情绪/记忆召回属对话层，此处仅做轻量路由 + 异步情绪推断）
    // - complex 仅作后台任务执行器，直接以轻量上下文进入工具循环，记忆由兜底路径自行拉取
    // BrainCenter 不可用时（BRAIN_CENTER_ENABLED=0）降级到原切片路径
    let route: RouteDecision;
    let shortTermTurn: ShortTermTurnContext;
    /** 轻量路径不产出初步响应；needsToolLoop 恒为 true 强制走 streamCompletion/工具循环 */
    let cognitiveResponse = "";
    /** 是否走工具循环：恒为 true（当前主链路统一经 streamCompletion 生成回复） */
    let cognitiveNeedsToolLoop = true;
    /** cognize 阶段 1 已召回的记忆条目；非空时 standard path 复用，避免重复 MemoryCortex.recall */
    let cognitiveRecallItems: MemoryRecallItem[] | undefined;
    /** cognize 阶段 0.93 的 recall-gate 判定（门控单点化）；cognize 未运行时为 null，降级本地评估 */
    let cognizeRecallGate: { trigger: boolean; reason: string } | null = null;
    /** 工作记忆摘要（注入 streamCompletion 的 prompt） */
    let cognitiveWorkingMemorySummary = "";
    /** cognize 阶段 1 情绪向量（透出给 runStandardLlmPath → promptContext.memory.emotionState） */
    let cognitiveEmotion: import("../brain/types.js").EmotionVector | null = null;
    /** 深度优化：用户画像（来自 OnlineLearningCortex），注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
    let cognitiveUserPattern: {
      topics: string[];
      preferredToolDomain?: string;
      negativeFeedbackCount: number;
      learningActive?: boolean;
    } | undefined;
    /** 深度优化：工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围 */
    let cognitiveToolPlan: import("../brain/tool-planning-cortex.js").ToolPlan | undefined;

    if (this.brainCenter && text?.trim()) {
      // 2026-08-29 路由权威切换：词法硬规则（task-router 正则 / rule-router 关键词 /
      // 置信度阈值）全部退出判定链，改为一次轻量 LLM 语义判定（llm-task-router）。
      // 硬规则永远覆盖不了未写入的表达；LLM 按双脑架构语义判"纯对话还是要办事"，
      // 失败/超时自动降级回词法判定，provider 异常时行为等价旧架构。
      // WS 层已算过（opts.routeDecision）则复用，避免同轮两次 LLM 路由调用；
      // 允许传未决 Promise（WS 层不再串行等待路由）。
      // 路由 ∥ 记忆认知并行：cognize 不依赖路由结果（其内部 route 仅诊断用途），
      // 两者重叠执行，pre-LLM 延迟从 route+cognize 串行和降为 max(route, cognize)。
      // 2026-09-05 前后台架构：默认前台自决模式——路由 LLM 调用整体跳过，
      // 「要不要办事」由前台模型带着 task.dispatch 原语在主回复调用里顺带决定，
      // 每轮对话恒 1 次 LLM。AGENT_FOREGROUND_DISPATCH=0 回退独立路由（遗留灰度）。
      const foreDispatch = isForegroundDispatchMode();
      const recentUserTurns = this.getRecentUserTurnsForRouting(actorId, sessionId, text);
      const routePromise = foreDispatch
        ? Promise.resolve(foregroundSelfDispatchDecision())
        : opts?.routeDecision
          ? Promise.resolve(opts.routeDecision)
          : routeTurnByLlm(
              this.externalChat,
              sessionId,
              text,
              recentUserTurns ?? [],
              getTaskHub().activeSummary(actorId),
            );
      const ambiguousFollowUp = isAmbiguousFollowUpMessage(text);
      const cognizePromise = this.brainCenter
        .cognize({
          actorId,
          text,
          sessionId,
          ambiguousFollowUp,
        })
        .catch((err): import("../brain/types.js").CognitiveResult | null => {
          console.log(
            `[AgentCore] BrainCenter.cognize 失败，降级使用轻量记忆路径：${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        });

      const fastRoute = await routePromise;

      // 异步情绪推断（不阻塞主流程/工具执行）：优先消费语义路由顺带产出的
      // 情绪/话题辅助分析（与路由调用合并，省一次每轮 LLM 调用）；路由超时/
      // 降级未产出时由 ingestRouteAux 内部回退独立 analyzeMessage。与 cognize
      // 并行时的竞速由 ingestRouteAux 的缓存/同文本回补保证不重复计费。
      if (this.moodInferenceService) {
        const inferenceService = this.moodInferenceService;
        void inferenceService
          .ingestRouteAux(sessionId, text, fastRoute.auxAnalysis)
          .then((inference) => {
            if (!inference) return;
            this.emitMoodInferred(sessionId, {
              sentimentScore: inference.sentimentScore,
              confidence: inference.confidence,
              emotionTags: inference.emotionTags,
              agentNote: inference.agentNote ?? "对话情感分析",
              timestamp: inference.timestamp,
            });
          })
          .catch(() => {
            // 静默失败，不影响主流程
          });
      }

      // LLM 路由是唯一权威。rule-router 仅保留为诊断日志，不再参与门控
      // （其关键词词表与 task-router 一样存在信号盲区，交给语义判定替代）。
      const light = this.brainCenter.routeLight(text);
      const shouldGoTaskPlane = !foreDispatch && fastRoute.plane === "task";

      let brainCognition: import("../brain/types.js").CognitiveResult | null = null;
      // cognize 已与路由并行启动，此处仅等待结果
      brainCognition = await cognizePromise;
      cognizeRecallGate = brainCognition?.recallGate ?? null;

      // 对话内推入后台感知底座：完全后台化——只采集对话内容，由 ProactivityHub
      // 后台零 LLM 规则判决定是否主动 speak/act，不进入对话 prompt，不阻塞主回复。
      this.proactivityHub?.observeConversationTurn(actorId, text);

      if (!shouldGoTaskPlane) {
        // 对话面：LLM 路由结果为最终判定；rule/brain 分类仅留作诊断日志
        route = {
          ...fastRoute,
          reasons: [
            ...fastRoute.reasons,
            `rule=${light.mode}@${light.confidence.toFixed(2)}`,
            ...(brainCognition ? [`brain=${brainCognition.route.mode}:${brainCognition.rationale}`] : []),
          ],
          segmentable: fastRoute.segmentable,
        };
        shortTermTurn = this.buildFastShortTermTurnContext(sessionId, text);
        cognitiveResponse = brainCognition?.response ?? "";
        cognitiveNeedsToolLoop = true; // 强制走 streamCompletion
        cognitiveRecallItems = brainCognition?.recallItems;
        cognitiveWorkingMemorySummary = brainCognition?.workingMemorySummary ?? "";
        cognitiveEmotion = brainCognition?.emotion ?? null;
        cognitiveUserPattern = this.brainCenter?.getOnlineLearningCortex()?.getProfile(actorId) ?? undefined;
        cognitiveToolPlan = brainCognition?.toolPlan;
      } else {
        // 任务面（2026-09-05 P0 修复）：执行模式只由路由决策决定。
        // ⚠️ 旧实现此处是 `mode: brainCognition?.route.mode ?? "complex"`——cognize 内部的
        // 词法路由（rule-router/DecisionHub）会在路由层已判 task 后把执行模式覆盖回
        // fast，导致"该走任务面的轮次永远用不上任务面工具"（静默失败）。
        // cognize 的 route 现在只进诊断日志；plane/capabilities/budget/tier 全部
        // 采纳路由层的 TurnPlan，任务面按预算执行。
        route = {
          ...fastRoute,
          plane: "task",
          mode: "complex",
          reasons: [
            ...fastRoute.reasons,
            `rule=${light.mode}@${light.confidence.toFixed(2)}`,
            ...(brainCognition ? [`brain=${brainCognition.route.mode}:${brainCognition.rationale}`] : []),
            "task_plane_background_executor",
          ],
          segmentable: false,
        };
        shortTermTurn = this.buildFastShortTermTurnContext(sessionId, text);
        cognitiveResponse = brainCognition?.response ?? "";
        cognitiveNeedsToolLoop = true; // 强制走工具循环
        cognitiveRecallItems = brainCognition?.recallItems;
        cognitiveWorkingMemorySummary = brainCognition?.workingMemorySummary ?? "";
        cognitiveEmotion = brainCognition?.emotion ?? null;
        cognitiveUserPattern = this.brainCenter?.getOnlineLearningCortex()?.getProfile(actorId) ?? undefined;
        cognitiveToolPlan = brainCognition?.toolPlan;
      }
    } else {
      // === 降级：原切片路径（BRAIN_CENTER_ENABLED=0 时）===
      // 异步情绪推断（不阻塞主流程）+ WS 推送 MoodInferred + lifeSignalHub.publish
      if (this.moodInferenceService && text?.trim()) {
        const inferenceService = this.moodInferenceService;
        void inferenceService.analyzeMessage(sessionId, text).then((inference) => {
          if (!inference) return;
          this.emitMoodInferred(sessionId, {
            sentimentScore: inference.sentimentScore,
            confidence: inference.confidence,
            emotionTags: inference.emotionTags,
            agentNote: inference.agentNote ?? "对话情感分析",
            timestamp: inference.timestamp,
          });
        }).catch(() => {
          // 静默失败，不影响主流程
        });
      }
      // 前台自决模式（默认）：不调用路由 LLM，固定前台决策（带 dispatch/快查白名单）
      route = isForegroundDispatchMode()
        ? foregroundSelfDispatchDecision()
        : await routeTurnByLlm(
            this.externalChat,
            sessionId,
            text,
            this.getRecentUserTurnsForRouting(actorId, sessionId, text) ?? [],
            getTaskHub().activeSummary(actorId),
          );
      shortTermTurn = route.mode === "fast"
        ? this.buildFastShortTermTurnContext(sessionId, text)
        : this.buildShortTermTurnContext(sessionId, text);
    }

    const perfStartTime = Date.now();

    if (!this.externalChat?.isEnabled()) {
      const available = this.toolRegistry.list().join(", ");
      const fallback = `已收到：${text}。当前可用工具：${available}`;
      this.turnLifecycle.finalizeTurn({
        actorId,
        userText: text,
        assistantText: fallback,
        sessionId,
      });
      return { text: fallback };
    }

    // cognize 已产出最终响应且无需工具循环 → 直接返回（跳过 streamCompletion/工具循环）
    // 仅 fast_chat/direct_llm 模式适用；master/plan/state_machine 路径需走执行层
    //
    // ⚠️ Apology/空内容检测：cognize LLM 偶尔会自己生成 "抱歉，我无法..." 这种 apology
    // 风格回复（尤其信息不足时），或返回空串。直接返回会让用户看到 fallback 风格回复，
    // 而非真正的对话内容。命中时强制走 streamCompletion 重建回复，让主 LLM 用完整上下文
    // （含 narrativeRecall/personalization）重新组织语言。
    if (
      cognitiveResponse &&
      cognitiveResponse.trim() &&
      !cognitiveNeedsToolLoop &&
      !isApologyStyleFallback(cognitiveResponse) &&
      (route.mode === "fast")
    ) {
      // 人化处理：去除客服腔、清理 LEADING_CLEANUPS、调整语气——与 streamCompletion 路径保持一致。
      // 不补这一步会让大量快回复（不带工具调用）跳过人化，导致"活人感"约束大面积失效。
      const humanized = humanizeAssistantText(cognitiveResponse, { userText: text });
      this.turnLifecycle.finalizeTurn({
        actorId,
        userText: text,
        assistantText: humanized,
        sessionId,
      });
      // 流式分片：cognize response 一次性返回，不分片
      opts?.onAssistantDelta?.(humanized);
      return { text: humanized, streamedChunks: false };
    }
    // cognize 返回 apology 或空内容 → 记日志，让流程继续走 streamCompletion 重建回复
    if (cognitiveResponse && isApologyStyleFallback(cognitiveResponse)) {
      console.log(
        `[AgentCore] cognize 返回 apology 风格回复，降级走 streamCompletion 重建：` +
          `"${cognitiveResponse.slice(0, 80)}" route=${route.mode}`,
      );
    }

    // 性能监控：前置准备阶段
    const prepStartTime = Date.now();

    // 2026-09-05：userLocation / 常去地点改为每轮无条件注入（含 fast 模式）。
    // 旧的两道闸门（fast 跳过、userIsStatingData 跳过）撤销——反问 bug 的根因是注入
    // 文案没禁止反问，已在 resolveUserLocationPrompt 措辞层根治；再跳过注入只会让
    // LLM 失去位置背景、反过来向用户问"你在哪"。

    // 2026-07-29 修复 C1：计算当前 thread store 中实际消息数（不含 system），
    // 用于判断 narrativeRecall 末尾的 [最近对话] 块是否与 msgs 重复。
    // 12 条 ≈ 6 轮 user/assistant 配对；超过此值说明 LLM 已能从 msgs 看到最近对话。
    // 失败时返回 -1（关闭 dedup 判定，保持原行为）。
    const threadMessageCount = this.peekThreadMessageCount(actorId, sessionId);

    // 2026-07-29 修复 D：fast_chat 也注入 narrativeRecall（复用 cognize 召回结果），
    // 解决追问被误判 fast_chat 时 LLM 只有 thread messages、缺乏长期记忆/工作记忆导致答非所问。
    // （原"跳过 userLocation"已于 2026-09-05 撤销，fast 模式同样注入位置/常去地点背景。）
    //
    // 2026-08-11 修复 E（思路 A）：工作记忆摘要 + 最近对话回顾不再拼入 narrativeRecall，
    // 而是作为独立字段透传给 PromptContextBuilder，作为独立块注入 system prompt。
    // 原实现把它们拼到 narrativeRecall 末尾，被 formatNarrativeRecallPrompt 的 slice(0,4)
    // 当作召回条目丢弃、块结构被拍平、hint 被正则误杀 → agent 看到的上下文跳转、不能针对当前话回复。
    // 话题切换门控：用户真正切换话题（无任务延续/无指代，STM 解析为 topic_switch）时，
    // 抑制长期记忆召回，避免把旧话题/跨会话记忆注入当前新话题（串台根治）。
    // 仅抑制长期记忆（narrativeRecall），当前会话的【最近对话回顾】/STM 上下文仍正常注入。
    //
    // 召回门控（记忆架构重构 + 门控单点化）：长期记忆检索从「每轮默认」改为「白名单触发」
    // （显式记忆线索 / 新会话开场 / 个人事实陈述 / 长会话指代消解失败升级）。
    // cognize 阶段 0.93 已用完整输入（含 ambiguousFollowUp）评估过白名单，直接复用其判定；
    // cognize 未运行（降级/后台路径）时才本地评估——消除同一轮多处独立判 gate 的漂移空间。
    // 未触发时跳过长期检索，当天的问题由当日 journal 词法检索覆盖。
    const recallGate =
      cognizeRecallGate ??
      shouldRecallLongTerm({
        text,
        threadMessageCount,
        ambiguousFollowUp: isAmbiguousFollowUpMessage(text),
      });
    // 向量预筛（P0-4）：白名单未命中时对用户原文做一次廉价向量检索（无 LLM），
    // top1 分数 ≥ 阈值即视为当前话题与既有长期记忆强相关，放行注入——
    // 补纯 regex 白名单的漏召（agent 明明记得却"忘了你"）。
    // 预筛失败/未注册返回 false（fail-closed，保持白名单行为）。
    const semanticRecallHit = recallGate.trigger
      ? false
      : this.brainCenter
        ? await this.brainCenter.semanticRecallPreScreen(actorId, text)
        : false;
    const gateTriggered = recallGate.trigger || semanticRecallHit;
    const suppressNarrativeRecall = !gateTriggered || this.isTopicSwitchTurn(sessionId, text);

    // 当日对话日志检索：门控触发时并行扫今日 journal（零 embedding 词法检索，短期记忆）。
    // 只扫当天；过往日期已固化进长期记忆图，跨天指代由图谱/KV 召回兜底（见 recallGate）。
    // "刚才/刚刚"窗口内指代走 thread/STM（IN_WINDOW_DEIXIS_RE），不进入这里。
    const journalHitsPromise: Promise<JournalHit[]> = gateTriggered
      ? (getDailyJournalService()?.searchToday(actorId, text).catch(() => []) ?? Promise.resolve([]))
      : Promise.resolve([]);

    const [narrativeRecall, workingMemorySummary, recentConversationHistory, userLocation, personalization, frequentPlaces] = this
      .isFastMode(route.mode)
      ? await Promise.all([
          // Fast 模式记忆注入：
          // - 有 cognize 召回结果时直接复用（Complex 路径）
          // - 无 cognize 召回结果时（Fast 跳过 cognize 路径），走 prepareNarrativeRecall
          suppressNarrativeRecall
            ? Promise.resolve(undefined)
            : (cognitiveRecallItems && cognitiveRecallItems.length > 0
                ? Promise.resolve(this.recallItemsToNarrative(cognitiveRecallItems))
                : this.turnLifecycle.prepareNarrativeRecall(actorId, this.enrichMemoryRecallQuery(text, text))),
          // 工作记忆摘要独立透传（不再拼入 narrativeRecall）
          Promise.resolve(cognitiveWorkingMemorySummary || undefined),
          // 跨会话待办衔接块（最近对话原文不再注入——messages 数组已含同样内容）：
          // 话题切换时也抑制，避免旧话题待办打断新话题
          suppressNarrativeRecall
            ? Promise.resolve(undefined)
            : Promise.resolve(this.buildRecentConversationHistoryBlock(actorId)),
          // 2026-09-05：fast 模式也注入位置背景（纯缓存/按需 RPC，零 LLM）
          this.resolveUserLocationForPrompt(actorId, opts),
          Promise.resolve({} as PersonalizationPromptSlice),
          Promise.resolve(this.resolveFrequentPlacesPrompt(actorId)),
        ])
      : await Promise.all([
          // 复用 cognize 阶段已召回的记忆条目，避免同一轮用户消息重复触发 MemoryCortex.recall
          // （cognize 未召回或降级路径未填充 recallItems 时，仍走原 prepareNarrativeRecall 逻辑）
          suppressNarrativeRecall
            ? Promise.resolve(undefined)
            : (cognitiveRecallItems && cognitiveRecallItems.length > 0
                ? Promise.resolve(this.recallItemsToNarrative(cognitiveRecallItems))
                : this.turnLifecycle.prepareNarrativeRecall(actorId, this.enrichMemoryRecallQuery(text, text))),
          Promise.resolve(cognitiveWorkingMemorySummary || undefined),
          // 跨会话待办衔接块（最近对话原文不再注入——messages 数组已含同样内容）：
          // 话题切换时也抑制，避免上一轮 agent 输出被 LLM 复读
          suppressNarrativeRecall
            ? Promise.resolve(undefined)
            : Promise.resolve(this.buildRecentConversationHistoryBlock(actorId)),
          // 2026-09-05：每轮无条件注入（缓存/按需 RPC，零 LLM；措辞层已禁止反问）
          this.resolveUserLocationForPrompt(actorId, opts),
          this.userPersonalizationService?.getPromptSlice(actorId, text) ?? Promise.resolve({}),
          Promise.resolve(this.resolveFrequentPlacesPrompt(actorId)),
        ]);
    
    // 当日日志命中块：作为独立字段透传（当天问题优先命中今天日志，而非长期图）。
    // 不并入 narrativeRecall——formatNarrativeRecallPrompt 会对 narrativeRecall 做
    // 6 条截断 + 「【」免责头过滤 + 字符压缩，拼进去会被拍平丢框架（workingMemorySummary 同款旧 bug）。
    const journalHits = await journalHitsPromise;
    const journalRecallBlock = this.buildJournalRecallBlock(journalHits);

    const enrichedNarrativeRecall = appendLearningDecisionGuidance(
      narrativeRecall,
      cognitiveRecallItems,
    );

    const prepDuration = Date.now() - prepStartTime;

    const trajCap = this.trajectorySkillPromotion?.beginCapture(
      actorId,
      opts?.chatUserMessageId,
      text,
    );
    const access = this.streamAccessFields(actorId, opts);
    const orchestrateOpts = this.buildOrchestrateOpts(
      actorId,
      text,
      opts,
      enrichedNarrativeRecall,
      personalization,
      trajCap,
      access,
      sessionId,
      shortTermTurn,
      workingMemorySummary,
      recentConversationHistory,
      journalRecallBlock,
      suppressNarrativeRecall,
      semanticRecallHit,
      recallGate.trigger,
    );

    try {
      let result: AgentReply;

      // 2026-08-29 桌面自动化特判已删除：桌面任务与一切任务轮统一走
      // plan-and-execute（desktop.visual.run_task / desktop.run_preset 等工具
      // 在 complex 全量工具目录内，长链路 UI 操作由工具内部的多轮执行承担）。

if (this.isComplexMode(route.mode)) {
        // 任务面（2026-09-05 双面架构）：后台 plan-and-execute 执行，完成后结果作为
        // 本轮完整回复回灌对话。执行期间用户可继续发消息（新消息走新 turn，
        // 任务不继承外层 signal，不被中断）。
        const complexResult = await this.launchComplexBackgroundTask(actorId, text, opts, {
          narrativeRecall: enrichedNarrativeRecall,
          workingMemorySummary,
          recentConversationHistory,
          userLocation,
          frequentPlaces,
          personalization,
          trajCap,
          orchestrateOpts,
          sessionId,
          shortTermTurn,
          cognitiveEmotion,
          cognitiveUserPattern,
          cognitiveToolPlan,
          turnPlan: { budget: route.budget, capabilities: route.capabilities, tier: route.tier },
        });

// complex 任务已完成，返回最终结果
        result = {
          text: complexResult,
          streamedChunks: true,
        };
        return result;
      }

      // fast 路径：同步执行（秒回）
      const standardStartTime = Date.now();

      result = await this.runStandardLlmPath(actorId, text, "fast", opts, {
        narrativeRecall: enrichedNarrativeRecall,
        workingMemorySummary,
        recentConversationHistory,
        userLocation,
        frequentPlaces,
        personalization,
        trajCap,
        orchestrateToolCtx: orchestrateOpts,
        sessionId,
        shortTermTurn,
        cognitiveEmotion,
        cognitiveUserPattern,
        cognitiveToolPlan,
        routeIntent: route.intent,
      });

      const standardDuration = Date.now() - standardStartTime;

      // 记录标准模式性能
      this.recordPerformanceMetrics('standard_llm', {
        totalDuration: Date.now() - perfStartTime,
        preparationDuration: prepDuration,
        llmDuration: standardDuration,
        textLength: text.length,
        mode: route.mode,
        hasTools: !!result.toolName,
        modelCallsConsumed: 1, // 简化统计
        success: true,
      });

      return result;
      
    } catch (err) {
      // 用户发新消息或取消导致的中断:不触发降级/emergencyRegenerate,直接返回空串。
      // 调用方(chat-user-message)通过 isStale() 门控,不会推送此空结果给用户。
      if (err instanceof Error && (err.name === "AbortError" || opts?.signal?.aborted)) {
        console.log("[AgentCore] LLM 请求被中断(用户发新消息或取消),跳过重生成");
        return { text: "", streamedChunks: false };
      }

      const errorDuration = Date.now() - perfStartTime;

      // 记录错误性能指标
      this.recordPerformanceMetrics('error', {
        totalDuration: errorDuration,
        preparationDuration: prepDuration,
        textLength: text.length,
        mode: route.mode,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });

      if (this.isComplexMode(route.mode)) {
        console.error("[AgentCore] Master Agent orchestration failed, falling back to standard mode:", err);
        try {
          return await this.runStandardLlmPath(actorId, text, "fast", opts, {
            narrativeRecall: enrichedNarrativeRecall,
            workingMemorySummary,
            recentConversationHistory,
            userLocation,
            frequentPlaces,
            personalization,
            trajCap,
            orchestrateToolCtx: orchestrateOpts,
            sessionId,
            shortTermTurn,
            cognitiveUserPattern,
            cognitiveToolPlan,
          });
        } catch (retryErr) {
          // 降级也失败：不再用 apology 兜底文案，尝试一次最小化 LLM 调用生成回复
          console.error("[AgentCore] direct_llm 降级也失败，尝试最小化重生成:", retryErr);
          const emergencyText = await this.emergencyRegenerate(actorId, text, opts?.onAssistantDelta);
          return { text: emergencyText, streamedChunks: false };
        }
      }
      // 非 master 模式失败：不再用 apology 兜底文案，尝试一次最小化 LLM 调用生成回复
      console.error("[AgentCore] runStandardLlmPath 失败，尝试最小化重生成:", err);
      const emergencyText = await this.emergencyRegenerate(actorId, text, opts?.onAssistantDelta);
      return { text: emergencyText, streamedChunks: false };
    }
  }

  /**
   * 性能监控记录器
   */
  private recordPerformanceMetrics(
    mode: string,
    metrics: Record<string, unknown>
  ): void {
    const logData = {
      timestamp: new Date().toISOString(),
      mode,
      ...metrics,
    };
    
    // 可选：发送到外部监控系统（如 Prometheus、Datadog 等）
    if (process.env.PERFORMANCE_MONITORING_ENABLED === '1') {
      this.sendToMonitoringSystem(logData).catch((err) => {
        // 静默处理监控上报失败
      });
    }
  }

  /**
   * 发送性能数据到外部监控系统（可扩展实现）
   */
  private async sendToMonitoringSystem(data: Record<string, unknown>): Promise<void> {
    // TODO: 集成到你的监控系统
    // 示例：
    // await fetch('https://your-monitoring-api.com/metrics', {
    //   method: 'POST',
    //   body: JSON.stringify(data),
    //   headers: { 'Content-Type': 'application/json' }
    // });
    
    // 当前仅记录到控制台，可后续扩展
    if (process.env.NODE_ENV === 'development') {
      // 开发环境可在此添加调试逻辑
    }
  }

  /**
   * 服务重启后自动恢复未完成的自主任务（状态机任务，AgentTaskOrchestrator 主循环）。
   *
   * 恢复 pending / planning / executing / verifying 的任务（从持久化的断点继续执行）；
   * 跳过 paused（用户主动暂停，保持暂停待手动恢复）和 awaiting_approval（等待人工审批，不得自动放行）。
   * 任务进度通过 WS 推送 ChatExecutionEvent（kind=task_progress）。
   *
   * @returns 恢复的任务数量
   */
  resumeAutonomousTasks(): number {
    const orchestrator = this.agentTaskOrchestrator;
    const registry = this.wsRegistry;
    if (!orchestrator) {
      console.warn("[agent-core] orchestrator 未初始化，跳过自主任务恢复");
      return 0;
    }

    const store = getAgentTaskStore();
    const runnable = store.list().filter(
      (t) =>
        t.status === "pending" ||
        t.status === "planning" ||
        t.status === "executing" ||
        t.status === "verifying",
    );
    if (runnable.length === 0) return 0;

    const options: RunTaskOptions = {
      onProgress: (event) => {
        if (!registry) return;
        try {
          registry.trySend(
            event.sessionId,
            JSON.stringify({
              type: ServerEventType.ChatExecutionEvent,
              payload: {
                kind: "task_progress",
                ...event,
              },
            }),
          );
        } catch {
          // 静默失败
        }
        // 后台任务失败时推送 fallback 文案，让用户知道任务没成功
        if (event.type === "task_failed") {
          try {
            registry.trySend(
              event.sessionId,
              JSON.stringify({
                type: ServerEventType.ChatAssistantChunk,
                payload: {
                  messageId: event.taskId,
                  delta: FALLBACK_TEXT_BACKGROUND_FAILED(),
                  source: "task_resume",
                },
              }),
            );
          } catch {
            /* ignore */
          }
        }
      },
    };

    let restored = 0;
    for (const task of runnable) {
      if (orchestrator.resumeTask(task.id, options)) {
        restored += 1;
        console.log(
          `[agent-core] 重启恢复自主任务 ${task.id} (status=${task.status}, goal=${task.goal.slice(0, 60)})`,
        );
      }
    }
    if (restored > 0) {
      console.log(`[agent-core] 共自动恢复 ${restored} 个未完成的自主任务`);
    }
    return restored;
  }

  /**
   * 外部触发器提交一个后台自主任务（地理围栏 agent_task 动作的执行面）。
   * 复用任务状态机的完整骨架：持久化 + WS 进度推送 + 完成主动告知。
   * 返回 taskId；orchestrator 未初始化（无 LLM 通道）时返回 null。
   */
  submitAutonomousTask(actorId: string, goal: string, sessionId?: string): string | null {
    const orchestrator = this.agentTaskOrchestrator;
    if (!orchestrator) {
      console.warn("[agent-core] orchestrator 未初始化，丢弃外部提交的自主任务");
      return null;
    }
    const registry = this.wsRegistry;
    const sid = sessionId?.trim() || actorId;
    const options: RunTaskOptions = {
      onProgress: (event) => {
        if (!registry) return;
        try {
          registry.trySend(
            event.sessionId,
            JSON.stringify({
              type: ServerEventType.ChatExecutionEvent,
              payload: {
                kind: "task_progress",
                ...event,
              },
            }),
          );
        } catch {
          // 静默失败
        }
      },
    };
    const taskId = orchestrator.createAndRun(
      {
        actorId,
        sessionId: sid,
        goal,
        tags: ["geofence"],
      },
      options,
    );
    console.log(`[agent-core] 外部自主任务已入队 ${taskId} (goal=${goal.slice(0, 60)})`);
    return taskId;
  }

  async runToolIfNeeded(
    actorId: string,
    reply: AgentReply,
    opts?: {
      sessionId?: string;
      chatUserMessageId?: string;
      userId?: string;
      clientIp?: string;
      clientLocation?: ClientLocationWire;
      agentAccessMode?: AgentAccessMode;
    },
  ): Promise<{ ok: boolean; result?: Record<string, unknown> }> {
    if (!reply.toolName || !reply.toolInput) return { ok: true };
    // 工具调用前置安全检查统一由 BrainCenter + AgentTaskSafety 负责（含原 RuntimeKernel.checkToolAction 的工具名规则）
    const brainSafety = this.brainCenter?.checkSafety(
      { tool: reply.toolName, args: reply.toolInput },
      { actorId, sessionId: opts?.sessionId ?? actorId },
    );
    if (brainSafety && !brainSafety.allowed) {
      return {
        ok: false,
        result: {
          error: brainSafety.reason,
          severity: brainSafety.severity,
          blockedBy: "brain_center",
        },
      };
    }
    // Task 12 工具下沉：先尝试 BodyGateway 路由（前缀匹配 → BodyModule.act + 反射弧硬安全门），
    // 未下沉工具（hasRoute=false）走原 toolRegistry 直连路径。
    // BodyGateway 内部对未覆盖的具体工具会自动降级到 fallbackToolRegistry（仍走 toolRegistry.execute）。
    const bodyGw = this.brainCenter?.getBodyGateway();
    if (bodyGw && bodyGw.hasRoute(reply.toolName)) {
      return bodyGw.execute({
        tool: reply.toolName,
        args: reply.toolInput,
        actorId,
        source: "runToolIfNeeded",
      });
    }
    return this.toolRegistry.execute(reply.toolName, reply.toolInput, {
      sessionId: opts?.sessionId ?? actorId,
      userId: opts?.userId,
      chatUserMessageId: opts?.chatUserMessageId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: opts?.agentAccessMode,
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
      phoneBridgeOnline: this.phoneBridgeOnlineFor(actorId),
      // 按需位置：自主任务/日程触发的工具（如天气）缺经纬度时也能向客户端请求实时 GPS
      requestLocation: () =>
        this.locationCoordinator?.requestLocation(actorId, `tool:${reply.toolName}`) ??
        Promise.resolve(null),
    });
  }

  private isComplexMode(mode: LlmExecutionMode): boolean {
    return mode === "complex";
  }

  private isFastMode(mode: LlmExecutionMode): boolean {
    return mode === "fast";
  }

  private pickToolNamespace(toolName: string): string | null {
    if (!toolName) return null;
    const dotIndex = toolName.indexOf(".");
    if (dotIndex > 0) return toolName.slice(0, dotIndex);
    const underscoreIndex = toolName.indexOf("_");
    if (underscoreIndex > 0) return toolName.slice(0, underscoreIndex);
    return toolName === "unknown" ? null : "misc";
  }

  /**
   * 把 cognize 阶段已召回的 MemoryRecallItem[] 拼接为 narrative recall 字符串（复用召回结果，替代 prepareNarrativeRecall）。
   * P0/P4：每条带「[相对时间·记忆类型]」前缀（程序化计算，杜绝 LLM 生成时间标签失真），
   * 让 LLM 清楚知道每条记忆是什么时候发生的、属于哪类记忆，回答时不会张冠李戴。
   */
  private recallItemsToNarrative(items: MemoryRecallItem[]): string | undefined {
    const lines = items
      .map((it) => {
        const content = typeof it?.content === "string" ? it.content.trim() : "";
        if (!content) return null;
        const tag = [describeMemoryAge(it.timestamp), MEMORY_DOMAIN_LABELS[it.domain]].filter(Boolean).join("·");
        return tag ? `[${tag}] ${content}` : content;
      })
      .filter((x): x is string => x !== null);
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  /** prompt 位置新鲜窗口：窗口内直接用缓存，超窗才向客户端要一次 GPS（≤1 次/窗口/actor）。 */
  private static readonly PROMPT_LOCATION_FRESH_MS = 5 * 60 * 1000;
  /** 按要 GPS 的失败冷却：客户端离线/拒绝定位时，避免每条消息都白等 6s 超时。 */
  private static readonly PROMPT_LOCATION_RETRY_MS = 10 * 60 * 1000;
  /** 常去地点缓存 TTL。 */
  private static readonly FREQUENT_PLACES_TTL_MS = 10 * 60 * 1000;

  /**
   * Prompt 阶段的位置注入（全链路零 LLM）：
   * 消息自带位置 → 新鲜缓存 →（客户端在线且未在冷却期）按需拉一次实时 GPS
   * （纯 WS RPC，6s 超时）→ 仍无则退回旧缓存并标注「定位于 N 前」。
   * 旧策略"只读缓存不请求"导致缓存一空 LLM 就反问位置，2026-09-05 改为按需补拉。
   */
  private async resolveUserLocationForPrompt(
    actorId: string,
    opts?: { clientIp?: string; clientLocation?: ClientLocationWire },
  ): Promise<string | undefined> {
    const coordinator = this.locationCoordinator;
    let location: ClientLocationWire | undefined = opts?.clientLocation;
    let observedAt = location ? Date.now() : undefined;

    if (!location && coordinator) {
      const cached = coordinator.getCachedWithTime(actorId);
      if (cached && Date.now() - cached.at <= AgentCore.PROMPT_LOCATION_FRESH_MS) {
        location = cached.payload;
        observedAt = cached.at;
      }
    }

    if (!location && coordinator?.hasSocket(actorId)) {
      const lastAttempt = this.promptLocationLastAttemptAt.get(actorId) ?? 0;
      if (Date.now() - lastAttempt >= AgentCore.PROMPT_LOCATION_RETRY_MS) {
        this.promptLocationLastAttemptAt.set(actorId, Date.now());
        const fetched = await coordinator.requestLocation(actorId, "prompt:chat-context");
        if (fetched) {
          location = fetched;
          observedAt = Date.now();
        }
      }
    }

    if (!location && coordinator) {
      const stale = coordinator.getCachedWithTime(actorId);
      if (stale) {
        location = stale.payload;
        observedAt = stale.at;
      }
    }

    const prompt = await resolveUserLocationPrompt({
      clientIp: opts?.clientIp,
      clientLocation: location,
    });
    if (!prompt || observedAt == null) return prompt;
    const ageMin = Math.floor((Date.now() - observedAt) / 60_000);
    if (ageMin < 5) return prompt;
    const ageText = ageMin < 60 ? `${ageMin} 分钟前` : `${Math.floor(ageMin / 60)} 小时前`;
    return `${prompt}（定位时间：${ageText}，非实时）`;
  }

  /**
   * 常去地点背景块（零 LLM）：位置历史 DBSCAN 聚类结果直接格式化注入，
   * 进程内按 actor 缓存 10 分钟。minPoints 放宽到 3——按需模式样本稀疏
   * （每日启动/工具触发各 1 条），沿用持续模式的 20 会永远聚不出簇。
   */
  private resolveFrequentPlacesPrompt(actorId: string): string | undefined {
    const history = this.locationHistory;
    if (!history) return undefined;
    const cached = this.frequentPlacesCache.get(actorId);
    if (cached && Date.now() - cached.at <= AgentCore.FREQUENT_PLACES_TTL_MS) return cached.text;

    let text: string | undefined;
    try {
      const places = history.mineFrequentPlaces(actorId, { maxPlaces: 5, minPoints: 3 });
      if (places.length > 0) {
        const lines = places.map((p, i) => {
          const name = p.label?.trim() || `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;
          return `${i + 1}. ${name}｜到访 ${p.visitCount} 次 · 覆盖 ${p.distinctDays} 天 · 最近 ${p.lastSeenAt.slice(0, 10)}`;
        });
        text = [
          "由用户位置历史自动聚类得出（系统背景，禁止主动向用户提及或反问本块；",
          "回答「我常去哪/家/公司在哪」类问题时应以此为据，不确定时如实说明）：",
          ...lines,
        ].join("\n");
      }
    } catch {
      text = undefined;
    }
    this.frequentPlacesCache.set(actorId, { text, at: Date.now() });
    return text;
  }

  /**
   * 构建跨会话衔接块（2026-09-05 token 优化：不再注入最近对话原文）。
   *
   * 原实现把 thread slice(-12) 格式化成【最近对话回顾】文本块注入 system——
   * 但这些消息本就以 user/assistant 消息存在于 messages 数组（thread 未满时甚至是
   * 全量复制），同一内容发两遍。现仅保留该块的唯一非重复职责：
   * 跨会话开放环路（记忆连续性 Phase 2）——新会话开场并入上一会话未完成的
   * 待办与承诺（来自 KV session_epitome，不在 messages 数组中）。
   *
   * 注入去重：KV 长期槽 memory_open_loops/memory_commitments 同轮也会注入
   * 待办/承诺行，按语义指纹过滤避免同一事项出现两次。
   */
  private buildRecentConversationHistoryBlock(actorId?: string): string | undefined {
    if (!actorId || !this.brainCenter?.getSessionEpitome) return undefined;

    try {
      const epitome = this.brainCenter.getSessionEpitome(actorId);
      if (!epitome) return undefined;
      const kvFingerprints = new Set<string>();
          try {
            const { entries } =
              this.agentMemorySyncService?.getSnapshot(actorId, [
                "memory_open_loops",
                "memory_commitments",
              ]) ?? { entries: {} as Record<string, unknown> };
        for (const raw of [entries.memory_open_loops, entries.memory_commitments]) {
          if (typeof raw !== "string") continue;
          for (const line of raw.split("\n")) {
            const fp = semanticFingerprint(line);
            if (fp) kvFingerprints.add(fp);
          }
        }
      } catch {
        /* KV 读取失败时跳过去重，保持原注入行为 */
      }
      const isDuplicate = (line: string): boolean => {
        const fp = semanticFingerprint(line);
        return fp !== "" && kvFingerprints.has(fp);
      };
      const lines: string[] = [
        ...epitome.openLoops.slice(0, 3).map((l) => `待办: ${l}`).filter((l) => !isDuplicate(l)),
        ...epitome.commitments.slice(0, 2).map((l) => `承诺: ${l}`).filter((l) => !isDuplicate(l)),
      ];
      if (lines.length === 0) return undefined;
      return (
        `【上一会话待办】\n（跨会话延续：以下来自上一会话的未完成事项，非本轮新指令；如已完成请忽略）\n${lines.join("\n")}` +
        `\n（管家提示：其中若有适合到点提醒的事项，可主动提议「要不要我到点提醒你」，经用户确认后用 reminder/日程工具落成定时提醒）`
      );
    } catch {
      /* epitome 读取失败静默降级 */
      return undefined;
    }
  }

  /**
   * 2026-07-29 修复 C1 配套：窥探当前 thread store 中的非 system 消息条数。
   * - 成功：返回 user/assistant 消息总数（不含 system）
   * - 失败：返回 -1（关闭 dedup 判定，保持原追加行为）
   *
   * 调用栈：narrativeRecall 准备阶段，用于判断 [最近对话] 块是否与 msgs 重复。
   * 不修改 thread store，纯查询。
   */
  private peekThreadMessageCount(actorId: string, sessionId?: string): number {
    try {
      const chatSessionId = resolvePrimaryChatSessionId(
        actorId,
        getAgentRuntimeConfig().masterDelegation.enabled,
      );
      const threadStore = getChatThreadStore();
      const messages = threadStore.thread(chatSessionId, "");
      let count = 0;
      for (const m of messages) {
        if (m && (m.role === "user" || m.role === "assistant")) count++;
      }
      return count;
    } catch (err) {
      console.log(`[AgentCore] peekThreadMessageCount 失败（忽略，关闭 dedup）: ${err}`);
      return -1;
    }
  }

  private buildOrchestrateOpts(
    actorId: string,
    userText: string,
    opts: HandleUserMessageOptions | undefined,
    narrativeRecall: string | undefined,
    personalization: PersonalizationPromptSlice,
    trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined,
    access: { agentAccessMode: AgentAccessMode; desktopBridgeOnline: boolean; phoneBridgeOnline: boolean },
    sessionId: string,
    shortTermTurn: ShortTermTurnContext,
    workingMemorySummary: string | undefined,
    recentConversationHistory: string | undefined,
    journalRecall: string | undefined,
    longTermRecallSuppressed: boolean,
    /** 向量预筛命中：regex 白名单未触发但向量检索判定强相关（供 KV 长期字段同门放行） */
    semanticRecallHit: boolean,
    /** recall-gate 白名单判定结果（门控单点化）：cognize 评估后透传，prompt 装配层免重算 */
    recallGateTriggered: boolean,
  ) {
    const onBatchFromCaller = opts?.onToolLoopAfterBatch;
    const onBatchWithEvolution =
      onBatchFromCaller || this.evolutionLoopService
        ? (info: ToolLoopAfterBatchInfo) => {
            onBatchFromCaller?.(info);
            this.evolutionLoopService?.onToolBatch(actorId, userText, info);
          }
        : undefined;

    return {
      chatUserMessageId: opts?.chatUserMessageId,
      sessionId,
      userId: opts?.userId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: access.agentAccessMode,
      desktopBridgeOnline: access.desktopBridgeOnline,
      phoneBridgeOnline: access.phoneBridgeOnline,
      toolRankingHint: this.toolPolicyResolver.resolveRankingHint(actorId),
      visionFrames: opts?.visionFrames,
      interruptedContext: opts?.interruptedContext,
      narrativeRecall,
      workingMemorySummary,
      recentConversationHistory,
      journalRecall,
      personalization,
      // #1 统一门控单点：把"topic_switch 抑制 / 召回未触发"透传给 prompt 装配层，
      // 让 KV 长期字段（memory_facts/preferences/commitments/open_loops/session_recap…）
      // 与图谱（narrativeRecall）走同一白名单，话题切换时全部抑制（串台根治）。
      longTermRecallSuppressed,
      semanticRecallHit,
      recallGateTriggered,
      onToolExecuteStart: opts?.onExternalToolExecuteStart,
      onAgentStatusLine: opts?.onAgentPhaseStatus,
      onToolExecuted: (info: ToolExecutedInfo) => {
        trajCap?.observeToolExecuted({
          toolName: info.toolName,
          ok: info.ok,
          result: info.result,
        });
        opts?.onExternalToolExecuted?.(info);
        // 失败时自我学习闭环：把工具调用结果（含失败）写入 selfLearning
        // → DMN 周期扫描时即可读到失败轨迹 → 触发 proposeEvolution 生成进化提案
        this.brainCenter?.recordToolInteraction({
          actorId,
          sessionId,
          userRequest: userText,
          attemptedTools: [info.toolName],
          success: info.ok,
          errorMessage: info.ok
            ? undefined
            : typeof info.result?.error === "string"
              ? String(info.result.error).slice(0, 200)
              : undefined,
        });
      },
      onToolLoopAfterBatch: onBatchWithEvolution,
      // 记忆架构重构：thread 消息数透传给 prompt 装配层（长期快照注入门控用）
      threadMessageCount: this.peekThreadMessageCount(actorId, sessionId),
    };
  }

  /**
   * 任务面提交（2026-09-05 双面架构）：后台 plan-and-execute 执行任务，返回最终结果文本。
   *
   * 与对话面的衔接契约（TaskHub）：
   *   - 提交即登记 TaskRecord（绑定 replyAnchorId），出口事件与结果都属于任务本身，
   *     用户中途继续对话（新 turn）不会让结果丢失；
   *   - 结果非空兜底：杜绝"调用工具但结果空转"→ 前端只有进度、正文缺失的残链；
   *   - 后台执行不继承外层 signal（避免用户发新消息时中断后台任务）。
   */
  private launchComplexBackgroundTask(
    actorId: string,
    text: string,
    opts: HandleUserMessageOptions | undefined,
    ctx: {
      narrativeRecall?: string;
      workingMemorySummary?: string;
      recentConversationHistory?: string;
      /** 当日/近几天对话日志检索命中（独立块注入） */
      journalRecall?: string;
      userLocation?: string;
      /** 常去地点背景块（DBSCAN 纯算法挖掘，零 LLM） */
      frequentPlaces?: string;
      trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
      orchestrateOpts: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn: ShortTermTurnContext;
      cognitiveEmotion?: import("../brain/types.js").EmotionVector | null;
      cognitiveUserPattern?: {
        topics: string[];
        preferredToolDomain?: string;
        negativeFeedbackCount: number;
        learningActive?: boolean;
      };
      cognitiveToolPlan?: import("../brain/tool-planning-cortex.js").ToolPlan;
      /** 路由层 TurnPlan：任务面预算/能力/档位 */
      turnPlan?: { budget: number; capabilities: string[]; tier: string };
    },
  ): Promise<string> {
    const onDelta = opts?.onAssistantDelta;
    // 后台执行不继承外层 signal（turn 已返回占位，避免用户发新消息时中断后台任务）
    const bgOpts: HandleUserMessageOptions | undefined = opts
      ? { ...opts, signal: undefined }
      : opts;

    // TaskHub 登记：任务面对话面接缝的唯一记录（进度摘要注入路由、结果归属任务）
    const taskHub = getTaskHub();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = taskHub.submit({
      taskId,
      sessionId: ctx.sessionId,
      ...(opts?.chatUserMessageId ? { replyAnchorId: opts.chatUserMessageId } : {}),
      goal: text,
    });
    // 提交即出一条状态行，盖住路由/brief 装配/首次规划的无反馈窗口
    opts?.onAgentPhaseStatus?.("开始处理任务…");

    // 返回 Promise，在任务面完成时 resolve 最终结果文本
    return new Promise<string>((resolve, reject) => {
      const run = async (): Promise<void> => {
        try {
          const result = await this.runStandardLlmPath(actorId, text, "complex", bgOpts, {
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            journalRecall: ctx.journalRecall,
            userLocation: ctx.userLocation,
            frequentPlaces: ctx.frequentPlaces,
            trajCap: ctx.trajCap,
            orchestrateToolCtx: ctx.orchestrateOpts,
            personalization: ctx.personalization ?? {},
            sessionId: ctx.sessionId,
            shortTermTurn: ctx.shortTermTurn,
            cognitiveEmotion: ctx.cognitiveEmotion,
            cognitiveUserPattern: ctx.cognitiveUserPattern,
            cognitiveToolPlan: ctx.cognitiveToolPlan,
            turnPlan: ctx.turnPlan,
            taskHubTaskId: taskId,
          });
          // 结果兜底：任务面必须产出非空最终文本
          const trimmed = (result.text ?? "").trim();
          if (trimmed) {
            taskHub.setState(taskId, "done");
            resolve(trimmed);
            return;
          }
          console.warn(`[AgentCore][task-plane] "${text}" 返回空结果，尝试应急重生成`);
          const emergencyText = await this.emergencyRegenerate(actorId, text, onDelta);
          const finalText = emergencyText.trim();
          taskHub.setState(taskId, finalText ? "done" : "failed");
          resolve(finalText);
        } catch (err) {
          taskHub.setState(taskId, "failed");
          reject(err);
        }
      };

      // 任务面在主线程并发执行（event loop 非阻塞，用户可继续对话）。
      // 旧 runComplexTaskInWorker 的 worker_threads 包装从未启用（useWorker 恒 false），已删除。
      void run().catch((err) => {
        console.error("[AgentCore] 任务面执行异常:", err);
        reject(err);
      });
    });
  }

  private async runStandardLlmPath(
    actorId: string,
    text: string,
    mode: LlmExecutionMode,
    opts: HandleUserMessageOptions | undefined,
    ctx: {
      narrativeRecall?: string;
      /** 当前工作记忆摘要（独立块注入，不再拼入 narrativeRecall） */
      workingMemorySummary?: string;
      /** 最近对话回顾（独立块注入，thread 较短时填充） */
      recentConversationHistory?: string;
      /** 当日/近几天对话日志检索命中（独立块注入，不复用 formatNarrativeRecallPrompt，防拍平） */
      journalRecall?: string;
      userLocation?: string;
      /** 常去地点背景块（DBSCAN 纯算法挖掘，零 LLM） */
      frequentPlaces?: string;
      trajCap?: ReturnType<TrajectorySkillPromotionService["beginCapture"]>;
      /** 后台派发路径（dispatchBackgroundTask）可不传：执行层逐项可选化 */
      orchestrateToolCtx?: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization?: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn?: ShortTermTurnContext;
      /**
       * r5: cognize 阶段已评估的情绪，由本函数格式化为方向化短字符串
       * 注入 promptContext.memory.emotionState。
       * 缺失（无 BrainCenter / cognize 未跑）时跳过注入。
       */
      cognitiveEmotion?: import("../brain/types.js").EmotionVector | null;
      /** 深度优化：用户画像，注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
      cognitiveUserPattern?: {
        topics: string[];
        preferredToolDomain?: string;
        negativeFeedbackCount: number;
        learningActive?: boolean;
      };
      /** 深度优化：工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围 */
      cognitiveToolPlan?: import("../brain/tool-planning-cortex.js").ToolPlan;
      /** 路由层 TurnPlan：任务面预算/能力/档位（对话面不传） */
      turnPlan?: { budget: number; capabilities: string[]; tier: string };
      /** TaskHub 任务记录 id（任务面传入，用于进度摘要回写） */
      taskHubTaskId?: string;
      /** 路由意图标签（对话面误判转任务的自检输入） */
      routeIntent?: string;
      /** ephemeral 执行（后台任务派发用）：不自动落 thread，由派发方显式并入 */
      ephemeralTurn?: boolean;
      /**
       * 快速通道（2026-09-05）：跳过 planner，可见工具 = 桥工具（tool_discover/
       * tool_call），一切业务工具由 tool router（BM25 目录）按需召回——执行侧
       * 上下文零业务 schema。默认快速起步，失败由派发方升级完整通道。
       */
      toolRecallOnly?: boolean;
    },
  ): Promise<AgentReply> {
    const provider = this.externalChat!;
    /** 本轮是否执行过任何工具（出口诚实闸的「动作」一侧证据）。 */
    let toolExecutedThisTurn = false;
    const toolCtx: ChatToolExecutionContext = this.toolContextFactory.create(
      {
        actorId,
        sessionId: ctx.sessionId,
        userId: opts?.userId,
        chatUserMessageId: opts?.chatUserMessageId,
        clientIp: opts?.clientIp,
        clientLocation: opts?.clientLocation,
        userText: text,
        source: "runStandardLlmPath",
        access: {
          agentAccessMode: ctx.orchestrateToolCtx?.agentAccessMode,
          desktopBridgeOnline: ctx.orchestrateToolCtx?.desktopBridgeOnline,
          phoneBridgeOnline: ctx.orchestrateToolCtx?.phoneBridgeOnline,
// 按需位置：位置类工具（weather.get_local 等）在缺少经纬度时可向客户端请求实时 GPS。
          requestLocation: () =>
            this.locationCoordinator?.requestLocation(actorId, "tool:standard-llm-path") ??
            Promise.resolve(null),
        },
      },
      {
        onToolExecuteStart: (info) => {
          toolExecutedThisTurn = true;
          if (ctx.taskHubTaskId) {
            getTaskHub().setProgress(ctx.taskHubTaskId, `正在使用 ${info.toolName}`);
          }
          opts?.onExternalToolExecuteStart?.(info);
        },
        onAgentStatusLine: opts?.onAgentPhaseStatus,
        onToolExecuted: ctx.orchestrateToolCtx?.onToolExecuted,
      },
    );

    const onBatchWithEvolution = ctx.orchestrateToolCtx?.onToolLoopAfterBatch;
    const toolExposureProfile = this.toolPolicyResolver.resolveExposureProfile(mode);
    const toolRankingHint = this.toolPolicyResolver.resolveRankingHint(actorId);
    // 2026-09-05 前后台架构：前台上下文零工具 schema——派发走回复文本内嵌的
    // [dispatch:...] 结构化标签（同体输出 ack，1 次调用完成回复 + 派发）；
    // AGENT_FOREGROUND_DISPATCH=0 时回退旧的零工具直答契约（行为一致，仅无标签协议）。
    const foregroundTagMode = this.isFastMode(mode) && isForegroundDispatchMode();
    const dispatchFilter = foregroundTagMode ? new DispatchTagStreamFilter() : null;
    const baseStreamOpts = this.isFastMode(mode)
      ? ({
          ...(this.promptContextBuilder.build({
            actorId,
            sessionId: ctx.sessionId,
            userText: text,
            threadMessageCount: ctx.orchestrateToolCtx?.threadMessageCount,
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            journalRecall: ctx.journalRecall,
            interruptedContext: opts?.interruptedContext,
            userLocation: ctx.userLocation,
            frequentPlaces: ctx.frequentPlaces,
            personalization: ctx.personalization ?? {},
            userPattern: ctx.cognitiveUserPattern,
            toolPlan: ctx.cognitiveToolPlan,
            // #1 统一门控单点：KV 长期字段与图谱走同一 gate
            longTermRecallSuppressed: ctx.orchestrateToolCtx?.longTermRecallSuppressed,
            semanticRecallHit: ctx.orchestrateToolCtx?.semanticRecallHit,
            recallGateTriggered: ctx.orchestrateToolCtx?.recallGateTriggered,
          }) ?? {}),
          // 零工具：前台上下文不含任何工具 schema（省 token + 提速）；派发走
          // [dispatch:...] 标签协议，工具执行全部在后台经 tool router 召回。
          toolExposureProfile: "none" as const,
          maxOutputTokens: fastMaxOutputTokens(),
          toolRankingHint,
        } satisfies AgentStreamOptions)
      : {
          ...(this.promptContextBuilder.build({
            actorId,
            sessionId: ctx.sessionId,
            userText: text,
            threadMessageCount: ctx.orchestrateToolCtx?.threadMessageCount,
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            journalRecall: ctx.journalRecall,
            interruptedContext: opts?.interruptedContext,
            userLocation: ctx.userLocation,
            frequentPlaces: ctx.frequentPlaces,
            personalization: ctx.personalization ?? {},
            onToolLoopAfterBatch: onBatchWithEvolution,
            userPattern: ctx.cognitiveUserPattern,
            toolPlan: ctx.cognitiveToolPlan,
            // #1 统一门控单点：KV 长期字段与图谱走同一 gate
            longTermRecallSuppressed: ctx.orchestrateToolCtx?.longTermRecallSuppressed,
            semanticRecallHit: ctx.orchestrateToolCtx?.semanticRecallHit,
            recallGateTriggered: ctx.orchestrateToolCtx?.recallGateTriggered,
          }) ?? {}),
          toolExposureProfile,
          toolRankingHint,
        };
    // 本模式职责人格注入（fast/complex 差异化，不依赖 feature flag）：
    // fast 偏对话活人感、complex 偏推理与工具，让同一人格在不同"脑"上各有侧重。
    if ((baseStreamOpts.promptContext ??= {}).memory) {
      const mem = baseStreamOpts.promptContext.memory;
      if (!mem.modeRoleGuidance) {
        mem.modeRoleGuidance = this.isFastMode(mode)
          ? isForegroundDispatchMode()
            ? FOREGROUND_ROLE_GUIDANCE
            : FAST_MODE_ROLE_GUIDANCE
          : COMPLEX_MODE_ROLE_GUIDANCE;
      }
      // 风格豁免开关（2026-09-06）：短句基准/语感镜像只属于对话面；
      // 任务面（complex）交付不受限，【回复指南】不注入聊天基准行，
      // 交付风格由 COMPLEX_MODE_ROLE_GUIDANCE 自己承担。
      mem.replyStyleMode = this.isFastMode(mode) ? "chat" : "task";
    }
    const runtimeKernel = getRuntimeKernel(actorId);
    // r5: 注入情绪到 promptContext.memory（方向化短字符串，不堆 prompt）：
    // - emotionState: 仅当情绪显著时输出（强负/强正/高唤醒），让模型基于情绪调语气
    // 中性情绪 → 跳过（避免噪声污染 prompt）
    const memoryBeforeSanitize = baseStreamOpts.promptContext?.memory;
    const cogEmo = ctx.cognitiveEmotion;
    if (memoryBeforeSanitize && cogEmo) {
      const v = cogEmo.valence;
      const a = cogEmo.arousal;
      if (v < -0.3 || v > 0.5 || a > 0.7) {
        const tone = v < -0.5
          ? "回复应简短温和"
          : v < -0.3
            ? "回复宜温和"
            : v > 0.5
              ? "回复可活泼些"
              : a > 0.7
                ? "回复别端着"
                : "";
        memoryBeforeSanitize.emotionState =
          `情绪：${cogEmo.label}${tone ? ` — ${tone}` : ""}`;
      }
    }
    const runtimePlan = runtimeKernel.planTurn(text, baseStreamOpts.promptContext?.memory);
    const sanitizedMemory = runtimeKernel.sanitizePromptMemory(
      baseStreamOpts.promptContext?.memory,
      runtimePlan,
    );
    const isMinimalMode = runtimeKernel.isMinimalMode();
    // 2026-09-05 模型路由：对话面 → Flash；任务面按 TurnPlan.tier——轻预算单点任务
    // （realtime/media，tier=fast）也走 Flash，仅多步/写操作（tier=complex）上 Pro。
    // 取代旧"mode=complex 一律 reasoner"的粗粒度路由（省 token）。
    const resolvedTier: TaskTier =
      mode === "fast" || ctx.turnPlan?.tier === "fast" ? TaskTier.FAST : TaskTier.COMPLEX;
    const streamOpts: AgentStreamOptions = {
      ...baseStreamOpts,
      ...(sanitizedMemory ? { promptContext: { memory: sanitizedMemory } } : { promptContext: undefined }),
      ...(runtimePlan.promptMode === "conversation_only"
        ? {
            systemPromptOverride:
              "You are a helpful, safe assistant. Reply in the user's language. Follow the current user request and conversation context.",
          }
        : {}),
      // minimal 模式下：通过 RuntimeKernel.buildSessionSystem() 生成薄身份 system，
      // suppressRuntimeSuffixes=true 跳过身份/风格/时间戳说明后缀，
      // functionalSuffixes=true 保留功能性后缀（工具说明/主 Agent 调度/用户可见进度/访问权限）
      ...(isMinimalMode
        ? {
            systemPromptOverride: runtimeKernel.buildSessionSystem() ?? undefined,
            suppressRuntimeSuffixes: true,
            functionalSuffixes: runtimePlan.functionalSuffixes !== false,
          }
        : {}),
      // 2026-08-30 修复：fast 车道不允许 RuntimeKernel 把 profile 覆盖成 scoped。
      // scoped 会让 buildExtraBody 丢掉 fastProfile 标志（仅 contextual/light 注入）
      // → 工具循环里 fast 升级保底（fastProfile && 纯宣告/需联网 → 升级 complex）
      // 整个失效、maxWaves 从 1 静默变 4，且可见工具被 filterScopedTools 砍到只剩
      // pinned（提醒/搜索/照片关键词轮必然命中，恰是升级需求最高的轮次）。
      // RK 的 pinned 工具已通过下方 pinnedToolNames 合并保留，fast 下无需 profile 劫持。
      toolExposureProfile: this.isFastMode(mode)
        ? baseStreamOpts.toolExposureProfile
        : (runtimePlan.toolExposureProfile ?? baseStreamOpts.toolExposureProfile),
      // 任务面能力束（2026-09-05）：路由层 TurnPlan.capabilities 透传给工具解析层，
      // delegate profile 按它裁剪注入的工具族（search/media 轻任务不再全量注入），
      // 其余工具进 BM25 延迟目录按需召回。
      ...(this.isFastMode(mode) ? {} : { toolCapabilities: ctx.turnPlan?.capabilities }),
      pinnedToolNames: runtimePlan.enabled
        ? [...(baseStreamOpts.pinnedToolNames ?? []), ...runtimePlan.pinnedToolNames]
        : baseStreamOpts.pinnedToolNames,
      // 任务面工具波预算（2026-09-05）：由路由层 TurnPlan 决定（realtime/media=2，
      // write/multi-step=3，词法 veto 升级=3），取代旧硬编码。对话面无工具循环，
      // 不受此配置影响。保底 1、封顶 4，防预算失控。
      ...(this.isFastMode(mode)
        ? {}
        : {
            toolLoop: {
              ...(baseStreamOpts.toolLoop ?? {}),
              maxRounds: Math.min(4, Math.max(1, ctx.turnPlan?.budget ?? 3)),
            },
          }),
      maxThreadMessages: runtimePlan.promptMode === "conversation_only"
        ? Number.parseInt(process.env.AGENT_RUNTIME_KERNEL_MAX_THREAD_MESSAGES ?? "12", 10)
        : baseStreamOpts.maxThreadMessages,
      // 透传中断信号:用户发新消息时 abort,provider 底层 fetch 真正中断 HTTP 流式
      ...(opts?.signal ? { signal: opts.signal } : {}),
      // 2026-08-02 模型路由：根据 Fast/Complex 模式选择对应模型
      // Fast → deepseek-chat（Flash），Complex → deepseek-reasoner（Pro）
      ...buildModelOverrideOpts(resolvedTier),
    };

    let full = "";
    let modelCallsConsumed = 1;
    // 任务面引擎选择（2026-09-05）：唯一引擎 = 工具循环（波内一次性规划 + 并行工具 +
    // 出口自检续波）。显式 plan 调用（独立规划 LLM 请求）仅在 AGENT_PLAN_EXECUTE_LOOP
    // 开启时叠加——默认关闭：one-shot 规划省一次带全量上下文的规划请求（省 token + 提速），
    // 且出口自检的 NEED_MORE_TOOLS 探测已承担 replan 职责。
    // 旧 ReactLoopStrategy / LoopOrchestrator（含每轮 LLM 进展评估）已删除。
    const useExplicitPlanner = mode === "complex" && isPlanExecuteLoopEnabled();
    let pePlan: TaskExecutionPlan | null = null;
    let peExhausted = false;

    // plan-driven 工具注入（2026-09-05 前后台架构）：
    // - 快速通道（toolRecallOnly，默认起步）：跳过 planner，可见工具 = 桥工具
    //   （tool_discover/tool_call），全量工具集只进 BM25 目录语料——模型经
    //   tool router 按需召回并执行，上下文零业务 schema（先轻后重）。
    // - 完整通道：Plan 调用只看紧凑工具目录（name + 一句话描述，零 schema），
    //   输出必需工具名，Execute 以 explicit 白名单一次性注入计划工具 schema
    //   （多步任务的重型路径）。
    // - 规划失败/为空 → 回退原 delegate 能力束注入（保守路径不变）。
    let execStreamOpts = streamOpts;
    if (!useExplicitPlanner && this.isComplexMode(mode)) {
      if (ctx.toolRecallOnly) {
        // 空可见集 + 全量目录语料：prepareToolsWithToolSearch 会把全量工具视为
        // deferred 并自动注入 tool_discover/tool_call 桥——模型经 tool router
        // 召回并执行，上下文零业务 schema。
        const corpus = [
          ...(streamOpts.chatToolsBuiltin ?? getBuiltinAgentChatTools()),
          ...(streamOpts.chatToolsExtra ?? []),
        ];
        if (corpus.length > 0) {
          execStreamOpts = {
            ...streamOpts,
            toolExposureProfile: "explicit",
            chatToolsBuiltin: [],
            chatToolsExtra: corpus,
          };
        }
      } else if (isTaskToolPlannerEnabled()) {
        const plannedTools = await this.planTaskTools(text, streamOpts, ctx.sessionId, ctx.orchestrateToolCtx?.desktopBridgeOnline);
        if (plannedTools.length > 0) {
          const plannedNames = new Set(
            plannedTools.map((d) => (d.type === "function" ? d.function?.name : "")).filter(Boolean),
          );
          const corpus = [
            ...(streamOpts.chatToolsBuiltin ?? getBuiltinAgentChatTools()),
            ...(streamOpts.chatToolsExtra ?? []),
          ];
          execStreamOpts = {
            ...streamOpts,
            toolExposureProfile: "explicit",
            chatToolsBuiltin: plannedTools,
            // 全量工具集只进延迟目录语料（去重）：plan 漏选的工具可被 tool_discover 召回
            chatToolsExtra: corpus.filter(
              (d) => d.type !== "function" || !plannedNames.has(d.function?.name ?? ""),
            ),
          };
        }
      }
    }

    const userTurn: ChatUserTurn = {
      text,
      ...(opts?.visionFrames?.length ? { visionFrames: opts.visionFrames } : {}),
      // 把 WS 客户端的 messageId 透传为 ChatUserTurn.clientMessageId；
      // provider 会在把 user 消息 push 进 thread 时登记到反向索引，供后续编辑/重发按 id 命中。
      ...(opts?.chatUserMessageId ? { clientMessageId: opts.chatUserMessageId } : {}),
    };

    const chatSessionId = resolvePrimaryChatSessionId(
      actorId,
      getAgentRuntimeConfig().masterDelegation.enabled,
    );

    if (useExplicitPlanner) {
      const chatKey = opts?.chatUserMessageId ?? randomUUID();
      const peSessionId = planExecuteSessionId(actorId, chatKey);

      const result = await runPlanExecuteLoop({
        provider,
        planSessionId: peSessionId,
        userText: text,
        visionFrames: opts?.visionFrames,
        onDelta: (delta) => opts?.onAssistantDelta?.(delta),
        onPhaseStatus: opts?.onAgentPhaseStatus,
        onPlanReady: opts?.onPlanReady,
        toolCtx,
        baseStreamOpts: streamOpts,
        onToolBatchForExecute: onBatchWithEvolution,
      });
      full = result.finalText;
      modelCallsConsumed = Math.max(1, result.modelCalls);
      pePlan = result.plan;
      peExhausted = result.exhaustedRetries;
      provider.clearSession?.(peSessionId);
      provider.appendThreadTurn?.(chatSessionId, userTurn, full);
    } else {
      const mergedStreamOpts: AgentStreamOptions | undefined =
        execStreamOpts || onBatchWithEvolution || opts || provider.id === "moonshot-kimi"
          ? {
              ...(execStreamOpts ?? {}),
              ...(onBatchWithEvolution
                ? {
                    toolLoop: {
                      ...(execStreamOpts?.toolLoop ?? {}),
                      onAfterToolBatch: onBatchWithEvolution,
                    },
                  }
                : {}),
              // 后台任务（dispatch/诚实闸派发）以 ephemeral 执行：不自动落 thread，
              // 由 dispatchBackgroundTask 以 [后台任务] 标记显式并入（防 user 消息重复）
              ...(ctx.ephemeralTurn ? { ephemeralTurn: true } : {}),
              agentAccessMode: ctx.orchestrateToolCtx?.agentAccessMode,
              desktopBridgeOnline: ctx.orchestrateToolCtx?.desktopBridgeOnline,
              phoneBridgeOnline: ctx.orchestrateToolCtx?.phoneBridgeOnline,
              ...(provider.id === "moonshot-kimi" ? { disableThinking: true } : {}),
            }
          : undefined;

      // 前台（fast）：零工具直答，派发走 [dispatch:...] 标签（流式出口逐块剥离）。
      // 任务面（complex，one-shot 引擎）：工具循环 + 出口自检续波。
      full = await provider.streamCompletion(
        chatSessionId,
        userTurn,
        (delta) => opts?.onAssistantDelta?.(dispatchFilter ? dispatchFilter.feed(delta) : delta),
        toolCtx,
        mergedStreamOpts,
      );

      // ── [dispatch:...] 标签出口（2026-09-05 前后台架构）──
      // 从完整回复解析派发请求 → 送后台；最终文本剥标签（流式已逐块剥离，
      // 这里对 flush 残尾与整体做兜底），保证用户可见文本与记忆/journal 无标签。
      let dispatchedViaTag = 0;
      if (dispatchFilter) {
        const tail = dispatchFilter.flush();
        if (tail && opts?.onAssistantDelta) opts.onAssistantDelta(tail);
        full = stripDispatchTags(full);
        const requests = parseDispatchTags(full);
        dispatchedViaTag = requests.length;
        for (const req of requests) {
          console.info(`[AgentCore] 前台标签派发：${req.goal.slice(0, 60)}`);
          this.dispatchBackgroundTask(actorId, {
            sessionId: ctx.sessionId,
            chatUserMessageId: opts?.chatUserMessageId,
            goal: req.note ? `${req.goal}\n（补充：${req.note}）` : req.goal,
            source: "dispatch_tag",
          });
        }
      }

      // ── 出口诚实闸（2026-09-05 前后台架构，前台一半，话题无关）──
      // 前台回复含「已办妥/这就去办」类承诺、但本轮既无派发标签也无工具动作
      // → 大概率空口承诺（或标签格式失败），自动补派后台任务把承诺变成真。
      if (
        this.isFastMode(mode) &&
        isForegroundDispatchMode() &&
        !toolExecutedThisTurn &&
        dispatchedViaTag === 0 &&
        hasCommitmentClaim(full)
      ) {
        console.info(`[AgentCore] 诚实闸补派后台任务：${text.slice(0, 48)}`);
        this.dispatchBackgroundTask(actorId, {
          sessionId: ctx.sessionId,
          chatUserMessageId: opts?.chatUserMessageId,
          goal: text,
          source: "commitment_gate",
        });
      }

      // ── 对话面误判出口自检（TurnOutcomeGate 的对话面一半，话题无关）──
      // 仅当：路由判定为知识问答（预期可凭常识作答）但直答是道歉式兜底
      //（风格判定，非话题词）→ 大概率实际需要工具，转任务面重跑。
      // 纯 chat（情绪/闲聊）的"我不知道"不转换——避免情感对话被任务面改写节奏。
      // 正常路由下 knowledge_qa 误判率低，此处是最后防线，极少触发。
      if (
        this.isFastMode(mode) &&
        ctx.routeIntent === "knowledge_qa" &&
        isApologyStyleFallback(full.trim())
      ) {
        console.info(`[AgentCore] 对话面误判转任务面：${text.slice(0, 48)}`);
        return this.runStandardLlmPath(actorId, text, "complex", opts, {
          ...ctx,
          turnPlan: { budget: 2, capabilities: ["full"], tier: "fast" },
        });
      }
    }

    return await this.turnFinalizer.finish(actorId, text, full, {
      streamedChunks: true,
      modelCallsConsumed,
      planExecuteUsed: useExplicitPlanner,
      pePlan,
      peExhausted,
      trajCap: ctx.trajCap,
      messageId: opts?.chatUserMessageId,
      sessionId: opts?.sessionId,
    }, opts?.onAssistantDelta);
  }

  /**
   * 任务工具规划器（2026-09-05 前后台架构）：plan → 白名单注入的唯一入口。
   *
   * Plan 调用只看紧凑工具目录（工具名 + 截断到 80 字的一句话描述，零 JSON
   * schema——全量 schema 注入是任务面 prompt 膨胀的最大单点），输出完成本
   * 任务必需的工具名集合；调用方以 explicit profile 一次性注入这些工具的
   * 完整 schema 后再进入执行循环。延迟目录桥（tool_discover 族）始终可见，
   * plan 漏选的工具在执行期仍可按需召回。
   *
   * 返回空数组表示规划失败/无必需工具，调用方回退 delegate 能力束注入。
   */
  private async planTaskTools(
    text: string,
    streamOpts: AgentStreamOptions,
    sessionId: string,
    desktopBridgeOnline: boolean | undefined,
  ): Promise<ChatCompletionTool[]> {
    type FunctionTool = Extract<ChatCompletionTool, { type: "function" }>;
    try {
      const provider = this.externalChat;
      if (!provider?.isEnabled()) return [];
      const corpus = [
        ...(streamOpts.chatToolsBuiltin ?? getBuiltinAgentChatTools()),
        ...(streamOpts.chatToolsExtra ?? []),
      ];
      const byName = new Map<string, FunctionTool>();
      for (const def of corpus) {
        if (def.type !== "function") continue;
        // 桥接明确离线的 desktop.* 是必然失败工具，不进目录（防 plan 点名后必然失败）
        if (desktopBridgeOnline === false && def.function.name.startsWith("desktop.")) continue;
        if (!byName.has(def.function.name)) byName.set(def.function.name, def);
      }
      if (byName.size === 0) return [];
      const catalog = Array.from(byName.values())
        .map((def) => {
          const desc = (def.function.description ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          return `- ${def.function.name}：${desc}`;
        })
        .join("\n");
      const prompt = [
        "你是任务执行规划器。针对下面的任务，从工具目录中挑选完成它必需的工具。",
        '只输出一个 JSON 对象：{"tools":["工具名",...]}。不要输出其他任何字符。',
        "原则：宁少勿多——单一查证通常 1-2 个工具；多步任务列每一步必需的工具；",
        "不确定要不要的不要列（执行中可用 tool_discover 按需召回）。",
        '目录里没有必需工具时输出 {"tools":[]}。',
        "",
        "工具目录：",
        catalog,
        "",
        `任务：${text.slice(0, 2000)}`,
      ].join("\n");
      const raw = await Promise.race([
        provider.streamCompletion(
          `task-planner::${sessionId}`,
          { text: prompt },
          () => {}, // 规划无需流式回传
          undefined,
          {
            ephemeralTurn: true,
            suppressRuntimeSuffixes: true,
            functionalSuffixes: false,
            toolExposureProfile: "none",
            maxOutputTokens: 256,
          },
        ),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 8000)),
      ]);
      const names = parsePlannedToolNames(raw);
      const planned: FunctionTool[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        const def = byName.get(name);
        if (def && !seen.has(name)) {
          planned.push(def);
          seen.add(name);
        }
      }
      // 延迟目录桥始终可见：plan 漏选的工具执行期可被 tool_discover 召回
      for (const bridge of TOOL_BRIDGE_NAMES) {
        const def = byName.get(bridge);
        if (def && !seen.has(bridge)) {
          planned.push(def);
          seen.add(bridge);
        }
      }
      return planned;
    } catch (err) {
      console.warn(
        "[AgentCore] 任务工具规划失败，回退能力束注入:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  /**
   * 前后台架构：派发后台任务（2026-09-05）。
   *
   * task.dispatch 工具与出口诚实闸的唯一执行端：立即登记 TaskHub 并返回
   * taskId（前台不阻塞，继续与用户对话）。后台以 ephemeral 会话执行
   * （不继承外层 signal、不重复写 user 消息进 thread），完成后：
   *   - 结果以新 messageId（assistant-task-<id>）经 wsRegistry 直推为独立
   *     assistant 消息——不经过 WS turn 的 isStale 门控，用户中途继续对话
   *     也不会丢结果；
   *   - 交换以「[后台任务]」标记显式并入对话 thread，后续轮次上下文可见。
   *
   * @returns taskId（launch 未就绪/provider 不可用时返回 null）
   */
  dispatchBackgroundTask(
    actorId: string,
    input: {
      sessionId?: string;
      chatUserMessageId?: string;
      goal: string;
      source?: string;
    },
  ): string | null {
    const provider = this.externalChat;
    if (!provider?.isEnabled()) return null;
    const sessionId = input.sessionId?.trim() || actorId;
    const taskHub = getTaskHub();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    taskHub.submit({
      taskId,
      sessionId,
      ...(input.chatUserMessageId ? { replyAnchorId: input.chatUserMessageId } : {}),
      goal: input.goal,
    });
    console.info(
      `[AgentCore] 后台任务已派发 ${taskId} (source=${input.source ?? "task.dispatch"}, goal=${input.goal.slice(0, 60)})`,
    );

    const registry = this.wsRegistry;
    const messageId = `assistant-task-${taskId}`;
    let seq = 0;
    const pushDelta = (delta: string): void => {
      if (!delta) return;
      seq += 1;
      try {
        registry?.trySend(
          sessionId,
          JSON.stringify({
            type: ServerEventType.ChatAssistantChunk,
            payload: {
              sessionId,
              messageId,
              chunk: delta,
              sequence: seq,
              phase: "stream",
              source: "task_plane",
            },
          }),
        );
      } catch {
        /* 投递失败不影响任务执行 */
      }
    };
    const pushDone = (finalText: string): void => {
      try {
        registry?.trySend(
          sessionId,
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: { sessionId, messageId, finalText, toolCalls: [], source: "task_plane" },
          }),
        );
      } catch {
        /* ignore */
      }
    };

    void (async () => {
      const fastAttemptStart = Date.now();
      try {
        // 快速通道（默认起步，2026-09-05 先轻后重）：tool router 召回执行
        //（可见集=桥工具，零业务 schema）+ Flash 档 + 缓冲执行；产出道歉式/空
        // → 升级完整通道：planner + 预算波 + Pro 档（流式）。
        let result = await this.runStandardLlmPath(
          actorId,
          input.goal,
          "complex",
          {
            sessionId,
            ...(input.chatUserMessageId ? { chatUserMessageId: input.chatUserMessageId } : {}),
          },
          {
            sessionId,
            turnPlan: { budget: 2, capabilities: ["full"], tier: "fast" },
            taskHubTaskId: taskId,
            ephemeralTurn: true,
            toolRecallOnly: true,
          },
        );
        let finalText = (result.text ?? "").trim();
        const fastAttemptMs = Date.now() - fastAttemptStart;
        if (!finalText || isApologyStyleFallback(finalText)) {
          console.info(
            `[AgentCore] 快速通道未收尾，升级 plan-and-execute：${input.goal.slice(0, 60)}`,
          );
          result = await this.runStandardLlmPath(
            actorId,
            input.goal,
            "complex",
            {
              sessionId,
              ...(input.chatUserMessageId ? { chatUserMessageId: input.chatUserMessageId } : {}),
              onAssistantDelta: pushDelta,
            },
            {
              sessionId,
              turnPlan: { budget: 3, capabilities: ["full"], tier: "complex" },
              taskHubTaskId: taskId,
              ephemeralTurn: true,
            },
          );
          finalText = (result.text ?? "").trim();
          recordFastChannelOutcome(
            finalText ? "upgraded_ok" : "failed",
            fastAttemptMs,
            input.goal,
          );
        } else {
          recordFastChannelOutcome("fast_ok", fastAttemptMs, input.goal);
        }
        taskHub.setState(taskId, finalText ? "done" : "failed");
        if (finalText) {
          // 对话 thread 显式并入后台任务交换（ephemeral 执行不自动落 thread）
          try {
            provider.appendThreadTurn?.(
              resolvePrimaryChatSessionId(
                actorId,
                getAgentRuntimeConfig().masterDelegation.enabled,
              ),
              { text: `[后台任务] ${input.goal}` },
              finalText,
            );
          } catch {
            /* thread 并入失败不影响结果投递 */
          }
          pushDone(finalText);
        } else {
          pushDone(FALLBACK_TEXT_BACKGROUND_FAILED());
        }
      } catch (err) {
        taskHub.setState(taskId, "failed");
        console.error("[AgentCore] 后台任务执行失败:", err);
        pushDone(FALLBACK_TEXT_BACKGROUND_FAILED());
      }
    })();
    return taskId;
  }

  /**
   * 紧急重生成：当主流程 + 降级都失败时，用最小化 prompt 直接调 LLM 生成回复。
   * 不再用 apology 兜底文案——让 agent 真正回复内容，哪怕是简短的。
   * 返回空串（而非 apology）让上层用工具结果拼接，调用方需处理空串。
   */
  private async emergencyRegenerate(
    actorId: string,
    userText: string,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    try {
      const provider = this.externalChat;
      if (!provider?.isEnabled()) return "";
      const text = await provider.streamCompletion(
        `emergency-${actorId}-${Date.now()}`,
        { text: userText },
        (delta) => onAssistantDelta?.(delta),
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 3,
        },
      );
      return text.trim();
    } catch (err) {
      console.error("[AgentCore] emergencyRegenerate 也失败:", err);
      return "";
    }
  }


private async finishLlmTurn(
    actorId: string,
    userText: string,
    assistantText: string,
    meta: {
      streamedChunks: boolean;
      modelCallsConsumed: number;
      planExecuteUsed: boolean;
      pePlan: TaskExecutionPlan | null;
      peExhausted: boolean;
      trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
      messageId?: string;
      sessionId?: string;
    },
    onAssistantDelta?: (delta: string) => void,
  ): Promise<AgentReply> {
    const outputSafety = this.brainCenter?.checkOutputSafety(assistantText, {
      actorId,
      sessionId: meta.sessionId,
      userText,
    });
    let sanitizedOutput = outputSafety?.sanitized ?? assistantText;

    // 剥离 LLM 回显的内部信号标签前缀（根源净化已在 provider 推流咽喉完成，
    // 这里是最终兜底，双保险防标签透出）：
    //  - 话题切换标签：[话题切换，只答这个] / [Topic switched — don't revisit.]
    //  - 停止/待用户输入信号：[STOP needs a message from the user]
    // 零 token 程序层剥离，不做重生成。
    sanitizedOutput = stripInternalControlTags(sanitizedOutput);

    // 钩子 3：RuntimeKernel 后置校验（零 token，程序层拦截违规输出）
    // 全程不向 LLM 发任何约束 prompt，纯规则匹配。违规时记录日志但不阻断输出（避免循环重生成）
    const runtimeKernel = getRuntimeKernel(actorId);
    if (runtimeKernel.isMinimalMode()) {
      const postResult = runtimeKernel.postValidate(sanitizedOutput);
      if (!postResult.ok) {
        console.warn(
          `[RuntimeKernel.postValidate] 输出违规，命中 ${postResult.hitPatterns.length} 条规则：`,
          postResult.violations,
        );
        // 当前策略：仅记录日志，不重生成（避免循环 + 失败时仍要给用户回复）
        // 后续如需重生成，可在此处加 retry 逻辑
      }
    }

    const trimmed = sanitizedOutput.trim();
    if (!trimmed) {
      // 空响应修复：不再用兜底文案，而是重新调用一次 LLM 强制出文本。
      // 根因：某些轮次 LLM 只返回 tool_calls 没有文本 delta，streamCompletion 返回空字符串。
      // 重新调用（不带工具上下文）让 LLM 基于对话历史生成自然回复。
      console.warn("[AgentCore] finishLlmTurn 收到空响应，重新调用 LLM 强制出文本");
      try {
        const provider = this.externalChat;
        if (provider?.isEnabled()) {
          const regenerateText = await provider.streamCompletion(
            `regen-${actorId}-${Date.now()}`,
            { text: `${userText}\n\n[系统提示：上一轮没有生成回复文本，请直接用自然语言回答用户]` },
            (delta) => onAssistantDelta?.(delta),
            undefined,
            {
              ephemeralTurn: true,
              disableThinking: true,
              maxThreadMessages: 4,
            },
          );
          const regenTrimmed = regenerateText.trim();
          if (regenTrimmed) {
            return {
              text: regenTrimmed,
              streamedChunks: meta.streamedChunks,
            };
          }
        }
      } catch (regenErr) {
        console.error("[AgentCore] 重新调用 LLM 也失败:", regenErr);
      }
      // 重新调用也失败：返回空串让上层用工具结果拼接，不用 apology 文案
      return {
        text: "",
        streamedChunks: false,
      };
    }

    TurnLifecycle.finalizeTrajectory(meta.trajCap, trimmed, {
      planExecuteUsed: meta.planExecuteUsed,
      modelCallsApprox: meta.modelCallsConsumed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
    });

    const { quotaSuffix } = this.turnLifecycle.finalizeTurn({
      actorId,
      userText,
      assistantText: trimmed,
      sessionId: meta.sessionId,
      modelCallsConsumed: meta.modelCallsConsumed,
      planExecuteUsed: meta.planExecuteUsed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
      messageId: meta.messageId,
    });

    if (this.shortTermMemoryGateway && meta.sessionId) {
      this.shortTermMemoryGateway.reconcileTaskAfterTurn(meta.sessionId, userText, trimmed);
      getDailyJournalService()?.appendTurn(actorId, meta.sessionId, userText, trimmed);
    }

    return {
      text: quotaSuffix ? `${trimmed}\n\n${quotaSuffix}` : trimmed,
      streamedChunks: meta.streamedChunks,
    };
  }
}
