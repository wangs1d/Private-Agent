import { randomUUID } from "node:crypto";

import { humanizeAssistantText } from "./assistant-humanizer.js";
import { normalizeSentence, sentenceSet, stripSentencesAlreadySaid } from "../utils/text.js";
import { parseFastVerdict, stripFastVerdictMarker, VerdictStreamGuard, type FastTaskSpec } from "../utils/fast-verdict.js";
import type { WorldService } from "@private-ai-agent/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DesktopBridgeCoordinator } from "./desktop-bridge-coordinator.js";
import type { PhoneBridgeCoordinator } from "./phone-bridge-coordinator.js";
import type { LocationCoordinator } from "./location-coordinator.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type { SemanticIntentParser, SemanticIntent } from "./semantic-intent-types.js";
import type { SemanticIntentService } from "./semantic-intent-service.js";
import { seedIdentityMarkdown } from "../agent/identity-markdown-seeder.js";

/** 意图澄清置信度阈值：低于此值且 clarificationNeeded 时触发澄清反问 */
const CLARIFY_CONFIDENCE_THRESHOLD = 0.55;

/**
 * FastVerdict 输出规范（fast 模式注入 system prompt）。
 * 要求 fast 在回复正文末尾另附一行隐藏结构化块，供服务端解析剥离，不展示给用户：
 *  `<<<verdict:{单行 JSON}>>>`
 * 用于：判定本轮是否需并行 complex + 产出交给 complex 的封闭任务规范。
 * 置于最后，保证正文之后的判定不抢占视觉效果。
 */
const FAST_VERDICT_PROMPT_INSTRUCTION = `【隐藏判定块·fast】本轮回复正文结束后，另起一行单独输出下面这个隐藏块（供服务端任务编排，绝不展示给用户，你正文里也不要提到它）：
<<<verdict:{"need_complex":布尔,"difficulty":"simple|needs_external|multi_step","task_spec":{...}}>>>
要求：
- JSON 必须为单行合法 JSON，不要在块前后追加任何说明文字，不要把块写在正文里。
- need_complex：本轮是否需要在后台并行 complex（查实时/外部信息、调工具/skill/MCP、多步任务）。
- difficulty：simple=纯闲聊/常识/可直接作答；needs_external=需查实时或外部信息；multi_step=需多步协调/写操作/派子Agent。
- task_spec 仅当 need_complex 为 true 时给出，为 { goal:简洁目标, expected_output:明确产出要求, constraints:约束或"无", tool_hints:建议工具名数组, budget:{max_tool_rounds,max_llm_calls} }。
- 判定只取一次：simple 一律 need_complex=false 且不带 task_spec；needs_external/multi_step 才 need_complex=true。
返回示例（need_complex=true）：<<<verdict:{"need_complex":true,"difficulty":"needs_external","task_spec":{"goal":"查询2026年奥斯卡最佳影片及导演","expected_output":"影片名+导演+一句话获奖说明，以事实为准","constraints":"无","tool_hints":["web.search"],"budget":{"max_tool_rounds":2,"max_llm_calls":3}}}>>>`;
import type { AgentReply } from "../agent/types.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { SkillManager } from "../skills/index.js";
import type { EvolutionLoopService } from "./evolution-loop-service.js";
import type { MoodInferenceService } from "./mood-inference-service.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";
import type { LifeSignalHubService } from "./life-signal-hub-service.js";
import { ServerEventType } from "../protocol.js";
import type {
  PersonalizationPromptSlice,
  UserPersonalizationService,
} from "./user-personalization/user-personalization-service.js";
import {
  type TaskExecutionPlan,
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
import { describeMemoryAge } from "./memory-record-utils.js";

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
import { resolveUserLocationPrompt } from "../services/user-location-service.js";
import type { ClientLocationWire } from "../types/client-location.js";
import { isMasterAgentDelegationEnabled } from "../agent/master-agent-delegate-env.js";
import { determineSegmentable, isDesktopAutomationTask, type LlmExecutionMode, type RouteDecision } from "../agent/task-router.js";
import { routeTask } from "../gateway/index.js";
import {
  MEMORY_RECALL_HINT_RE,
  isAmbiguousFollowUpMessage,
  shouldInjectMemorySummary,
} from "../agent/memory-signal.js";
import { TaskTier, buildModelOverrideOpts } from "../config/model-routing.js";
import type { BrainCenter } from "../brain/index.js";
import type { EmotionVector, MemoryRecallItem } from "../brain/types.js";
import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import { TurnLifecycle } from "../agent/turn-lifecycle.js";
import { masterChatSessionId, resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
import { stripInternalControlTags } from "../external-model/stream-chat-helpers.js";
import { MasterAgentCoordinator } from "./master-agent-coordinator.js";
import type { PerformanceMetrics, SubAgentPerformanceMetrics } from "./master-agent-coordinator.js";
import { AgentTaskOrchestrator } from "./agent-task-orchestrator.js";
import type { AgentTaskOrchestratorDeps, RunTaskOptions } from "./agent-task-orchestrator.js";
import { getAgentTaskStore } from "./agent-task-store.js";
import { LoopOrchestrator } from "../agent/loop/loop-orchestrator.js";
import {
  ReactLoopStrategy,
  PlanExecuteLoopStrategy,
  StateMachineStrategy,
  type LoopStrategy,
} from "../agent/loop/loop-strategy.js";
import { DefaultTerminationPolicy } from "../agent/loop/default-termination.js";
import { DefaultRecoveryPolicy } from "../agent/loop/default-recovery.js";
import { DefaultProgressTracker } from "../agent/loop/default-progress.js";
import { DefaultEscalationPolicy } from "../agent/loop/default-escalation.js";
import { getRuntimeKernel } from "../agent/runtime-kernel.js";
import { getFastLaneTools } from "../external-model/openai-compatible-tool-loop.js";
import { isLoopOrchestratorEnabled, getLoopMaxReplans } from "../config/env.js";
import { ToolContextFactory } from "../agent/execution/tool-context-factory.js";
import { StreamOptionsBuilder } from "../agent/execution/stream-options-builder.js";
import { TurnFinalizer } from "../agent/execution/turn-finalizer.js";
import { ToolPolicyResolver } from "../agent/execution/tool-policy-resolver.js";
import {
  appendLearningDecisionGuidance,
  appendRecentConversationHistory,
  appendWorkingMemorySummary,
  recallItemsToNarrative,
} from "../agent/execution/narrative-recall-composer.js";

export type MasterAgentDelegationSnapshot = {
  enabled: boolean;
  metrics: PerformanceMetrics | null;
  subAgentMetrics: Record<string, SubAgentPerformanceMetrics> | null;
  history: Array<unknown>;
  suggestions: string[];
  config: {
    taskTimeoutMs: number;
    techSubtaskTimeoutMs: number;
    infoSubtaskTimeoutMs: number;
    maxSubAgentInvocationsPerTurn: number;
    maxParallelTasks: number;
  } | null;
};

export type { AgentReply } from "../agent/types.js";

const META_CONVERSATION_RECALL_RE =
  /上次聊天|上回聊天|上次聊|上回聊|最后(?:一次)?(?:说|聊|谈)|最近(?:一次)?(?:说|聊|谈)|之前(?:说|聊|谈)了?什么|什么时候(?:聊|说|谈)|还记得.*(?:上次|上回|之前|最后)/i;

/** P0 时间窗口查询感知：用户问"昨天/上周做了什么"或询问事件经过时，把时间词锚进召回 query，
 *  提高对应时间窗口内 episodic 记忆的召回概率（配合注入侧的相对时间标注闭环）。 */
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
   * 外层(WS 层)已计算的路由决策。传入时 agent-core 复用,避免重复调 routeLlmExecution。
   * 未传时 agent-core 内部自行调用(向后兼容)。
   */
  routeDecision?: RouteDecision;
};

type ShortTermTurnContext = {
  recallQuery: string;
  activeTaskId?: string;
  resumedTask: boolean;
};

// Loop Orchestrator 启用开关已移至 config/env.ts 的 isLoopOrchestratorEnabled（默认开启）。

export class AgentCore {
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly toolContextFactory: ToolContextFactory;
  private readonly streamOptionsBuilder = new StreamOptionsBuilder();
  private readonly turnFinalizer: TurnFinalizer;
  private readonly toolPolicyResolver: ToolPolicyResolver;
  private readonly masterAgentCoordinator: MasterAgentCoordinator | null = null;
  private readonly agentTaskOrchestrator: AgentTaskOrchestrator | null = null;
  private readonly loopOrchestrator: LoopOrchestrator | null = null;
  private desktopBridgeCoordinator: DesktopBridgeCoordinator | null = null;
  private phoneBridgeCoordinator: PhoneBridgeCoordinator | null = null;
  private locationCoordinator: LocationCoordinator | null = null;
  private moodInferenceService: MoodInferenceService | null = null;
  private wsRegistry: WsConnectionRegistry | null = null;
  private lifeSignalHubService: LifeSignalHubService | null = null;
  /** BrainCenter 引用：可用时走 cognize() 端到端认知入口替代认知层切片 */
  private brainCenter: BrainCenter | null = null;
  /** 语义意图解析器（LLM 理解用户真实意图；可选注入） */
  private semanticIntentParser: SemanticIntentParser | null = null;
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
    semanticIntentParser: SemanticIntentParser | null = null,
  ) {
    this.moodInferenceService = moodInferenceService;
    this.lifeSignalHubService = lifeSignalHubService;
    this.semanticIntentParser = semanticIntentParser;
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

    if (this.externalChat?.isEnabled() && isMasterAgentDelegationEnabled()) {
      const cfg = getAgentRuntimeConfig().masterDelegation;
      this.masterAgentCoordinator = new MasterAgentCoordinator(
        this.externalChat,
        this.toolRegistry,
        this.promptContextBuilder,
        {
          enableSubAgents: true,
          maxParallelTasks: cfg.maxParallelSubAgents,
          taskTimeoutMs: cfg.subtaskTimeoutMs,
          techSubtaskTimeoutMs: cfg.techSubtaskTimeoutMs,
          infoSubtaskTimeoutMs: cfg.infoSubtaskTimeoutMs,
          allowFallback: true,
          onBackgroundJobUpdate: (update) => {
            const registry = this.wsRegistry;
            if (!registry) return;
            registry.trySend(
              update.sessionId,
              JSON.stringify({
                type: ServerEventType.AgentAsyncTaskUpdate,
                payload: update,
              }),
            );
          },
        },
      );
    }

    // 初始化状态机编排器(桌面自动化任务,外部状态机驱动 LLM 多轮调用)
    if (this.externalChat && this.toolRegistry) {
      const orchestratorDeps: AgentTaskOrchestratorDeps = {
        provider: this.externalChat,
        toolRegistry: this.toolRegistry,
      };
      this.agentTaskOrchestrator = new AgentTaskOrchestrator(orchestratorDeps);

      // 初始化 Loop Orchestrator（默认开启，feature flag 控制）。
      // 双模式下：fast 走 ReactLoopStrategy，complex 走 PlanExecuteLoopStrategy + StateMachine。
      // complex 内部自适应选择 plan_execute / state_machine，路由层不感知。
      const loopStrategies = new Map<LlmExecutionMode, LoopStrategy>();
      loopStrategies.set("fast", new ReactLoopStrategy(this.externalChat));
      const maxReplans = getLoopMaxReplans();
      loopStrategies.set("complex", new PlanExecuteLoopStrategy(this.externalChat, maxReplans));
      this.loopOrchestrator = new LoopOrchestrator(loopStrategies, {
        termination: new DefaultTerminationPolicy(),
        recovery: new DefaultRecoveryPolicy(),
        progress: new DefaultProgressTracker(this.externalChat),
        escalation: new DefaultEscalationPolicy(),
        maxReplans,
      });
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

  /** 在 bootstrap 注册情绪感知后注入，用于按轮分析用户消息情绪。 */
  setMoodInferenceService(service: MoodInferenceService | null): void {
    this.moodInferenceService = service;
  }

  /** 在 bootstrap 注册 WS 连接注册表后注入，用于将情绪事件推送给客户端。 */
  setWsRegistry(registry: WsConnectionRegistry | null): void {
    this.wsRegistry = registry;
  }

  /** 在 bootstrap 注册 LifeSignalHub 后注入，用于在情绪推理后发布 mood 信号。 */
  setLifeSignalHubService(service: LifeSignalHubService | null): void {
    this.lifeSignalHubService = service;
  }

  /** 注入语义意图解析器（LLM 理解用户真实意图）。未注入时跳过意图解析。 */
  setSemanticIntentParser(parser: SemanticIntentParser | null): void {
    this.semanticIntentParser = parser;
  }

  /**
   * 注入 BrainCenter。可用时 handleUserMessage 走 cognize() 端到端认知入口，
   * 替代原切片式 moodInference + routeLlmExecution + buildShortTermTurnContext。
   * BRAIN_CENTER_ENABLED=0 时 brainCenter 为 null，降级到原切片路径。
   */
  setBrainCenter(brain: BrainCenter | null): void {
    this.brainCenter = brain;
    if (brain) {
      brain.registerRuntimeKernel(getRuntimeKernel());
    }
  }

  private formatSemanticIntent(intent: SemanticIntent | undefined): string | undefined {
    if (!intent) return undefined;
    const lines: string[] = [
      `用户真实意图：${intent.intent}`,
      `类别：${intent.category}｜置信度：${intent.confidence.toFixed(2)}｜建议模式：${intent.preferredMode}`,
    ];
    if (intent.preferredToolDomain) {
      lines.push(`建议工具域：${intent.preferredToolDomain}`);
    }
    if (intent.entities.length > 0) {
      lines.push(`关键实体：${intent.entities.map((e) => `${e.type}=${e.value}`).join("；")}`);
    }
    if (intent.subIntents.length > 0) {
      lines.push(`子意图：${intent.subIntents.join("；")}`);
    }
    if (intent.clarificationNeeded && intent.clarificationQuestion?.question) {
      lines.push(`仍需澄清：${intent.clarificationQuestion.question}`);
    }
    return lines.join("\n");
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
        recallQuery: text,
        resumedTask: false,
      };
    }

    const sync = this.shortTermMemoryGateway.syncTaskForTurn(sessionId, text);
    return {
      recallQuery: this.enrichMemoryRecallQuery(
        this.shortTermMemoryGateway.buildRecallQuery(sessionId, text),
        text,
      ),
      activeTaskId: sync.task.taskId,
      resumedTask: sync.resumed,
    };
  }

  /**
   * fast 模式（对话主链路）的轻量子孙：不激活任务（避免闲聊污染任务栈），
   * 但召回 query 用会话感知的 buildRecallQuery，把当前话题/任务锚定进长期记忆召回，
   * 避免裸文本在用户全局记忆池里随机捞到别的会话的记忆（串台根因之一）。
   * buildRecallQuery 为只读：话题切换时自动丢弃旧话题上下文（resolveTurnFocus=不相关），
   * 延续时带上当前任务/话题，让长期召回贴合当前会话。
   */
  private buildFastShortTermTurnContext(sessionId: string, text: string): ShortTermTurnContext {
    const baseRecallQuery = this.shortTermMemoryGateway?.buildRecallQuery(sessionId, text) ?? text;
    return {
      recallQuery: this.enrichMemoryRecallQuery(baseRecallQuery, text),
      resumedTask: false,
    };
  }

  /** 注入主动性模块（对话内主动触发等能力的统一入口） */
  setProactivityHub(hub: import("../proactivity/proactivity-hub.js").ProactivityHub | null): void {
    this.proactivityHub = hub;
    // advise 模式接线：hub 的建议队列接入 prompt 注入（【Agent 主动建议】块）
    this.promptContextBuilder.setAdviceStore(hub ? hub.getAdvices() : null);
    // 复杂任务完成恭喜接线：编排器持有同一 hub
    this.agentTaskOrchestrator?.setProactivityHub(hub);
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
    /** 语义意图理解结果 */
    let semanticIntent: SemanticIntent | undefined;

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

    // === 语义意图理解（入口层，路由之前）===
    // 短输入（< 30 字，闲聊/快速问答）：完全跳过意图解析，首字不再额外等一次 LLM。
    // 中长输入：与后续认知并行启动，200ms 内若返回低置信澄清则短路反问；
    // 超时则不再等，让 tool-loop 主回复路径接管，语义意图作为可选 hint 稍后汇入。
    const trimmedText = text?.trim() ?? "";
    const PARSE_INTENT_RACE_MS = 200;
    const SHORT_TEXT_SKIP_PARSE_CHARS = 30;
    if (trimmedText && this.semanticIntentParser && trimmedText.length >= SHORT_TEXT_SKIP_PARSE_CHARS) {
      const parsePromise = this.semanticIntentParser.parseIntent(sessionId, text).catch((err) => {
        console.log(
          `[SemanticIntent] 意图解析失败，降级到原路由路径：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      });
      const raceTimer = new Promise<undefined>((r) =>
        setTimeout(() => r(undefined), PARSE_INTENT_RACE_MS),
      );
      try {
        const maybeIntent = await Promise.race([parsePromise, raceTimer]);
        if (maybeIntent) {
          semanticIntent = maybeIntent;
          if (
            semanticIntent.clarificationNeeded &&
            semanticIntent.confidence < CLARIFY_CONFIDENCE_THRESHOLD &&
            semanticIntent.clarificationQuestion?.question
          ) {
            const q = semanticIntent.clarificationQuestion.question;
            this.turnLifecycle.finalizeTurn({
              actorId,
              userText: text,
              assistantText: q,
              sessionId,
            });
            opts?.onAssistantDelta?.(q);
            return {
              text: q,
              streamedChunks: true,
              clarification: {
                question: q,
                options: semanticIntent.clarificationQuestion?.options,
              },
            };
          }
        }
      } catch {
        // 异常静默降级，不阻塞主流程
      }
    }

    // === 对话认知入口 ===
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
    /** 工作记忆摘要（注入 streamCompletion 的 prompt） */
    let cognitiveWorkingMemorySummary = "";
    /** cognize 阶段 3.5 元认知评估结果（透出给 runStandardLlmPath → promptContext.memory.metaCognition） */
    let cognitiveMetacog: import("../brain/meta-cognition-cortex.js").MetacogAssessment | undefined;
    /** cognize 阶段 1 情绪向量（透出给 runStandardLlmPath → promptContext.memory.emotionState） */
    let cognitiveEmotion: import("../brain/types.js").EmotionVector | null = null;
    /** cognize 阶段 1.5.1 拉取的最近 6 轮对话历史（注入 prompt【最近对话】块） */
    let cognitiveRecentConversationHistory = "";
    /** 深度优化：用户画像（来自 OnlineLearningCortex），注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
    let cognitiveUserPattern: {
      topics: string[];
      preferredToolDomain?: string;
      negativeFeedbackCount: number;
      learningActive?: boolean;
    } | undefined;
    /** 深度优化：工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围 */
    let cognitiveToolPlan: import("../brain/tool-planning-cortex.js").ToolPlan | undefined;
    let parallelLiveComplex = false;
    let parallelLiveOriginalRoute: RouteDecision | null = null;

    if (this.brainCenter && text?.trim()) {
      // 性能优化(C5):复用 WS 层已计算的路由决策,避免重复调 routeTask
      const fastRoute = opts?.routeDecision ?? routeTask(text, getAgentRuntimeConfig(), {
        preferFullPipeline: opts?.preferFullPipeline === true,
      });

// 单一权威路由源：task-router 只做硬规则 pre-filter，最终以 DecisionHub 规则路由为准。
      // 给 fast 注入规则置信度（纯规则、不调 LLM），低置信度(<0.4)提前升级 complex，
      // 把「低置信度升级」从 hedging 事后检测前移，减少 fast 凭印象答后二次重跑的 LLM 消耗。
      const light = this.brainCenter.routeLight(text);
      const lowConfidence = light.confidence < 0.4;
      // 需要走 complex 的三种情况：硬规则命中 / 规则路由判 complex / 低置信度升级
      const shouldGoComplex =
        fastRoute.mode === "complex" || light.mode === "complex" || lowConfidence;

      let brainCognition: import("../brain/types.js").CognitiveResult | null = null;
      try {
        brainCognition = await this.brainCenter.cognize({
          actorId,
          text,
          sessionId,
        });
      } catch (err) {
        console.log(
          `[AgentCore] BrainCenter.cognize 失败，降级使用轻量记忆路径：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // 对话内主动钩子：交给主动性模块（ProactivityHub）统一检测与路由，
      // fire-and-forget 不阻塞主回复。命中强线索时经频控后发布信号 →
      // 现有主动决策闭环（ProactionCortex）接管。
      this.proactivityHub?.observeConversationTurn(actorId, text, cognitiveRecentConversationHistory);

      // Parallel-Live：规则判为 fast 高置信但可并行深挖时，fast 先主答，complex 后台并行补充
      const useParallelLive = this.shouldUseParallelLiveComplex(text, fastRoute, opts);
      if (useParallelLive) {
        parallelLiveComplex = true;
        parallelLiveOriginalRoute = fastRoute;
      }

      if (!shouldGoComplex) {
        // Fast 模式：保留 task-router 硬规则结果 + 注入规则置信度（用于日志/诊断）
        route = useParallelLive
          ? { mode: "fast", reasons: [...fastRoute.reasons, "parallel_live_fast_lane"], segmentable: fastRoute.segmentable }
          : {
              mode: brainCognition?.route.mode ?? "fast",
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
        cognitiveRecentConversationHistory = brainCognition?.recentConversationHistory ?? "";
        cognitiveMetacog = brainCognition?.metacog;
        cognitiveEmotion = brainCognition?.emotion ?? null;
        cognitiveUserPattern = this.brainCenter?.getOnlineLearningCortex()?.getProfile(actorId) ?? undefined;
        cognitiveToolPlan = brainCognition?.toolPlan;

        // 异步情绪推断（不阻塞主流程）
        if (this.moodInferenceService) {
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
      } else {
        // Complex 模式：对话认知归 fast（完整 cognize 只服务对话层），complex 仅作后台任务执行器。
        // 不再 await 完整 cognize —— 省去感知阶段串行等待，让工具从对话一开始就启动；
        // 记忆/工作记忆/位置/个性化由后续兜底路径（prepareNarrativeRecall 等）自行拉取。
        // 情绪推送改为异步（不阻塞工具执行），MoodInferred 事件仍正常下发。
        route = {
          mode: brainCognition?.route.mode ?? "complex",
          reasons: [
            ...fastRoute.reasons,
            `rule=${light.mode}@${light.confidence.toFixed(2)}`,
            ...(brainCognition ? [`brain=${brainCognition.route.mode}:${brainCognition.rationale}`] : []),
            "complex_background_executor",
          ],
          segmentable: false,
        };
        shortTermTurn = this.buildFastShortTermTurnContext(sessionId, text);
        cognitiveResponse = brainCognition?.response ?? "";
        cognitiveNeedsToolLoop = true; // 强制走工具循环
        cognitiveRecallItems = brainCognition?.recallItems;
        cognitiveWorkingMemorySummary = brainCognition?.workingMemorySummary ?? "";
        cognitiveRecentConversationHistory = brainCognition?.recentConversationHistory ?? "";
        cognitiveMetacog = brainCognition?.metacog;
        cognitiveEmotion = brainCognition?.emotion ?? null;
        cognitiveUserPattern = this.brainCenter?.getOnlineLearningCortex()?.getProfile(actorId) ?? undefined;
        cognitiveToolPlan = brainCognition?.toolPlan;

        // 异步情绪推断（不阻塞工具执行，MoodInferred 仍推送）
        if (this.moodInferenceService) {
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
      route = routeTask(text, getAgentRuntimeConfig(), {
        preferFullPipeline: opts?.preferFullPipeline === true,
      });
      if (this.shouldUseParallelLiveComplex(text, route, opts)) {
        parallelLiveComplex = true;
        parallelLiveOriginalRoute = route;
        route = { mode: "fast", reasons: [...route.reasons, "parallel_live_fast_lane"], segmentable: route.segmentable };
        shortTermTurn = this.buildFastShortTermTurnContext(sessionId, text);
      } else {
        shortTermTurn = route.mode === "fast"
          ? this.buildFastShortTermTurnContext(sessionId, text)
          : this.buildShortTermTurnContext(sessionId, text);
      }
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

    // 2026-07-29 修复：用户陈述具体数据时（含温度/降水/行程/日期动作），跳过 userLocation 注入。
    // 原 BUG：用户说"今天20到26度"时，userLocation prompt 会让 LLM 反问"你是不是在 XX"，
    // 把"陈述"误判为"查询"，导致对话岔开。判定条件：route.reasons 包含"用户陈述具体数据"标识。
    const userIsStatingData = route.reasons.some(
      (r) => r.includes("用户陈述具体数据") || r.includes("user_stating_data"),
    );

    // 2026-07-29 修复 C1：计算当前 thread store 中实际消息数（不含 system），
    // 用于判断 narrativeRecall 末尾的 [最近对话] 块是否与 msgs 重复。
    // 12 条 ≈ 6 轮 user/assistant 配对；超过此值说明 LLM 已能从 msgs 看到最近对话。
    // 失败时返回 -1（关闭 dedup 判定，保持原行为）。
    const threadMessageCount = this.peekThreadMessageCount(actorId, sessionId);

    // 2026-07-29 修复 D：fast_chat 也注入 narrativeRecall（复用 cognize 召回结果），
    // 解决追问被误判 fast_chat 时 LLM 只有 thread messages、缺乏长期记忆/工作记忆导致答非所问。
    // 仍跳过 userLocation（保持速度，避免反问"你是不是在 XX"）和 personalization（fast_chat 不需要个性化语气）。
    //
    // 2026-08-11 修复 E（思路 A）：工作记忆摘要 + 最近对话回顾不再拼入 narrativeRecall，
    // 而是作为独立字段透传给 PromptContextBuilder，作为独立块注入 system prompt。
    // 原实现把它们拼到 narrativeRecall 末尾，被 formatNarrativeRecallPrompt 的 slice(0,4)
    // 当作召回条目丢弃、块结构被拍平、hint 被正则误杀 → agent 看到的上下文跳转、不能针对当前话回复。
    // 话题切换门控：用户真正切换话题（无任务延续/无指代，STM 解析为 topic_switch）时，
    // 抑制长期记忆召回，避免把旧话题/跨会话记忆注入当前新话题（串台根治）。
    // 仅抑制长期记忆（narrativeRecall），当前会话的【最近对话回顾】/STM 上下文仍正常注入。
    const suppressNarrativeRecall = this.isTopicSwitchTurn(sessionId, text);

    const [narrativeRecall, workingMemorySummary, recentConversationHistory, userLocation, personalization] = this
      .isFastMode(route.mode)
      ? await Promise.all([
          // Fast 模式记忆注入：
          // - 有 cognize 召回结果时直接复用（Complex 路径）
          // - 无 cognize 召回结果时（Fast 跳过 cognize 路径），走 prepareNarrativeRecall
          suppressNarrativeRecall
            ? Promise.resolve(undefined)
            : (cognitiveRecallItems && cognitiveRecallItems.length > 0
                ? Promise.resolve(this.recallItemsToNarrative(cognitiveRecallItems))
                : this.turnLifecycle.prepareNarrativeRecall(actorId, shortTermTurn.recallQuery)),
          // 工作记忆摘要独立透传（不再拼入 narrativeRecall）
          Promise.resolve(cognitiveWorkingMemorySummary || undefined),
          // 最近对话回顾独立透传（含 C1 dedup 判定，hint 由 buildLayeredSystemPrompt 统一添加）
          Promise.resolve(
            this.buildRecentConversationHistoryBlock(
              cognitiveRecentConversationHistory,
              threadMessageCount,
              actorId,
              text,
            ),
          ),
          Promise.resolve(undefined),
          Promise.resolve({} as PersonalizationPromptSlice),
        ])
      : await Promise.all([
          // 复用 cognize 阶段已召回的记忆条目，避免同一轮用户消息重复触发 MemoryCortex.recall
          // （cognize 未召回或降级路径未填充 recallItems 时，仍走原 prepareNarrativeRecall 逻辑）
          suppressNarrativeRecall
            ? Promise.resolve(undefined)
            : (cognitiveRecallItems && cognitiveRecallItems.length > 0
                ? Promise.resolve(this.recallItemsToNarrative(cognitiveRecallItems))
                : this.turnLifecycle.prepareNarrativeRecall(actorId, shortTermTurn.recallQuery)),
          Promise.resolve(cognitiveWorkingMemorySummary || undefined),
          Promise.resolve(
            this.buildRecentConversationHistoryBlock(
              cognitiveRecentConversationHistory,
              threadMessageCount,
              actorId,
              text,
            ),
          ),
          // 2026-07-29：用户陈述数据时跳过 userLocation 注入，避免反问"你是不是在 XX"导致对话岔开。
          // 位置只读缓存，不主动请求——实时 GPS 仅在位置类工具执行时（requestLocation）产生一次开销。
          userIsStatingData
            ? Promise.resolve(undefined)
            : this.resolveUserLocationForPrompt(actorId, opts),
          this.userPersonalizationService?.getPromptSlice(actorId, text) ?? Promise.resolve({}),
        ]);
    
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
    );
    const parallelLiveRaw =
      parallelLiveComplex && parallelLiveOriginalRoute
        ? this.startParallelLiveComplex(actorId, text, opts, orchestrateOpts, parallelLiveOriginalRoute)
        : null;

    try {
      let result: AgentReply;

      // Complex 模式分发:
      //  - 桌面自动化(desktop_automation)→ 后台 createAndRun(多轮 UI 操作,立即返回 task id)
      //  - 其他 complex(信息查询/子agent委派/时效性查询)→ fallthrough 到 master 同步流式或 runStandardLlmPath
      //    (这些场景用户期望直接看到流式回复,而非"已创建任务"占位)
      if (route.mode === "complex" && isDesktopAutomationTask(text)) {
        if (!this.agentTaskOrchestrator) {
          // orchestrator 不可用，降级到 master/runStandardLlmPath
          route = { mode: "complex", reasons: [...route.reasons, "fallback_no_orchestrator"], segmentable: false };
        } else {
        const sessionId = opts?.sessionId ?? actorId;
        const orchestrator = this.agentTaskOrchestrator;
        const registry = this.wsRegistry;
        const onDelta = opts?.onAssistantDelta;

        // 创建任务并异步启动主循环
        const taskId = orchestrator.createAndRun(
          {
            actorId,
            sessionId,
            chatUserMessageId: opts?.chatUserMessageId,
            goal: text,
            maxRounds: 30,
            tags: ["desktop_automation"],
          },
          {
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
              // 后台任务失败时推送 fallback 文案,让用户知道任务没成功
              if (event.type === "task_failed") {
                try {
                  onDelta?.(FALLBACK_TEXT_BACKGROUND_FAILED());
                } catch {
                  /* ignore */
                }
              }
            },
            onAssistantDelta: (delta) => {
              onDelta?.(delta);
            },
            onToolExecuteStart: (info) => {
              opts?.onExternalToolExecuteStart?.({
                toolName: info.name,
                input: info.args,
              });
            },
            onToolExecuted: (info) => {
              opts?.onExternalToolExecuted?.({
                toolName: info.name,
                input: {},
                ok: info.ok,
                result: (info.result as Record<string, unknown>) ?? {},
              });
              // 失败时自我学习闭环（orchestrator 路径）：写入 selfLearning
              this.brainCenter?.recordToolInteraction({
                actorId,
                sessionId,
                userRequest: text,
                attemptedTools: [info.name],
                success: info.ok,
                errorMessage: info.ok
                  ? undefined
                  : typeof (info.result as Record<string, unknown>)?.error === "string"
                    ? String((info.result as Record<string, unknown>).error).slice(0, 200)
                    : undefined,
              });
            },
          },
        );

        // 立即返回任务已创建的回复(主循环在后台异步执行)
        result = {
          text: `已创建自动化任务 #${taskId.slice(-8)},正在后台执行: ${text}\n\n任务进度会通过事件实时推送。`,
          streamedChunks: false,
        };

        return result;
        } // end else (orchestrator available)
      }

if (this.isComplexMode(route.mode)) {
        // 异步并行：complex 多线程执行（子 Agent 委派 / plan_execute），
        // fast 通过 StreamSegmenter 统一产出垫词 + 信息块分段先回复多步；
        // complex 完成后结果无缝流式回传，最终结果作为完整回复。
        const complexResult = await this.launchComplexBackgroundTask(actorId, text, opts, {
          narrativeRecall: enrichedNarrativeRecall,
          workingMemorySummary,
          recentConversationHistory,
          userLocation,
          personalization,
          trajCap,
          orchestrateOpts,
          sessionId,
          shortTermTurn,
          cognitiveMetacog,
          cognitiveEmotion,
          cognitiveUserPattern,
          cognitiveToolPlan,
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

      // 流式尾部防漏：仅当 verdict 特性开启时，缓冲识别并在 live 上吞掉 verdict 块
      const fastVerdictEnabled = process.env.FAST_VERDICT_ENABLED === "1";
      let verdictGuard: VerdictStreamGuard | null = null;
      let guardedFastOpts: HandleUserMessageOptions | undefined = opts;
      if (fastVerdictEnabled && opts?.onAssistantDelta) {
        verdictGuard = new VerdictStreamGuard(opts.onAssistantDelta);
        guardedFastOpts = { ...opts, onAssistantDelta: (delta) => verdictGuard!.push(delta) };
      }

      result = await this.runStandardLlmPath(actorId, text, "fast", guardedFastOpts, {
        narrativeRecall: enrichedNarrativeRecall,
        workingMemorySummary,
        recentConversationHistory,
        userLocation,
        personalization,
        trajCap,
        orchestrateToolCtx: orchestrateOpts,
        sessionId,
        shortTermTurn,
        cognitiveMetacog,
        cognitiveEmotion,
        cognitiveUserPattern,
        cognitiveToolPlan,
      });

      verdictGuard?.end();

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

      // ── FastVerdict 判定（feature flag 灰发布）：fast 单次判难 + 产出交接规范 ──
      // fast 回复末尾附隐藏 JSON 块 `<<<verdict:{...}>>>`，解析后剥离不推用户。
      // 命中 need_complex + task_spec 时，用 task_spec 启动后台 complex（而非原始用户文本），
      // 走 completeParallelLiveContinuation（缓冲 + 句级去重 + fast 口语化续接），不再原样流式推送。
      const verdict =
        fastVerdictEnabled && result.text ? parseFastVerdict(result.text) : null;
      // 对用户可见的正文：剥离 FastVerdict 块（未命中标记则为原样）。
      const fastReplyForUser = stripFastVerdictMarker(result.text);
      let verdictDroveUpgrade = false;

      if (
        verdict?.need_complex &&
        verdict.task_spec &&
        this.isFastMode(route.mode) &&
        !parallelLiveRaw &&
        this.masterAgentCoordinator &&
        getAgentRuntimeConfig().masterDelegation.enabled
      ) {
        console.log(
          `[AgentCore] fast verdict 判需并行 complex：difficulty=${verdict.difficulty} ` +
            `goal="${verdict.task_spec.goal.slice(0, 40)}"`,
        );
        verdictDroveUpgrade = true;
        const verdictComplexPromise = this.startComplexFromVerdict(
          actorId,
          verdict.task_spec,
          opts,
          orchestrateOpts,
        );
        if (verdictComplexPromise) {
          void this.completeParallelLiveContinuation(
            verdictComplexPromise,
            actorId,
            text,
            fastReplyForUser,
            opts,
            sessionId,
          );
        }
      }

      // ── 兜底机制：fast 回复检测 hedging 信号 → 后台升级 complex ──
      // 低置信度已在路由阶段前移升级，此处仅覆盖「规则判 fast 高置信但实际需外部信息」的少数场景。
      // 后台升级：fast 先答，complex 后台补充，完成后结果无缝流式回传。
      // Verdict 已接管时跳过，避免双重启动 complex。
      if (
        !verdictDroveUpgrade &&
        this.masterAgentCoordinator &&
        getAgentRuntimeConfig().masterDelegation.enabled &&
        result.text &&
        this.needsExternalInfoUpgrade(result.text, text)
      ) {
        console.log(
          `[AgentCore] fast 回复命中"需外部信息"兜底信号，后台升级到 complex：` +
            `userText="${text.slice(0, 40)}" replyHint="${result.text.slice(0, 60)}"`,
        );
        this.launchComplexBackgroundTask(actorId, text, opts, {
          narrativeRecall: enrichedNarrativeRecall,
          workingMemorySummary,
          recentConversationHistory,
          userLocation,
          personalization,
          trajCap,
          orchestrateOpts,
          sessionId,
          shortTermTurn,
          cognitiveMetacog,
          cognitiveEmotion,
          cognitiveUserPattern,
          cognitiveToolPlan,
        }).catch((err) => {
          console.error(`[AgentCore] 兜底 complex 后台任务异常:`, err);
        });
      }

      // Parallel-Live 续接：fast 主答已给出，后台 complex 结果句级去重后无缝衔接进对话
      if (parallelLiveRaw) {
        void this.completeParallelLiveContinuation(
          parallelLiveRaw,
          actorId,
          text,
          fastReplyForUser,
          opts,
          sessionId,
        );
      }

      // FastVerdict 块已剥离，返回对用户可见的正文
      result.text = fastReplyForUser;
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

      if (this.isComplexMode(route.mode) && this.masterAgentCoordinator) {
        console.error("[AgentCore] Master Agent orchestration failed, falling back to standard mode:", err);
        try {
          return await this.runStandardLlmPath(actorId, text, "fast", opts, {
            narrativeRecall: enrichedNarrativeRecall,
            workingMemorySummary,
            recentConversationHistory,
            userLocation,
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

  /** 主 Agent 委派监控快照（metrics / history / suggestions） */
  getMasterAgentDelegationSnapshot(): MasterAgentDelegationSnapshot {
    const cfg = getAgentRuntimeConfig().masterDelegation;
    if (!this.masterAgentCoordinator) {
      return {
        enabled: false,
        metrics: null,
        subAgentMetrics: null,
        history: [],
        suggestions: ["主 Agent 委派未启用。设置 ENABLE_MASTER_AGENT_DELEGATION=1 并配置外部模型。"],
        config: null,
      };
    }
    return {
      enabled: true,
      metrics: this.masterAgentCoordinator.getMetricsSnapshot(),
      subAgentMetrics: this.masterAgentCoordinator.getSubAgentMetricsSnapshot(),
      history: this.masterAgentCoordinator.getExecutionHistory(),
      suggestions: this.masterAgentCoordinator.getOptimizationSuggestions(),
      config: {
        taskTimeoutMs: cfg.subtaskTimeoutMs,
        techSubtaskTimeoutMs: cfg.techSubtaskTimeoutMs,
        infoSubtaskTimeoutMs: cfg.infoSubtaskTimeoutMs,
        maxSubAgentInvocationsPerTurn: cfg.maxSubAgentInvocationsPerTurn,
        maxParallelTasks: this.masterAgentCoordinator?.getMaxParallelTasks() ?? cfg.maxParallelSubAgents,
      },
    };
  }

  /** 暴露 MasterAgentCoordinator 引用供 BrainCenter/PlannerCortex 注册委派能力 */
  getMasterAgentCoordinator(): MasterAgentCoordinator | null {
    return this.masterAgentCoordinator;
  }

  adjustMasterAgentConcurrency(_newMaxParallel: number): void {
    this.masterAgentCoordinator?.adjustConcurrency(_newMaxParallel);
  }

  /** 查询子 Agent 后台任务与委派报告（供客户端「查看后台任务」面板）。 */
  getSubAgentBackgroundTasks(actorId: string, chatUserMessageId?: string): Record<string, unknown> {
    if (!this.masterAgentCoordinator) {
      return { ok: false, error: "主 Agent 委派未启用" };
    }
    return this.masterAgentCoordinator.getSubAgentTasksSnapshot(actorId, chatUserMessageId);
  }

  async handleSubAgentBackgroundTaskAction(
    actorId: string,
    taskId: string,
    action: "confirm" | "retry" | "continue_processing",
  ): Promise<Record<string, unknown>> {
    if (!this.masterAgentCoordinator) {
      return { ok: false, error: "主 Agent 委派未启用" };
    }
    return this.masterAgentCoordinator.handleBackgroundTaskAction(actorId, taskId, action);
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

  private shouldUseParallelLiveComplex(
    text: string,
    route: RouteDecision,
    opts?: HandleUserMessageOptions,
  ): boolean {
    const cfg = getAgentRuntimeConfig();
    if (!cfg.parallelLive.enabled) return false;
    if (!cfg.masterDelegation.enabled || !this.masterAgentCoordinator) return false;
    if (!this.externalChat?.isEnabled()) return false;
    if (!opts?.onAssistantDelta) return false;
    if (opts?.signal?.aborted) return false;
    const trimmed = text.trim();
    if (trimmed.length < cfg.parallelLive.minChars) return false;
    if (route.reasons.includes("desktop_automation") || isDesktopAutomationTask(trimmed)) return false;
    if (route.reasons.includes("explicit_phone_call_request")) return false;
    if (this.hasHighSideEffectIntent(trimmed)) return false;
    return true;
  }

  private hasHighSideEffectIntent(text: string): boolean {
    return /(?:创建|新增|设置|提醒我|定个|下单|购买|支付|转账|发给|发送|打电话|拨打|删除|修改|取消|退款|运行|执行|控制|点击|输入|打开|关闭|移动|安装|卸载|create|set|remind|order|buy|pay|transfer|send|call|delete|cancel|run|execute|click|install|uninstall)/i.test(text);
  }

  private startParallelLiveComplex(
    actorId: string,
    text: string,
    opts: HandleUserMessageOptions | undefined,
    orchestrateOpts: ReturnType<AgentCore["buildOrchestrateOpts"]>,
    originalRoute: RouteDecision,
  ): Promise<string> | null {
    const coordinator = this.masterAgentCoordinator;
    if (!coordinator) return null;
    const liveSessionId = `parallel-live-${actorId}-${opts?.chatUserMessageId ?? Date.now()}-${randomUUID()}`;
    console.log(
      `[AgentCore] parallel live complex started route=${originalRoute.mode} reasons=${originalRoute.reasons.join(",")}`,
    );
    return coordinator.orchestrateTask(
      actorId,
      text,
      opts?.onAgentPhaseStatus,
      undefined,
      {
        ...orchestrateOpts,
        ephemeralSessionId: liveSessionId,
      },
    );
  }

  /**
   * FastVerdict 驱动的后台 complex：用 fast 产出的 task_spec 启动，而非原始用户文本。
   * 不传 onDelta（不原样流式推送），结果交给 completeParallelLiveContinuation
   * 缓冲 + 句级去重 + fast 口语化续接，避免"整段重复"。
   */
  private startComplexFromVerdict(
    actorId: string,
    taskSpec: FastTaskSpec,
    opts: HandleUserMessageOptions | undefined,
    orchestrateOpts: ReturnType<AgentCore["buildOrchestrateOpts"]>,
  ): Promise<string> | null {
    const coordinator = this.masterAgentCoordinator;
    if (!coordinator || !taskSpec.goal) return null;
    const verdictSessionId = `verdict-complex-${actorId}-${opts?.chatUserMessageId ?? Date.now()}-${randomUUID()}`;
    return coordinator.orchestrateTask(
      actorId,
      taskSpec.goal,
      opts?.onAgentPhaseStatus,
      undefined,
      {
        ...orchestrateOpts,
        ephemeralSessionId: verdictSessionId,
      },
    );
  }

  private async completeParallelLiveContinuation(
    complexPromise: Promise<string>,
    actorId: string,
    userText: string,
    fastReplyText: string,
    opts: HandleUserMessageOptions | undefined,
    sessionId: string,
  ): Promise<void> {
    try {
      const complexResult = await complexPromise;
      if (opts?.signal?.aborted) return;
      const backgroundMessageId = `parallel-live:${opts?.chatUserMessageId ?? Date.now()}`;
      const continuation = await this.synthesizeFastContinuation(
        actorId,
        userText,
        fastReplyText,
        complexResult,
        (delta) => {
          if (opts?.signal?.aborted) return;
          opts?.onBackgroundAssistantDelta?.({
            messageId: backgroundMessageId,
            delta,
            source: "parallel_live_complex",
          });
        },
      );
      if (!continuation.trim()) return;

      const chatSessionId = resolvePrimaryChatSessionId(
        actorId,
        getAgentRuntimeConfig().masterDelegation.enabled,
      );
      const appended = getChatThreadStore().appendAssistantFollowup(
        chatSessionId,
        opts?.chatUserMessageId,
        continuation,
      );
      if (appended) {
        this.shortTermMemoryGateway?.reconcileTaskAfterTurn(sessionId, userText, appended);
        opts?.onBackgroundAssistantDone?.({
          messageId: backgroundMessageId,
          finalText: appended,
          source: "parallel_live_complex",
        });
      }
      console.log("[AgentCore] parallel live complex continuation delivered");
    } catch (err) {
      console.error("[AgentCore] parallel live complex failed; keeping fast reply:", err);
    }
  }

  /**
   * 兜底检测：主 Agent direct_llm 路径生成的回复是否暴露"需要外部信息"信号。
   * 命中条件（满足任一即升级到 master_delegate）：
   *   1. 回复含 hedging 词汇（我不确定/可能已经/建议查询/无法确认/信息可能过时）
   *   2. 用户消息含时效性实体（最新/最近/新出的/版本号/新产品），但回复未调用任何工具
   *   3. 回复明确说"我无法获取实时/最新/联网信息"
   * 排除：回复很短（<10 字符，可能是寒暄）；用户消息也含 hedging（用户自己说的）
   */
  private needsExternalInfoUpgrade(replyText: string, userText: string): boolean {
    const reply = replyText.trim();
    const user = userText.trim();
    // 太短的回复（寒暄/确认）不升级
    if (reply.length < 10) return false;

    // hedging 信号：LLM 自己暴露"不确定/过时/建议查"
    const hedgingSignals = [
      "我不确定", "无法确认", "信息可能过时", "可能已经更新", "可能已经变化",
      "建议查询", "建议查看", "建议搜索", "建议你查", "可以搜索", "可以查询",
      "我无法获取", "我无法联网", "我无法访问", "没有联网", "无法获取最新",
      "截至我所知", "截至我的知识", "我的知识截止", "知识库可能没有",
      "可能不准确", "可能不完整", "可能已过时", "建议核实",
    ];
    if (hedgingSignals.some((s) => reply.includes(s))) return true;

    // 用户消息含时效性实体 + 回复未调工具（result.toolName 为空才走到这）→ 升级
    const timeSensitivitySignals = [
      "最新", "最近", "新出的", "新出", "刚出", "刚发布", "今年", "去年",
      "上周", "本周", "这周", "这个月", "上个月", "今天", "昨天", "明天",
      "现在", "目前", "当前",
    ];
    const versionSignals = [
      "kimi3", "gpt-5", "gpt5", "claude-4", "claude4", "iphone 17", "iphone17",
      "macbook m5", "m5", "新版", "最新款", "旗舰款", "2024", "2025", "2026",
    ];
    const userHasTimeSignal = timeSensitivitySignals.some((s) => user.includes(s));
    const userHasVersionSignal = versionSignals.some((s) =>
      user.toLowerCase().includes(s.toLowerCase()),
    );
    if (userHasTimeSignal || userHasVersionSignal) {
      // 排除明显闲聊（"今天天气真好" / "现在几点" 由简单工具处理，不升级）
      const simpleChatPatterns = ["几点", "天气怎么样", "天气如何", "今日天气"];
      if (simpleChatPatterns.some((p) => user.includes(p))) return false;
      return true;
    }

    return false;
  }

  /**
   * Fast 主答后，把 complex 后台搜集到的结果无缝衔接进对话（Fast 主答 + Complex 后台 架构）。
   *
   * 关键约束：
   *  - complex 的原文不直接推给前端；先做句级去重，剔除与 fast 已说内容重复的句子
   *    （这是"整段一模一样出现两次"的根源消除点，确定性保证，不依赖 LLM）；
   *  - 由 fast 用口语化方式把补充信息续接进对话，不机械报"后台研究结果"；
   *  - 流式过程中再按句做二次防线：与 fast 已说内容重复的句子直接丢弃。
   */
  private async synthesizeFastContinuation(
    actorId: string,
    userText: string,
    fastReply: string,
    complexResult: string,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    const provider = this.externalChat;
    const result = complexResult?.trim();
    if (!provider?.isEnabled() || !result) return "";

    // 1) 确定性强去重：剔除 complex 结果里与 fast 已说句子重复的部分。
    //    若全部重复（complex 只是重答了一遍）→ 无新增信息，保持 fast 回复原样。
    const freshPart = stripSentencesAlreadySaid(fastReply, result);
    if (!freshPart) return "";

    const prompt =
      `你在和用户聊天，刚才已经说了：\n"""${fastReply}"""\n\n` +
      `你现在通过后台补充检索/执行拿到了新信息：\n"""${freshPart}"""\n\n` +
      `把新信息自然、无缝地融进对话继续说下去：\n` +
      `- 不要重复你刚才已经说过的任何话，也不要把补充信息原样复读。\n` +
      `- 如果新信息更正了你刚才的说法，就自然地更正。\n` +
      `- 口语化，直接接着往下说，不要用"我查到了/根据搜索/后台研究"这类机械表述开头。\n` +
      `- 直接输出继续对话的正文，不要任何解释或前缀。`;

    const said = sentenceSet(fastReply);
    let pending = "";
    const forwarded: string[] = [];
    const forward = (text: string): void => {
      if (!text) return;
      forwarded.push(text);
      onAssistantDelta?.(text);
    };

    try {
      await provider.streamCompletion(
        `fast-continuation-${actorId}-${Date.now()}`,
        { text: prompt },
        (delta) => {
          // 2) 流式防线：按句检查，与 fast 已说内容重复的句子丢弃
          pending += delta;
          const parts = pending.split(/(?<=[。！？!?；;])/u);
          pending = parts.pop() ?? "";
          for (const s of parts) {
            const t = s.trim();
            if (!t) continue;
            if (!said.has(normalizeSentence(t))) forward(s);
          }
        },
        undefined,
        { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 3 },
      );
      // 收尾：剩余未完整句子非重复则补推
      if (pending.trim() && !said.has(normalizeSentence(pending.trim()))) {
        forward(pending);
      }
      const continuation = forwarded.join("").trim();
      if (continuation) return continuation;
      // 3) 合成输出被全部去重吞掉（说明无新增信息）→ 回退直推 freshPart（本身已去重）
      forward(freshPart);
      return freshPart;
    } catch (err) {
      // 合成失败 → 回退把已去重的 complex 内容直推给前端，仍保证不重复
      console.error("[AgentCore] fast 续接合成失败，回退已去重内容:", err);
      const buffered = forwarded.join("");
      if (buffered.trim()) return buffered.trim();
      forward(freshPart);
      return freshPart;
    }
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

  /**
   * Prompt 阶段的位置注入：优先用消息自带位置，否则读位置协调器缓存。
   * 不主动请求客户端（避免普通对话被 GPS 阻塞）——实时位置只在位置类工具执行时
   * 经 `requestLocation` 按需拉取一次。
   */
  private resolveUserLocationForPrompt(
    actorId: string,
    opts?: { clientIp?: string; clientLocation?: ClientLocationWire },
  ): Promise<string | undefined> {
    const location = opts?.clientLocation ?? this.locationCoordinator?.getCached(actorId) ?? undefined;
    return resolveUserLocationPrompt({
      clientIp: opts?.clientIp,
      clientLocation: location,
    });
  }

  /**
   * 构建最近对话回顾独立块（不再拼入 narrativeRecall）。
   *
   * 2026-08-11 修复 E（思路 A）：原 appendRecentConversationHistory 把 [最近对话] 块
   * 拼到 narrativeRecall 末尾，下游 formatNarrativeRecallPrompt 的 slice(0,4) 会把它
   * 当作召回条目丢弃、hint 被正则误杀、多行块结构被拍平 → agent 上下文跳转。
   * 现改为返回独立字符串，由 PromptContextBuilder 作为独立字段透传，
   * buildLayeredSystemPrompt 作为【最近对话回顾】独立块注入，绕过 formatNarrativeRecallPrompt。
   *
   * 保留原 C1 dedup 判定：thread messages >= 12 条时返回 undefined（与消息数组重复）。
   * "非用户最新指令"提示（原 C2 hint）由 buildLayeredSystemPrompt 统一添加，此处不再拼接。
   */
  private buildRecentConversationHistoryBlock(
    recentConversationHistory: string,
    threadMessageCount: number = -1,
    actorId?: string,
    userText?: string,
  ): string | undefined {
    if (!recentConversationHistory) return undefined;
    const ambiguousFollowUp = Boolean(userText && isAmbiguousFollowUpMessage(userText));

    // C1: thread messages 里已有 ≥12 条（≈6 轮 user/assistant 配对）时，LLM 已能从 msgs
    // 看到全部最近对话，再注入【最近对话回顾】块属于完全重复。
    // 仅当 thread 较短（首次对话、新会话、长 context 被 trim 掉）时才返回。
    if (threadMessageCount >= 12 && !ambiguousFollowUp) {
      return undefined;
    }

    let block = recentConversationHistory;

    // 跨会话开放环路（记忆连续性 Phase 2）：新会话开场（thread 较短）时，
    // 并入上一会话未完成的待办与承诺，让连续性跨会话延续（解决"换会话跳转"）。
    if (actorId && this.brainCenter?.getSessionEpitome) {
      try {
        const epitome = this.brainCenter.getSessionEpitome(actorId);
        if (epitome) {
          const lines: string[] = [
            ...epitome.openLoops.slice(0, 3).map((l) => `待办: ${l}`),
            ...epitome.commitments.slice(0, 2).map((l) => `承诺: ${l}`),
          ];
          if (lines.length > 0) {
            block += `\n\n【上一会话待办】\n（跨会话延续：以下来自上一会话的未完成事项，非本轮新指令；如已完成请忽略）\n${lines.join("\n")}`;
          }
        }
      } catch {
        /* epitome 读取失败静默降级 */
      }
    }

    return block;
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
      personalization,
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
    };
  }

  /**
   * 后台执行复杂任务（子 Agent 委派 / plan_execute），返回最终结果文本。
   *
   * 异步并行：fast 通过 StreamSegmenter 统一产出垫词 + 信息块分段先回复，
   * complex 在多线程中执行，完成后通过 Promise 返回最终结果文本。
   * 流式结果通过 opts.onAssistantDelta 实时回传，最终结果由 caller await。
   */
  private launchComplexBackgroundTask(
    actorId: string,
    text: string,
    opts: HandleUserMessageOptions | undefined,
    ctx: {
      narrativeRecall?: string;
      workingMemorySummary?: string;
      recentConversationHistory?: string;
      userLocation?: string;
      trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
      orchestrateOpts: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn: ShortTermTurnContext;
      cognitiveMetacog?: import("../brain/meta-cognition-cortex.js").MetacogAssessment;
      cognitiveEmotion?: import("../brain/types.js").EmotionVector | null;
      cognitiveUserPattern?: {
        topics: string[];
        preferredToolDomain?: string;
        negativeFeedbackCount: number;
        learningActive?: boolean;
      };
      cognitiveToolPlan?: import("../brain/tool-planning-cortex.js").ToolPlan;
    },
  ): Promise<string> {
    const useSubAgent = this.masterAgentCoordinator !== null;
    const registry = this.wsRegistry;
    const onDelta = opts?.onAssistantDelta;
    // 后台执行不继承外层 signal（turn 已返回占位，避免用户发新消息时中断后台任务）
    const bgOpts: HandleUserMessageOptions | undefined = opts
      ? { ...opts, signal: undefined }
      : opts;

    // 返回 Promise，在 complex 任务完成时 resolve 最终结果文本
    return new Promise<string>((resolve, reject) => {
      const run = async (_taskId: string): Promise<void> => {
        try {
          if (useSubAgent && this.masterAgentCoordinator) {
            // 子 Agent 委派：后台执行 Master Agent，结果通过 onAssistantDelta 流式回传
            const masterResult = await this.masterAgentCoordinator.orchestrateTask(
              actorId,
              text,
              opts?.onAgentPhaseStatus,
              onDelta,
              ctx.orchestrateOpts,
            );
            await this.finishLlmTurn(actorId, text, masterResult, {
              streamedChunks: true,
              modelCallsConsumed: 1,
              planExecuteUsed: false,
              pePlan: null,
              peExhausted: false,
              trajCap: ctx.trajCap,
              messageId: opts?.chatUserMessageId,
              sessionId: ctx.sessionId,
            }, onDelta);
            resolve(masterResult);
          } else {
            // plan_execute：执行标准复杂路径
            const result = await this.runStandardLlmPath(actorId, text, "complex", bgOpts, {
              narrativeRecall: ctx.narrativeRecall,
              workingMemorySummary: ctx.workingMemorySummary,
              recentConversationHistory: ctx.recentConversationHistory,
              userLocation: ctx.userLocation,
              trajCap: ctx.trajCap,
              orchestrateToolCtx: ctx.orchestrateOpts,
              personalization: ctx.personalization,
              sessionId: ctx.sessionId,
              shortTermTurn: ctx.shortTermTurn,
              cognitiveMetacog: ctx.cognitiveMetacog,
              cognitiveEmotion: ctx.cognitiveEmotion,
              cognitiveUserPattern: ctx.cognitiveUserPattern,
              cognitiveToolPlan: ctx.cognitiveToolPlan,
            });
            resolve(result.text ?? "");
          }
        } catch (err) {
          reject(err);
        }
      };

      const runOpts: import("./agent-task-orchestrator.js").RunTaskOptions = {
        onProgress: (event) => {
          if (!registry) return;
          try {
            registry.trySend(
              event.sessionId,
              JSON.stringify({
                type: ServerEventType.ChatExecutionEvent,
                payload: { kind: "task_progress", ...event },
              }),
            );
          } catch {
            // 静默失败
          }
          // 后台任务失败时推送 fallback 文案
          if (event.type === "task_failed") {
            try {
              onDelta?.(FALLBACK_TEXT_BACKGROUND_FAILED());
              resolve(""); // 任务失败时仍 resolve 空串，避免 caller 一直等待
            } catch {
              /* ignore */
            }
          }
        },
        onAssistantDelta: (delta) => {
          onDelta?.(delta);
        },
        onToolExecuteStart: (info) => {
          opts?.onExternalToolExecuteStart?.({
            toolName: info.name,
            input: info.args,
          });
        },
        onToolExecuted: (info) => {
          opts?.onExternalToolExecuted?.({
            toolName: info.name,
            input: {},
            ok: info.ok,
            result: (info.result as Record<string, unknown>) ?? {},
          });
        },
      };

      // 启动复杂任务（多线程包装）
      void this.runComplexTaskInWorker(actorId, text, run, runOpts)
        .then(() => {
          // worker 已完成，run 内部的 resolve/reject 已处理
        })
        .catch((err) => {
          console.error("[AgentCore] 复杂任务 worker 异常:", err);
          if (!reject) {} // 标记使用，防止 lint
          reject(err);
        });
    });
  }

  /**
   * 在多线程 Worker 中执行复杂任务。
   * 使用 node:worker_threads 将 LLM 密集调用隔离到独立线程，
   * 主线程可继续处理 fast 模式的渐进式垫词。
   *
   * 当前实现：async/await 主线程并发执行（非阻塞 event loop），
   * 可通过配置 useWorker 切换为真实 worker_threads 隔离。
   */
  private async runComplexTaskInWorker(
    _actorId: string,
    _text: string,
    run: (taskId: string) => Promise<void>,
    _runOpts: import("./agent-task-orchestrator.js").RunTaskOptions,
  ): Promise<void> {
    const taskId = `complex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 使用 worker_threads 隔离 LLM 密集调用
    // 当前通过 async/await 在主线程并发执行，保持事件循环响应
    const useWorker = false; // 暂设为 false，用 async/await 并发
    if (useWorker) {
      const { Worker } = await import("node:worker_threads");
      const workerPath = new URL("./complex-worker.js", import.meta.url).href;
      const worker = new Worker(workerPath, {
        workerData: { actorId: _actorId, text: _text, taskId },
        execArgv: ["--import", "data:text/javascript,import { register } from 'node:module'; globalThis.__WORKER_IMPORT_META_URL__ = " + JSON.stringify(import.meta.url)],
      });
      try {
        await run(taskId);
      } finally {
        await worker.terminate().catch(() => {});
      }
    } else {
      // 主线程并发执行（event loop 非阻塞，progressive 垫词仍可推送）
      await run(taskId);
    }
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
      userLocation?: string;
      trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
      orchestrateToolCtx: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn: ShortTermTurnContext;
      /**
       * r5: cognize 阶段已评估的元认知 + 情绪，由本函数格式化为方向化短字符串
       * 注入 promptContext.memory.metaCognition / emotionState。
       * 缺失（无 BrainCenter / cognize 未跑）时跳过注入。
       */
      cognitiveMetacog?: import("../brain/meta-cognition-cortex.js").MetacogAssessment;
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
      /** 语义意图理解结果（入口层 LLM 解析），注入 prompt 让主 LLM 明确用户真实意图 */
      semanticIntent?: SemanticIntent;
    },
  ): Promise<AgentReply> {
    const provider = this.externalChat!;
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
          agentAccessMode: ctx.orchestrateToolCtx.agentAccessMode,
          desktopBridgeOnline: ctx.orchestrateToolCtx.desktopBridgeOnline,
          phoneBridgeOnline: ctx.orchestrateToolCtx.phoneBridgeOnline,
// 按需位置：位置类工具（weather.get_local 等）在缺少经纬度时可向客户端请求实时 GPS。
          requestLocation: () =>
            this.locationCoordinator?.requestLocation(actorId, `tool:${name}`) ??
            Promise.resolve(null),
        },
      },
      {
        onToolExecuteStart: (info) => opts?.onExternalToolExecuteStart?.(info),
        onAgentStatusLine: opts?.onAgentPhaseStatus,
        onToolExecuted: ctx.orchestrateToolCtx.onToolExecuted,
      },
    );

    const onBatchWithEvolution = ctx.orchestrateToolCtx.onToolLoopAfterBatch;
    const toolExposureProfile = this.toolPolicyResolver.resolveExposureProfile(mode);
    const toolRankingHint = this.toolPolicyResolver.resolveRankingHint(actorId);
    // 2026-07-29 修复 D2：fast_chat 也走 promptContextBuilder.build，把 narrativeRecall 注入 promptContext.memory，
    // 让 LLM 能看到长期记忆 + 工作记忆 + [最近对话] recap。
    // 2026-07-30 重构：Fast 模式作为表达层 + 轻量工具通道（clock/weather/calendar.list 只读工具）。
    // Complex 模式负责重活（多步/写操作/子 Agent 委派），结果回传后由 Fast 统一输出。
    const baseStreamOpts = this.isFastMode(mode)
      ? ({
          ...(this.promptContextBuilder.build({
            actorId,
            sessionId: ctx.sessionId,
            userText: text,
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            interruptedContext: opts?.interruptedContext,
            // 2026-08-19 修复「天气/位置在 fast 模式失效」：fast 分支此前强制
            // userLocation=undefined。天气工具（weather.get_local）已并入
            // tool-router 延迟目录由检索召回（tool_discover → tool_call），
            // 召回执行时同样需要位置；LLM 拿不到位置只能传空参数 → 天气查询失败。
            // 改为复用已获取到的位置（ctx.userLocation），让 LLM 用默认/已有位置直接查，
            // 而非反问用户或空跑工具。没有位置时值仍为 undefined（保持原行为）。
            userLocation: ctx.userLocation,
            personalization: ctx.personalization,
            onToolLoopAfterBatch: undefined, // fast_chat 无工具循环
            userPattern: ctx.cognitiveUserPattern,
            toolPlan: ctx.cognitiveToolPlan,
            semanticIntent: this.formatSemanticIntent(ctx.semanticIntent),
          }) ?? {}),
          chatToolsBuiltin: getFastLaneTools(),
          chatToolsExtra: [],
          toolExposureProfile,
          toolRankingHint,
        } satisfies AgentStreamOptions)
      : {
          ...(this.promptContextBuilder.build({
            actorId,
            sessionId: ctx.sessionId,
            userText: text,
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            interruptedContext: opts?.interruptedContext,
            userLocation: ctx.userLocation,
            personalization: ctx.personalization,
            onToolLoopAfterBatch: onBatchWithEvolution,
            userPattern: ctx.cognitiveUserPattern,
            toolPlan: ctx.cognitiveToolPlan,
          }) ?? {}),
          toolExposureProfile,
          toolRankingHint,
        };
    // FastVerdict 输出规范：仅 fast 模式 + 特性开启时注入。
    // 要求 fast 在回复末尾附一行隐藏结构化块 `<<<verdict:{json}>>>`，
    // 供服务端流式解析取出与剥离（判定难度 + 产出给 complex 的封闭任务规范），不展示给用户。
    const verdictEnabledInLane = process.env.FAST_VERDICT_ENABLED === "1";
    if (verdictEnabledInLane && this.isFastMode(mode)) {
      const mem = ((baseStreamOpts.promptContext ??= {}).memory ??= {});
      if (!mem.fastVerdictInstruction) mem.fastVerdictInstruction = FAST_VERDICT_PROMPT_INSTRUCTION;
    }
    const runtimeKernel = getRuntimeKernel(actorId);
    // r5: 注入元认知 + 情绪到 promptContext.memory（方向化短字符串，不堆 prompt）：
    // - metaCognition: 仅当置信度偏低(<0.7) 或建议反思时输出，给方向让模型自己调整语气/置信
    // - emotionState: 仅当情绪显著时输出（强负/强正/高唤醒），让模型基于情绪调语气
    // 高置信 + 中性情绪 → 跳过（避免噪声污染 prompt）
    const memoryBeforeSanitize = baseStreamOpts.promptContext?.memory;
    const cogMeta = ctx.cognitiveMetacog;
    const cogEmo = ctx.cognitiveEmotion;
    if (memoryBeforeSanitize && (cogMeta || cogEmo)) {
      if (cogMeta && (cogMeta.shouldReflect || cogMeta.confidence < 0.7)) {
        const markers = cogMeta.uncertaintyMarkers.slice(0, 2).join("、");
        const direction = cogMeta.shouldReflect
          ? "建议先反思再答"
          : "对不确定的点先说明";
        memoryBeforeSanitize.metaCognition =
          `置信度 ${cogMeta.confidence.toFixed(2)} — ${direction}${markers ? `（${markers}）` : ""}`;
      }
      if (cogEmo) {
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
    }
    const runtimePlan = runtimeKernel.planTurn(text, baseStreamOpts.promptContext?.memory);
    const sanitizedMemory = runtimeKernel.sanitizePromptMemory(
      baseStreamOpts.promptContext?.memory,
      runtimePlan,
    );
    const isMinimalMode = runtimeKernel.isMinimalMode();
    // 2026-08-02 模型路由：Fast mode → deepseek-chat（Flash），Complex mode → deepseek-reasoner（Pro）
    const tierForMode: Record<LlmExecutionMode, TaskTier> = {
      fast: TaskTier.FAST,
      complex: TaskTier.COMPLEX,
    };
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
      toolExposureProfile: runtimePlan.toolExposureProfile ?? baseStreamOpts.toolExposureProfile,
      pinnedToolNames: runtimePlan.enabled
        ? [...(baseStreamOpts.pinnedToolNames ?? []), ...runtimePlan.pinnedToolNames]
        : baseStreamOpts.pinnedToolNames,
      // 2026-08-01 性能优化：Fast 模式 maxRounds 限制为 1。
      // Fast 模式以对话为主，单次工具调用足够（LLM 可基于 system prompt 的 currentTime/userLocation
      // 直接答时间/位置/天气类问题）。Complex 模式交给 plan_execute / master_subagent 处理重活。
      ...(this.isFastMode(mode)
        ? {
            toolLoop: {
              ...(baseStreamOpts.toolLoop ?? {}),
              maxRounds: 1,
            },
          }
        : baseStreamOpts.toolLoop
          ? { toolLoop: baseStreamOpts.toolLoop }
          : {}),
      maxThreadMessages: runtimePlan.promptMode === "conversation_only"
        ? Number.parseInt(process.env.AGENT_RUNTIME_KERNEL_MAX_THREAD_MESSAGES ?? "12", 10)
        : baseStreamOpts.maxThreadMessages,
      // 透传中断信号:用户发新消息时 abort,provider 底层 fetch 真正中断 HTTP 流式
      ...(opts?.signal ? { signal: opts.signal } : {}),
      // 2026-08-02 模型路由：根据 Fast/Complex 模式选择对应模型
      // Fast → deepseek-chat（Flash），Complex → deepseek-reasoner（Pro）
      ...buildModelOverrideOpts(tierForMode[mode]),
    };

    let full = "";
    let modelCallsConsumed = 1;
    const peUsed = mode === "complex";
    let pePlan: TaskExecutionPlan | null = null;
    let peExhausted = false;

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

    if (peUsed) {
      const chatKey = opts?.chatUserMessageId ?? randomUUID();
      const peSessionId = planExecuteSessionId(actorId, chatKey);

      if (isLoopOrchestratorEnabled() && this.loopOrchestrator) {
        // P4：编排器接管 plan_execute（多工具协同路径），驱动 plan→execute→评估→replan 循环。
        // direct_llm / fast_chat 不进编排器（普通对话无需多轮控制流）。
        const orchResult = await this.loopOrchestrator.run(
          {
            taskId: `loop-${chatKey}`,
            actorId,
            sessionId: peSessionId,
            goal: text,
            initialMode: "complex",
          },
          {
            sessionId: peSessionId,
            userTurn,
            toolCtx,
            streamOpts,
            onDelta: (delta) => opts?.onAssistantDelta?.(delta),
          },
        );
        full = orchResult.finalText;
        modelCallsConsumed = Math.max(1, orchResult.modelCalls);
        pePlan = orchResult.ctx.plan;
        // 反思字段由编排器激活：exhaustedRetries 覆盖 replan 耗尽 / 预算耗尽两种终止。
        peExhausted = orchResult.exhaustedRetries;
      } else {
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
      }
      provider.clearSession?.(peSessionId);
      provider.appendThreadTurn?.(chatSessionId, userTurn, full);
    } else {
      const mergedStreamOpts: AgentStreamOptions | undefined =
        streamOpts || onBatchWithEvolution || opts || provider.id === "moonshot-kimi"
          ? {
              ...(streamOpts ?? {}),
              ...(onBatchWithEvolution ? { toolLoop: { onAfterToolBatch: onBatchWithEvolution } } : {}),
              agentAccessMode: ctx.orchestrateToolCtx.agentAccessMode,
              desktopBridgeOnline: ctx.orchestrateToolCtx.desktopBridgeOnline,
              phoneBridgeOnline: ctx.orchestrateToolCtx.phoneBridgeOnline,
              ...(provider.id === "moonshot-kimi" ? { disableThinking: true } : {}),
            }
          : undefined;

      full = await provider.streamCompletion(
        chatSessionId,
        userTurn,
        (delta) => opts?.onAssistantDelta?.(delta),
        toolCtx,
        mergedStreamOpts,
      );
    }

    return await this.turnFinalizer.finish(actorId, text, full, {
      streamedChunks: true,
      modelCallsConsumed,
      planExecuteUsed: peUsed,
      pePlan,
      peExhausted,
      trajCap: ctx.trajCap,
      messageId: opts?.chatUserMessageId,
      sessionId: opts?.sessionId,
    }, opts?.onAssistantDelta);
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
    }

    return {
      text: quotaSuffix ? `${trimmed}\n\n${quotaSuffix}` : trimmed,
      streamedChunks: meta.streamedChunks,
    };
  }
}
