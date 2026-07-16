import { randomUUID } from "node:crypto";

import type { WorldService } from "@private-ai-agent/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DesktopBridgeCoordinator } from "./desktop-bridge-coordinator.js";
import type { PhoneBridgeCoordinator } from "./phone-bridge-coordinator.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type { AgentReply } from "../agent/types.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { SkillManager } from "../skills/index.js";
import type { HermesEvolutionLoopService } from "./hermes-evolution-loop-service.js";
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
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { TrajectorySkillPromotionService } from "./trajectory-skill-promotion-service.js";
import type { ShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { resolveUserLocationPrompt } from "../services/user-location-service.js";
import type { ClientLocationWire } from "../types/client-location.js";
import { isMasterAgentDelegationEnabled } from "../agent/master-agent-delegate-env.js";
import { routeLlmExecution, type LlmExecutionMode, type RouteDecision } from "../agent/task-router.js";
import { isAmbiguousFollowUpMessage } from "../agent/memory-signal.js";
import type { BrainCenter } from "../brain/index.js";
import type { EmotionVector, MemoryRecallItem } from "../brain/types.js";
import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import { TurnLifecycle } from "../agent/turn-lifecycle.js";
import { masterChatSessionId, resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { MasterAgentCoordinator } from "./master-agent-coordinator.js";
import type { PerformanceMetrics, SubAgentPerformanceMetrics } from "./master-agent-coordinator.js";
import { AgentTaskOrchestrator } from "./agent-task-orchestrator.js";
import type { AgentTaskOrchestratorDeps } from "./agent-task-orchestrator.js";
import { buildToolRankingHintFromHermesProfile } from "./hermes-tool-ranking.js";
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

/**
 * 简单 LRU 缓存实现（用于响应缓存）
 * 预期效果：重复查询 <100ms，大幅减少 API 调用
 */
class ResponseCache {
  private cache = new Map<string, { response: string; timestamp: number; hits: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 500, ttlMinutes = 5) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60 * 1000;
    
    // 定期清理过期缓存
    setInterval(() => this.cleanup(), ttlMinutes * 60 * 1000).unref();
  }

  /**
   * 生成缓存键（基于输入文本的标准化哈希）
   */
  private generateKey(text: string, actorId: string): string {
    const normalized = text.toLowerCase().trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '');
    
    // 简单哈希函数
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return `${actorId}:${hash}:${normalized.slice(0, 50)}`;
  }

  /**
   * 获取缓存的响应
   */
  get(text: string, actorId: string): string | null {
    const key = this.generateKey(text, actorId);
    const cached = this.cache.get(key);
    
    if (!cached) return null;
    
    // 检查是否过期
    if (Date.now() - cached.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    
    // 更新访问次数和移到最后（LRU）
    cached.hits++;
    this.cache.delete(key);
    this.cache.set(key, cached);
    
    return cached.response;
  }

  /**
   * 设置缓存响应
   */
  set(text: string, actorId: string, response: string): void {
    const key = this.generateKey(text, actorId);
    
    // 如果已存在，不覆盖
    if (this.cache.has(key)) return;
    
    // 如果超过最大容量，删除最旧的条目
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    
    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  /**
   * 清理过期条目
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of this.cache) {
      if (now - value.timestamp > this.ttlMs) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      // 静默清理过期缓存
    }
  }

  /** 获取缓存统计信息 */
  getStats() {
    let totalHits = 0;
    for (const [, value] of this.cache) {
      totalHits += value.hits;
    }
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      totalHits,
      hitRate: this.cache.size > 0 ? (totalHits / this.cache.size).toFixed(2) : '0.00',
    };
  }

  /** 清空所有缓存 */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
  }
}

// 全局响应缓存实例
const globalResponseCache = new ResponseCache(
  parseInt(process.env.RESPONSE_CACHE_MAX_SIZE ?? '500'),
  parseInt(process.env.RESPONSE_CACHE_TTL_MINUTES ?? '5')
);

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

export type HandleUserMessageOptions = {
  onAssistantDelta?: StreamDeltaHandler;
  onExternalToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onExternalToolExecuted?: (info: ToolExecutedInfo) => void;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
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
};

type ShortTermTurnContext = {
  recallQuery: string;
  activeTaskId?: string;
  resumedTask: boolean;
};

/** Loop Orchestrator 启用开关（P1：仅 direct_llm 路径接入，默认关闭）。 */
function isLoopOrchestratorEnabled(): boolean {
  const raw = process.env.AGENT_LOOP_ORCHESTRATOR?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false" || raw === "no") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

export class AgentCore {
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly masterAgentCoordinator: MasterAgentCoordinator | null = null;
  private readonly agentTaskOrchestrator: AgentTaskOrchestrator | null = null;
  private readonly loopOrchestrator: LoopOrchestrator | null = null;
  private desktopBridgeCoordinator: DesktopBridgeCoordinator | null = null;
  private phoneBridgeCoordinator: PhoneBridgeCoordinator | null = null;
  private moodInferenceService: MoodInferenceService | null = null;
  private wsRegistry: WsConnectionRegistry | null = null;
  private lifeSignalHubService: LifeSignalHubService | null = null;
  /** BrainCenter 引用：可用时走 cognize() 端到端认知入口替代认知层切片 */
  private brainCenter: BrainCenter | null = null;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly externalChat: ExternalChatProvider | null = null,
    private readonly computeQuotaService: ComputeQuotaService | null = null,
    private readonly agentMemorySyncService: AgentMemorySyncService | null = null,
    private readonly hermesEvolutionLoopService: HermesEvolutionLoopService | null = null,
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
      hermesEvolutionLoopService: this.hermesEvolutionLoopService,
      userPersonalizationService: this.userPersonalizationService,
      agentMemorySyncService: this.agentMemorySyncService,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
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

      // 初始化 Loop Orchestrator（P1：仅 direct_llm 路径接入，feature flag 控制）
      // strategies map 收敛三种 loop；StateMachine 为 P1 stub，state_machine 路径暂走原分支
      const loopStrategies = new Map<LlmExecutionMode, LoopStrategy>();
      loopStrategies.set("direct_llm", new ReactLoopStrategy(this.externalChat));
      loopStrategies.set("plan_execute", new PlanExecuteLoopStrategy(this.externalChat));
      loopStrategies.set("state_machine", new StateMachineStrategy());
      this.loopOrchestrator = new LoopOrchestrator(loopStrategies, {
        termination: new DefaultTerminationPolicy(),
        recovery: new DefaultRecoveryPolicy(),
        progress: new DefaultProgressTracker(this.externalChat),
        escalation: new DefaultEscalationPolicy(),
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

  /**
   * 注入 BrainCenter。可用时 handleUserMessage 走 cognize() 端到端认知入口，
   * 替代原切片式 moodInference + routeLlmExecution + buildShortTermTurnContext。
   * BRAIN_CENTER_ENABLED=0 时 brainCenter 为 null，降级到原切片路径。
   */
  setBrainCenter(brain: BrainCenter | null): void {
    this.brainCenter = brain;
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
      recallQuery: this.shortTermMemoryGateway.buildRecallQuery(sessionId, text),
      activeTaskId: sync.task.taskId,
      resumedTask: sync.resumed,
    };
  }

  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    const sessionId = opts?.sessionId ?? actorId;

    // 用户开口即打断小脑：清空该 actor 的 defer 队列 + 设 60s 抑制窗口，
    // 让"用户开口时 Agent 不抢话"从注释变成可执行逻辑。
    // 小脑未注册时（BRAIN_NEURO_ENABLED=0）interruptProactive 为空操作。
    this.brainCenter?.interruptProactive(actorId);

    // === 端到端认知入口（替代原切片式 moodInference + routeLlmExecution + buildShortTermTurnContext）===
    // BrainCenter 可用时走 cognize()：一次 LLM 完成路由+情绪+记忆召回+初步响应
    // BrainCenter 不可用时（BRAIN_CENTER_ENABLED=0）降级到原切片路径
    let route: RouteDecision;
    let shortTermTurn: ShortTermTurnContext;
    /** cognize 产出的初步响应：needsToolLoop=false 时可直接作为最终响应 */
    let cognitiveResponse = "";
    /** cognize 是否需要工具循环：false 时可跳过 streamCompletion */
    let cognitiveNeedsToolLoop = true;
    /** cognize 阶段 1 已召回的记忆条目；非空时 standard path 复用，避免重复 MemoryCortex.recall */
    let cognitiveRecallItems: MemoryRecallItem[] | undefined;

    if (this.brainCenter && text?.trim()) {
      // 端到端认知：感知并行收集 → 一次认知 LLM → 后置安全/记忆
      const cognitive = await this.brainCenter.cognize({ actorId, text, sessionId });
      route = {
        mode: cognitive.route.mode as LlmExecutionMode,
        reasons: [cognitive.route.rationale],
      };
      shortTermTurn = { recallQuery: text, resumedTask: false };
      cognitiveResponse = cognitive.response;
      cognitiveNeedsToolLoop = cognitive.needsToolLoop;
      cognitiveRecallItems = cognitive.recallItems;

      // 推送 MoodInferred 事件（替代原 moodInference 切片，cognize 阶段1 已并行调 limbic.inferEmotion）
      if (cognitive.emotion) {
        this.emitMoodInferred(sessionId, {
          sentimentScore: cognitive.emotion.valence,
          confidence: cognitive.emotion.confidence ?? 0.5,
          emotionTags: [cognitive.emotion.label],
          agentNote: cognitive.emotion.label,
          timestamp: cognitive.emotion.detectedAt,
        });
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
      route = routeLlmExecution(text, getAgentRuntimeConfig(), {
        preferFullPipeline: opts?.preferFullPipeline === true,
      });
      shortTermTurn = route.mode === "fast_chat"
        ? { recallQuery: text, resumedTask: false }
        : this.buildShortTermTurnContext(sessionId, text);
    }

    const perfStartTime = Date.now();
    
    // 响应缓存检查（性能优化：重复查询 <100ms）
    const cacheEnabled = process.env.RESPONSE_CACHE_ENABLED !== '0';
    if (cacheEnabled && !opts?.visionFrames?.length && !isAmbiguousFollowUpMessage(text)) {
      const cachedResponse = globalResponseCache.get(text, actorId);
      if (cachedResponse) {
        this.turnLifecycle.finalizeTurn({
          actorId,
          userText: text,
          assistantText: cachedResponse,
          sessionId,
        });

        return { text: cachedResponse, streamedChunks: false };
      }
    }
    
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
    if (
      cognitiveResponse &&
      !cognitiveNeedsToolLoop &&
      (route.mode === "fast_chat" || route.mode === "direct_llm")
    ) {
      this.turnLifecycle.finalizeTurn({
        actorId,
        userText: text,
        assistantText: cognitiveResponse,
        sessionId,
      });
      // cognize response 写入缓存，下次同类查询 <100ms 命中
      if (cacheEnabled && !opts?.visionFrames?.length) {
        globalResponseCache.set(text, actorId, cognitiveResponse);
      }
      // 流式分片：cognize response 一次性返回，不分片
      opts?.onAssistantDelta?.(cognitiveResponse);
      return { text: cognitiveResponse, streamedChunks: false };
    }

    // 性能监控：前置准备阶段
    const prepStartTime = Date.now();
    
    const [narrativeRecall, userLocation, personalization] = this.isFastChatMode(route.mode)
      ? await Promise.all([
          Promise.resolve(undefined),
          Promise.resolve(undefined),
          Promise.resolve({} as PersonalizationPromptSlice),
        ])
      : await Promise.all([
          // 复用 cognize 阶段已召回的记忆条目，避免同一轮用户消息重复触发 MemoryCortex.recall
          // （cognize 未召回或降级路径未填充 recallItems 时，仍走原 prepareNarrativeRecall 逻辑）
          cognitiveRecallItems && cognitiveRecallItems.length > 0
            ? Promise.resolve(this.recallItemsToNarrative(cognitiveRecallItems))
            : this.turnLifecycle.prepareNarrativeRecall(actorId, shortTermTurn.recallQuery),
          resolveUserLocationPrompt({
            clientIp: opts?.clientIp,
            clientLocation: opts?.clientLocation,
          }),
          this.userPersonalizationService?.getPromptSlice(actorId, text) ?? Promise.resolve({}),
        ]);
    
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
      narrativeRecall,
      personalization,
      trajCap,
      access,
      sessionId,
      shortTermTurn,
    );

    try {
      let result: AgentReply;

      // 状态机模式:长任务(桌面自动化/多步骤委派)走外置任务队列+状态机编排
      if (route.mode === "state_machine") {
        if (!this.agentTaskOrchestrator) {
          // orchestrator 不可用,降级到 master_only 走后续分支
          route = { mode: "master_only", reasons: [...route.reasons, "fallback_no_orchestrator"] };
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

      if (this.isMasterMode(route.mode) && this.masterAgentCoordinator) {
        // 性能监控：Master Agent 模式
        const masterStartTime = Date.now();
        
        const masterResult = await this.masterAgentCoordinator.orchestrateTask(
          actorId,
          text,
          opts?.onAgentPhaseStatus,
          opts?.onAssistantDelta,
          orchestrateOpts,
        );
        
        const masterDuration = Date.now() - masterStartTime;
        
        result = this.finishLlmTurn(actorId, text, masterResult, {
          streamedChunks: true,
          modelCallsConsumed: 1,
          planExecuteUsed: false,
          pePlan: null,
          peExhausted: false,
          trajCap,
          messageId: opts?.chatUserMessageId,
          sessionId,
        });
        
        // 记录 Master Agent 模式性能
        this.recordPerformanceMetrics('master_agent', {
          totalDuration: Date.now() - perfStartTime,
          preparationDuration: prepDuration,
          llmDuration: masterDuration,
          textLength: text.length,
          mode: route.mode,
          hasTools: !!result.toolName,
          success: true,
        });
        
      } else {
        // 性能监控：标准 LLM 模式
        const standardStartTime = Date.now();
        
        result = await this.runStandardLlmPath(actorId, text, route.mode, opts, {
          narrativeRecall,
          userLocation,
          personalization,
          trajCap,
          orchestrateToolCtx: orchestrateOpts,
          sessionId,
          shortTermTurn,
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
      }
      
      // 响应缓存存储（仅缓存无工具调用的简单响应）
      if (cacheEnabled && !result.toolName && result.text) {
        globalResponseCache.set(text, actorId, result.text);
      }
      
      return result;
      
    } catch (err) {
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
      
      if (this.isMasterMode(route.mode) && this.masterAgentCoordinator) {
        console.error("[AgentCore] Master Agent orchestration failed, falling back to standard mode:", err);
        return await this.runStandardLlmPath(actorId, text, "direct_llm", opts, {
          narrativeRecall,
          userLocation,
          personalization,
          trajCap,
          orchestrateToolCtx: orchestrateOpts,
          sessionId,
          shortTermTurn,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `${this.externalChat.displayLabel} 调用失败：${msg}` };
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
    return this.toolRegistry.execute(reply.toolName, reply.toolInput, {
      sessionId: opts?.sessionId ?? actorId,
      userId: opts?.userId,
      chatUserMessageId: opts?.chatUserMessageId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: opts?.agentAccessMode,
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
      phoneBridgeOnline: this.phoneBridgeOnlineFor(actorId),
    });
  }

  private isMasterMode(mode: LlmExecutionMode): boolean {
    return mode === "master_only" || mode === "master_delegate";
  }

  private isFastChatMode(mode: LlmExecutionMode): boolean {
    return mode === "fast_chat";
  }

  private resolveToolExposureProfile(mode: LlmExecutionMode): AgentStreamOptions["toolExposureProfile"] {
    if (mode === "fast_chat") return "none";
    if (mode === "master_delegate") return "delegate";
    if (mode === "plan_execute") return "contextual";
    return "contextual";
  }

  private resolveHermesToolRankingHint(actorId: string): AgentStreamOptions["toolRankingHint"] {
    const profile =
      this.agentMemorySyncService?.getSnapshot(actorId, ["hermes_profile"]).entries.hermes_profile;
    return buildToolRankingHintFromHermesProfile(profile);
  }

  /**
   * 把 cognize 阶段已召回的 MemoryRecallItem[] 拼接为 narrative recall 字符串。
   * 用于在 standard path 中复用 cognize 召回结果，替代 prepareNarrativeRecall。
   * 单条 content 已由 MemoryCortex.textToRecallItems 截断至 800 字符（Task 3），此处不再截断。
   * 返回 undefined 表示无可用内容（与 prepareNarrativeRecall 的空结果语义一致）。
   */
  private recallItemsToNarrative(items: MemoryRecallItem[]): string | undefined {
    const lines: string[] = [];
    for (const it of items) {
      const content = typeof it?.content === "string" ? it.content.trim() : "";
      if (content) lines.push(content);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
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
  ) {
    const onBatchFromCaller = opts?.onToolLoopAfterBatch;
    const onBatchWithEvolution =
      onBatchFromCaller || this.hermesEvolutionLoopService
        ? (info: ToolLoopAfterBatchInfo) => {
            onBatchFromCaller?.(info);
            this.hermesEvolutionLoopService?.onToolBatch(actorId, userText, info);
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
      toolRankingHint: this.resolveHermesToolRankingHint(actorId),
      visionFrames: opts?.visionFrames,
      interruptedContext: opts?.interruptedContext,
      narrativeRecall,
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
      },
      onToolLoopAfterBatch: onBatchWithEvolution,
    };
  }

  private async runStandardLlmPath(
    actorId: string,
    text: string,
    mode: LlmExecutionMode,
    opts: HandleUserMessageOptions | undefined,
    ctx: {
      narrativeRecall?: string;
      userLocation?: string;
      trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
      orchestrateToolCtx: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn: ShortTermTurnContext;
    },
  ): Promise<AgentReply> {
    const provider = this.externalChat!;
    const toolCtx: ChatToolExecutionContext = {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, {
          sessionId: ctx.sessionId,
          userId: opts?.userId,
          chatUserMessageId: opts?.chatUserMessageId,
          clientIp: opts?.clientIp,
          clientLocation: opts?.clientLocation,
          agentAccessMode: ctx.orchestrateToolCtx.agentAccessMode,
          desktopBridgeOnline: ctx.orchestrateToolCtx.desktopBridgeOnline,
          phoneBridgeOnline: ctx.orchestrateToolCtx.phoneBridgeOnline,
        }),
      onToolExecuteStart: (info) => opts?.onExternalToolExecuteStart?.(info),
      onAgentStatusLine: opts?.onAgentPhaseStatus,
      onToolExecuted: ctx.orchestrateToolCtx.onToolExecuted,
    };

    const onBatchWithEvolution = ctx.orchestrateToolCtx.onToolLoopAfterBatch;
    const toolExposureProfile = this.resolveToolExposureProfile(mode);
    const toolRankingHint = this.resolveHermesToolRankingHint(actorId);
    const streamOpts = this.isFastChatMode(mode)
      ? ({
          chatToolsBuiltin: [],
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
            interruptedContext: opts?.interruptedContext,
            userLocation: ctx.userLocation,
            personalization: ctx.personalization,
            onToolLoopAfterBatch: onBatchWithEvolution,
          }) ?? {}),
          toolExposureProfile,
          toolRankingHint,
        };

    let full = "";
    let modelCallsConsumed = 1;
    const peUsed = mode === "plan_execute";
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
            initialMode: "plan_execute",
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
        peExhausted =
          orchResult.terminateReason === "replan_exhausted" ||
          orchResult.terminateReason === "budget_exhausted";
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

    return this.finishLlmTurn(actorId, text, full, {
      streamedChunks: true,
      modelCallsConsumed,
      planExecuteUsed: peUsed,
      pePlan,
      peExhausted,
      trajCap: ctx.trajCap,
      messageId: opts?.chatUserMessageId,
      sessionId: opts?.sessionId,
    });
  }

  private finishLlmTurn(
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
  ): AgentReply {
    const trimmed = assistantText.trim();
    if (!trimmed) {
      return {
        text: "抱歉，我暂时无法生成回复，请稍后重试或换一种问法。",
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
