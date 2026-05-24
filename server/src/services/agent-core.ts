import { randomUUID } from "node:crypto";

import type { WorldService } from "@private-ai-agent/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
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
import type { AgentAccessMode } from "../agent/agent-access-mode.js";
import { TurnLifecycle } from "../agent/turn-lifecycle.js";
import { MasterAgentCoordinator } from "./master-agent-coordinator.js";
import type { PerformanceMetrics, SubAgentPerformanceMetrics } from "./master-agent-coordinator.js";

export type MasterAgentDelegationSnapshot = {
  enabled: boolean;
  metrics: PerformanceMetrics | null;
  subAgentMetrics: Record<string, SubAgentPerformanceMetrics> | null;
  history: Array<unknown>;
  suggestions: string[];
  config: {
    taskTimeoutMs: number;
    techSubtaskTimeoutMs: number;
    maxSubAgentInvocationsPerTurn: number;
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
};

export class AgentCore {
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly masterAgentCoordinator: MasterAgentCoordinator | null = null;

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
  ) {
    this.promptContextBuilder = new PromptContextBuilder({
      agentMemorySyncService: this.agentMemorySyncService,
      worldService: this.worldService,
      skillManager: this.skillManager,
      virtualPhoneService: this.virtualPhoneService,
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
          maxParallelTasks: 1,
          taskTimeoutMs: cfg.subtaskTimeoutMs,
          techSubtaskTimeoutMs: cfg.techSubtaskTimeoutMs,
          allowFallback: true,
        },
      );
    }
  }

  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    if (!this.externalChat?.isEnabled()) {
      const available = this.toolRegistry.list().join(", ");
      const fallback = `已收到：${text}。当前可用工具：${available}`;
      this.turnLifecycle.finalizeTurn({ actorId, userText: text, assistantText: fallback });
      return { text: fallback };
    }

    const [narrativeRecall, userLocation, personalization] = await Promise.all([
      this.turnLifecycle.prepareNarrativeRecall(actorId, text),
      resolveUserLocationPrompt({
        clientIp: opts?.clientIp,
        clientLocation: opts?.clientLocation,
      }),
      this.userPersonalizationService?.getPromptSlice(actorId, text) ?? Promise.resolve({}),
    ]);
    const trajCap = this.trajectorySkillPromotion?.beginCapture(
      actorId,
      opts?.chatUserMessageId,
      text,
    );
    const route = routeLlmExecution(text);
    const orchestrateOpts = this.buildOrchestrateOpts(
      actorId,
      text,
      opts,
      narrativeRecall,
      personalization,
      trajCap,
    );

    try {
      if (this.isMasterMode(route.mode) && this.masterAgentCoordinator) {
        const result = await this.masterAgentCoordinator.orchestrateTask(
          actorId,
          text,
          opts?.onAgentPhaseStatus,
          opts?.onAssistantDelta,
          orchestrateOpts,
        );
        return this.finishLlmTurn(actorId, text, result, {
          streamedChunks: true,
          modelCallsConsumed: 1,
          planExecuteUsed: false,
          pePlan: null,
          peExhausted: false,
          trajCap,
          messageId: opts?.chatUserMessageId,
        });
      }

      return await this.runStandardLlmPath(actorId, text, route.mode, opts, {
        narrativeRecall,
        userLocation,
        personalization,
        trajCap,
        orchestrateToolCtx: orchestrateOpts,
      });
    } catch (err) {
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
        maxSubAgentInvocationsPerTurn: cfg.maxSubAgentInvocationsPerTurn,
      },
    };
  }

  adjustMasterAgentConcurrency(_newMaxParallel: number): void {
    this.masterAgentCoordinator?.adjustConcurrency(_newMaxParallel);
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
    });
  }

  private isMasterMode(mode: LlmExecutionMode): boolean {
    return mode === "master_only" || mode === "master_delegate";
  }

  private buildOrchestrateOpts(
    actorId: string,
    userText: string,
    opts: HandleUserMessageOptions | undefined,
    narrativeRecall: string | undefined,
    personalization: PersonalizationPromptSlice,
    trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined,
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
      agentAccessMode: opts?.agentAccessMode,
      visionFrames: opts?.visionFrames,
      interruptedContext: opts?.interruptedContext,
      narrativeRecall,
      personalization,
      onToolExecuteStart: opts?.onExternalToolExecuteStart,
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
          agentAccessMode: opts?.agentAccessMode,
        }),
      onToolExecuteStart: (info) => opts?.onExternalToolExecuteStart?.(info),
      onToolExecuted: ctx.orchestrateToolCtx.onToolExecuted,
    };

    const onBatchWithEvolution = ctx.orchestrateToolCtx.onToolLoopAfterBatch;
    const streamOpts = this.promptContextBuilder.build({
      actorId,
      userText: text,
      narrativeRecall: ctx.narrativeRecall,
      interruptedContext: opts?.interruptedContext,
      userLocation: ctx.userLocation,
      personalization: ctx.personalization,
      onToolLoopAfterBatch: onBatchWithEvolution,
    });

    let full = "";
    let modelCallsConsumed = 1;
    const peUsed = mode === "plan_execute";
    let pePlan: TaskExecutionPlan | null = null;
    let peExhausted = false;

    const userTurn: ChatUserTurn = {
      text,
      ...(opts?.visionFrames?.length ? { visionFrames: opts.visionFrames } : {}),
    };

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
      provider.appendThreadTurn?.(actorId, userTurn, full);
    } else {
      const mergedStreamOpts: AgentStreamOptions | undefined =
        streamOpts || onBatchWithEvolution || opts?.agentAccessMode
          ? {
              ...(streamOpts ?? {}),
              ...(onBatchWithEvolution ? { toolLoop: { onAfterToolBatch: onBatchWithEvolution } } : {}),
              ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
            }
          : undefined;

      full = await provider.streamCompletion(
        actorId,
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
