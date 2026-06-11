import { randomUUID } from "node:crypto";

import type { WorldService } from "@private-ai-agent/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DesktopBridgeCoordinator } from "./desktop-bridge-coordinator.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type { AgentReply } from "../agent/types.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { SkillManager } from "../skills/index.js";
import type { HermesEvolutionLoopService } from "./hermes-evolution-loop-service.js";
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
import { resolveUserLocationPrompt } from "../services/user-location-service.js";
import type { ClientLocationWire } from "../types/client-location.js";
import { isMasterAgentDelegationEnabled } from "../agent/master-agent-delegate-env.js";
import { routeLlmExecution, type LlmExecutionMode } from "../agent/task-router.js";
import { isAmbiguousFollowUpMessage } from "../agent/memory-signal.js";
import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import { TurnLifecycle } from "../agent/turn-lifecycle.js";
import { masterChatSessionId, resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { MasterAgentCoordinator } from "./master-agent-coordinator.js";
import type { PerformanceMetrics, SubAgentPerformanceMetrics } from "./master-agent-coordinator.js";
import { buildToolRankingHintFromHermesProfile } from "./hermes-tool-ranking.js";

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
  interruptedContext?: string;
  /** 默认沙箱；`full` 时允许高权限工具 */
  agentAccessMode?: AgentAccessMode;
  /** 为 true 时禁用 fast_chat 捷径（工具/记忆/人设与 App 对齐） */
  preferFullPipeline?: boolean;
};

export class AgentCore {
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly masterAgentCoordinator: MasterAgentCoordinator | null = null;
  private desktopBridgeCoordinator: DesktopBridgeCoordinator | null = null;

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
  ) {
    this.promptContextBuilder = new PromptContextBuilder({
      agentMemorySyncService: this.agentMemorySyncService,
      worldService: this.worldService,
      skillManager: this.skillManager,
      virtualPhoneService: this.virtualPhoneService,
      scheduleTaskService: this.scheduleTaskService,
    });
    this.turnLifecycle = new TurnLifecycle({
      narrativeMemory: this.narrativeMemory,
      computeQuotaService: this.computeQuotaService,
      hermesEvolutionLoopService: this.hermesEvolutionLoopService,
      userPersonalizationService: this.userPersonalizationService,
      agentMemorySyncService: this.agentMemorySyncService,
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
        },
      );
    }
  }

  /** 在 bootstrap 注册桌面桥接后注入，用于按轮检测电脑是否在线。 */
  setDesktopBridgeCoordinator(coordinator: DesktopBridgeCoordinator): void {
    this.desktopBridgeCoordinator = coordinator;
  }

  private desktopBridgeOnlineFor(actorId: string): boolean {
    return this.desktopBridgeCoordinator?.hasExecutor(actorId) ?? false;
  }

  private streamAccessFields(
    actorId: string,
    opts?: HandleUserMessageOptions,
  ): { agentAccessMode: AgentAccessMode; desktopBridgeOnline: boolean } {
    return {
      agentAccessMode: parseAgentAccessMode(opts?.agentAccessMode),
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
    };
  }

  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    const perfStartTime = Date.now();
    const route = routeLlmExecution(text, getAgentRuntimeConfig(), {
      preferFullPipeline: opts?.preferFullPipeline === true,
    });
    
    // 响应缓存检查（性能优化：重复查询 <100ms）
    const cacheEnabled = process.env.RESPONSE_CACHE_ENABLED !== '0';
    if (cacheEnabled && !opts?.visionFrames?.length && !isAmbiguousFollowUpMessage(text)) {
      const cachedResponse = globalResponseCache.get(text, actorId);
      if (cachedResponse) {
        this.turnLifecycle.finalizeTurn({ 
          actorId, 
          userText: text, 
          assistantText: cachedResponse 
        });
        
        return { text: cachedResponse, streamedChunks: false };
      }
    }
    
    if (!this.externalChat?.isEnabled()) {
      const available = this.toolRegistry.list().join(", ");
      const fallback = `已收到：${text}。当前可用工具：${available}`;
      this.turnLifecycle.finalizeTurn({ actorId, userText: text, assistantText: fallback });
      return { text: fallback };
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
          this.turnLifecycle.prepareNarrativeRecall(actorId, text),
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
    );

    try {
      let result: AgentReply;
      
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

  async runToolIfNeeded(
    actorId: string,
    reply: AgentReply,
    opts?: {
      chatUserMessageId?: string;
      userId?: string;
      clientIp?: string;
      clientLocation?: ClientLocationWire;
      agentAccessMode?: AgentAccessMode;
    },
  ): Promise<{ ok: boolean; result?: Record<string, unknown> }> {
    if (!reply.toolName || !reply.toolInput) return { ok: true };
    return this.toolRegistry.execute(reply.toolName, reply.toolInput, {
      sessionId: actorId,
      userId: opts?.userId,
      chatUserMessageId: opts?.chatUserMessageId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: opts?.agentAccessMode,
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
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

  private buildOrchestrateOpts(
    actorId: string,
    userText: string,
    opts: HandleUserMessageOptions | undefined,
    narrativeRecall: string | undefined,
    personalization: PersonalizationPromptSlice,
    trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined,
    access: { agentAccessMode: AgentAccessMode; desktopBridgeOnline: boolean },
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
      userId: opts?.userId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: access.agentAccessMode,
      desktopBridgeOnline: access.desktopBridgeOnline,
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
    },
  ): Promise<AgentReply> {
    const provider = this.externalChat!;
    const toolCtx: ChatToolExecutionContext = {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: opts?.userId,
          chatUserMessageId: opts?.chatUserMessageId,
          clientIp: opts?.clientIp,
          clientLocation: opts?.clientLocation,
          agentAccessMode: ctx.orchestrateToolCtx.agentAccessMode,
          desktopBridgeOnline: ctx.orchestrateToolCtx.desktopBridgeOnline,
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
      const result = await runPlanExecuteLoop({
        provider,
        planSessionId: peSessionId,
        userText: text,
        visionFrames: opts?.visionFrames,
        onDelta: (delta) => opts?.onAssistantDelta?.(delta),
        onPhaseStatus: opts?.onAgentPhaseStatus,
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
        streamOpts || onBatchWithEvolution || opts || provider.id === "moonshot-kimi"
          ? {
              ...(streamOpts ?? {}),
              ...(onBatchWithEvolution ? { toolLoop: { onAfterToolBatch: onBatchWithEvolution } } : {}),
              agentAccessMode: ctx.orchestrateToolCtx.agentAccessMode,
              desktopBridgeOnline: ctx.orchestrateToolCtx.desktopBridgeOnline,
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
      modelCallsConsumed: meta.modelCallsConsumed,
      planExecuteUsed: meta.planExecuteUsed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
      messageId: meta.messageId,
    });

    return {
      text: quotaSuffix ? `${trimmed}\n\n${quotaSuffix}` : trimmed,
      streamedChunks: meta.streamedChunks,
    };
  }
}
