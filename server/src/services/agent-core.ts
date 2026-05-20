import { randomUUID } from "node:crypto";

import type { WorldService } from "@private-ai-agent/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
import { tryMatchDemoKeywordRoute } from "../agent/demo-routes.js";
import { parsePeerIntent } from "../agent/peer-intent.js";
import { parseRegisterIntent } from "../agent/register-intent.js";
import type { AgentReply } from "../agent/types.js";
import {
  parsePromptMemoryKeysFromEnv,
  sliceMemoryEntriesToPromptContext,
} from "../agent/prompt-builder.js";
import {
  buildAgentCapabilityPromptSection,
  isAgentCapsPromptEnabled,
} from "../agent/agent-capabilities.js";
import type { SkillManager } from "../skills/index.js";
import type { HermesEvolutionLoopService } from "./hermes-evolution-loop-service.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
import {
  type TaskExecutionPlan,
  isPlanExecuteLoopEnabled,
  planExecuteSessionId,
  runPlanExecuteLoop,
} from "../agent/plan-execute-loop.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";
import type { NarrativeHybridRetrievalService } from "./narrative-hybrid-retrieval-service.js";
import type { TrajectorySkillPromotionService } from "./trajectory-skill-promotion-service.js";
import { MasterAgentCoordinator } from "./master-agent-coordinator.js";

export type { AgentReply } from "../agent/types.js";

export type HandleUserMessageOptions = {
  /** 外部模型流式增量（与具体厂商无关） */
  onAssistantDelta?: StreamDeltaHandler;
  /** 外部模型 function calling 每执行完一个工具时回调（用于 WebSocket tool.call / tool.result） */
  onExternalToolExecuted?: ChatToolExecutionContext["onToolExecuted"];
  /** 工具环单轮内全部 tool 执行完毕后（Hermes 式可观测 / 评估扩展点） */
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  /** 当前用户消息的 `messageId`（与 WS `chat.user_message` 一致），写入工具上下文供中继/AIP 关联 */
  chatUserMessageId?: string;
  /** 稳定用户 id（与 WS `session.init` / `chat.user_message` 对齐） */
  userId?: string;
  /** 本轮附带的视觉帧（已服务端校验），送入支持视觉的模型 */
  visionFrames?: VisionFrame[];
};

export class AgentCore {
  private readonly masterAgentCoordinator: MasterAgentCoordinator | null = null;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly externalChat: ExternalChatProvider | null = null,
    private readonly computeQuotaService: ComputeQuotaService | null = null,
    private readonly agentMemorySyncService: AgentMemorySyncService | null = null,
    private readonly hermesEvolutionLoopService: HermesEvolutionLoopService | null = null,
    private readonly worldService: WorldService | null = null,
    private readonly skillManager: SkillManager | null = null,
    private readonly narrativeHybrid: NarrativeHybridRetrievalService | null = null,
    private readonly trajectorySkillPromotion: TrajectorySkillPromotionService | null = null,
    private readonly virtualPhoneService: VirtualPhoneService | null = null,
  ) {
    // 如果启用了外部聊天提供商，则初始化主 Agent 协调器
    if (this.externalChat?.isEnabled()) {
      const enableMultiAgent = process.env.ENABLE_MULTI_AGENT_COORDINATION === "1" || 
                               process.env.ENABLE_MULTI_AGENT_COORDINATION === "true";
      
      if (enableMultiAgent) {
        this.masterAgentCoordinator = new MasterAgentCoordinator(
          this.externalChat,
          this.toolRegistry,
          this.worldService,
          this.skillManager,
          {
            enableSubAgents: true,
            maxParallelTasks: Number.parseInt(process.env.MAX_PARALLEL_SUBTASKS ?? "3", 10) || 3,
            taskTimeoutMs: Number.parseInt(process.env.SUBTASK_TIMEOUT_MS ?? "60000", 10) || 60000,
            allowFallback: true,
          },
        );
      }
    }
  }

  /**
   * @param actorId 解析后的用户主体 id（`userId` 优先于 `sessionId`，与 UAP/个人房一致）
   */
  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    const peer = parsePeerIntent(text);
    if (peer) {
      const toolInput: Record<string, unknown> = {
        targetSessionId: peer.targetSessionId,
        body: peer.body,
      };
      if (peer.subject) toolInput.subject = peer.subject;
      return {
        text: `正在向 Agent（session: ${peer.targetSessionId}）发送中继消息。`,
        toolName: "agent.send_to_peer",
        toolInput,
      };
    }

    const reg = parseRegisterIntent(text);
    if (reg) {
      return {
        text: `正在为当前会话创建 Agent 账号「${reg.displayName}」并完成自导初始化任务…`,
        toolName: "agent.register_account",
        toolInput: { displayName: reg.displayName },
      };
    }

    const demo = tryMatchDemoKeywordRoute(text);
    if (demo) return demo;

    // 如果启用了多 Agent 协调器，使用主 Agent 进行任务分发
    if (this.masterAgentCoordinator) {
      try {
        // 不使用进度回调，避免向用户显示处理过程
        // 直接传递 onAssistantDelta 实现流式输出
        const result = await this.masterAgentCoordinator.orchestrateTask(
          actorId,
          text,
          undefined, // 不传递 onProgress 回调
          opts?.onAssistantDelta, // 传递流式输出回调
        );
        
        return { text: result, streamedChunks: true };
      } catch (error) {
        console.error("[AgentCore] Master Agent orchestration failed, falling back to standard mode:", error);
        // 降级到标准模式
      }
    }

    if (this.externalChat?.isEnabled()) {
      const provider = this.externalChat;
      try {
        let narrativeRecall: string | undefined;
        if (this.narrativeHybrid) {
          const nr = await this.narrativeHybrid.buildNarrativeRecall(actorId, text);
          narrativeRecall = nr.trim() ? nr : undefined;
        }

        const trajCap = this.trajectorySkillPromotion?.beginCapture(
          actorId,
          opts?.chatUserMessageId,
          text,
        );

        const toolCtx: ChatToolExecutionContext = {
          executeTool: (name, args) =>
            this.toolRegistry.execute(name, args, {
              sessionId: actorId,
              userId: opts?.userId,
              chatUserMessageId: opts?.chatUserMessageId,
            }),
          onToolExecuted: (info) => {
            trajCap?.observeToolExecuted({
              toolName: info.toolName,
              ok: info.ok,
              result: info.result,
            });
            opts?.onExternalToolExecuted?.(info);
          },
        };
        const streamOpts = this.buildStreamOptions(actorId, opts, narrativeRecall);
        const onBatchFromCaller = opts?.onToolLoopAfterBatch;
        const onBatchWithEvolution =
          onBatchFromCaller || this.hermesEvolutionLoopService
            ? (info: ToolLoopAfterBatchInfo) => {
                onBatchFromCaller?.(info);
                this.hermesEvolutionLoopService?.onToolBatch(actorId, text, info);
              }
            : undefined;

        let full = "";
        let modelCallsConsumed = 1;
        const peUsed = isPlanExecuteLoopEnabled();
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
            onDelta: (delta) => {
              opts?.onAssistantDelta?.(delta);
            },
            toolCtx,
            baseStreamOpts: streamOpts,
            onToolBatchForExecute: onBatchWithEvolution,
          });
          full = result.finalText;
          modelCallsConsumed = Math.max(1, result.modelCalls);
          pePlan = result.plan;
          peExhausted = result.exhaustedRetries;
          provider.clearSession?.(peSessionId);
        } else {
          full = await provider.streamCompletion(
            actorId,
            userTurn,
            (delta) => {
              opts?.onAssistantDelta?.(delta);
            },
            toolCtx,
            {
              ...streamOpts,
              ...(onBatchWithEvolution ? { toolLoop: { onAfterToolBatch: onBatchWithEvolution } } : {}),
            },
          );
        }

        trajCap?.observePePlan(pePlan);
        trajCap?.observeSelfCheck(
          peUsed ?
            peExhausted ?
              "自检未通过或已达到最大重试"
            : "PE 自检通过或未触发重试阈值"
          : "单轮工具环路径",
          peUsed ? !peExhausted : undefined,
        );
        void trajCap
          ?.finalizeHermes(full, {
            planExecuteEnabled: peUsed,
            modelCallsApprox: modelCallsConsumed,
            pePlan,
            peExhaustedRetries: peExhausted,
          })
          .catch(() => {});

        if (this.narrativeHybrid) {
          void this.narrativeHybrid
            .ingest(
              actorId,
              `Turn archive | user: ${text.slice(0, 600)} | assistant: ${full.slice(0, 1800)}`,
              "turn_archive",
            )
            .catch(() => {});
        }

        this.hermesEvolutionLoopService?.onAssistantDone(actorId, text, full);
        const quotaUnitsRaw = process.env.COMPUTE_QUOTA_UNITS_PER_MODEL_CALL;
        const quotaUnits = quotaUnitsRaw ? Number.parseInt(quotaUnitsRaw, 10) : 0;
        if (this.computeQuotaService && Number.isFinite(quotaUnits) && quotaUnits > 0) {
          const totalConsume = quotaUnits * modelCallsConsumed;
          const adj = this.computeQuotaService.adjust(actorId, "consume", totalConsume);
          if (!adj.ok) {
            return {
              text: `${full}\n\n（提示：算力配额不足，本次按 ${modelCallsConsumed} 次模型调用未扣减共 ${totalConsume} 单位；请扩大 COMPUTE_QUOTA_DEFAULT_UNITS 或释放预留。）`,
              streamedChunks: true,
            };
          }
        }
        return { text: full, streamedChunks: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `${provider.displayLabel} 调用失败：${msg}` };
      }
    }

    const available = this.toolRegistry.list().join(", ");
    const fallback = `已收到：${text}。当前可用工具：${available}`;
    this.hermesEvolutionLoopService?.onAssistantDone(actorId, text, fallback);
    return { text: fallback };
  }

  async runToolIfNeeded(
    actorId: string,
    reply: AgentReply,
    opts?: { chatUserMessageId?: string; userId?: string },
  ): Promise<{ ok: boolean; result?: Record<string, unknown> }> {
    if (!reply.toolName || !reply.toolInput) return { ok: true };
    const result = await this.toolRegistry.execute(reply.toolName, reply.toolInput, {
      sessionId: actorId,
      userId: opts?.userId,
      chatUserMessageId: opts?.chatUserMessageId,
    });
    return result;
  }

  private buildStreamOptions(
    actorId: string,
    opts?: HandleUserMessageOptions,
    narrativeRecall?: string,
  ): AgentStreamOptions | undefined {
    const memoryKeys = parsePromptMemoryKeysFromEnv();
    let fromKv: AgentPromptMemoryContext = {};
    if (this.agentMemorySyncService && memoryKeys && memoryKeys.length > 0) {
      const { entries } = this.agentMemorySyncService.getSnapshot(actorId, memoryKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries);
    }

    let worldCaps: string | undefined;
    if (this.worldService && this.skillManager && isAgentCapsPromptEnabled()) {
      worldCaps = buildAgentCapabilityPromptSection(
        actorId,
        this.worldService,
        this.skillManager,
        this.virtualPhoneService ?? undefined,
      );
    }

    const memory: AgentPromptMemoryContext = {
      ...fromKv,
      ...(worldCaps ? { worldCaps } : {}),
      ...(narrativeRecall ? { narrativeRecall } : {}),
    };

    const hasMemory =
      Boolean(memory.persona) ||
      Boolean(memory.values) ||
      Boolean(memory.abilities) ||
      Boolean(memory.memorySummary) ||
      Boolean(memory.worldCaps) ||
      Boolean(memory.narrativeRecall);

    let chatToolsExtra = undefined as AgentStreamOptions["chatToolsExtra"];
    if (this.worldService && this.skillManager) {
      chatToolsExtra = buildSessionSkillChatTools(actorId, this.worldService, this.skillManager);
    }

    const toolLoop =
      opts?.onToolLoopAfterBatch != null
        ? { onAfterToolBatch: opts.onToolLoopAfterBatch }
        : undefined;

    if (!hasMemory && !toolLoop && (!chatToolsExtra || chatToolsExtra.length === 0)) {
      return undefined;
    }

    return {
      ...(hasMemory ? { promptContext: { memory } } : {}),
      ...(toolLoop ? { toolLoop } : {}),
      ...(chatToolsExtra?.length ? { chatToolsExtra } : {}),
    };
  }
}
