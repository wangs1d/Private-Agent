import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { HermesEvolutionLoopService } from "../services/hermes-evolution-loop-service.js";
import type { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import type { NarrativeMemoryPort } from "../services/narrative-memory-port.js";
import type { TrajectorySkillPromotionService } from "../services/trajectory-skill-promotion-service.js";
import type { TaskExecutionPlan } from "./plan-execute-loop.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import { detectMemorySignals, shouldSkipNarrativeRecall } from "./memory-signal.js";
import { getShortTermMemoryConfig } from "../services/short-term-memory-config.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import { getTurnWalService } from "../services/turn-wal-service.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";

export type FinalizeTurnInput = {
  actorId: string;
  userText: string;
  assistantText: string;
  modelCallsConsumed?: number;
  planExecuteUsed?: boolean;
  pePlan?: TaskExecutionPlan | null;
  peExhausted?: boolean;
  messageId?: string;
};

export type FinalizeTurnResult = {
  quotaSuffix?: string;
};

/**
 * 每轮对话前后统一钩子：记忆召回、写入、配额、进化环。
 */
export class TurnLifecycle {
  private readonly stmConfig = getShortTermMemoryConfig();

  constructor(
    private readonly deps: {
      narrativeMemory: NarrativeMemoryPort | null;
      computeQuotaService: ComputeQuotaService | null;
      hermesEvolutionLoopService: HermesEvolutionLoopService | null;
      userPersonalizationService: UserPersonalizationService | null;
      agentMemorySyncService: AgentMemorySyncService | null;
    },
  ) {}

  async prepareNarrativeRecall(actorId: string, text: string): Promise<string | undefined> {
    if (!this.deps.narrativeMemory || shouldSkipNarrativeRecall(text)) return undefined;
    const timeoutMs = getAgentRuntimeConfig().memoryPrompt.narrativeRecallTimeoutMs;
    try {
      const nr = await Promise.race([
        this.deps.narrativeMemory.buildNarrativeRecall(actorId, text),
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("narrative recall timeout")), timeoutMs);
        }),
      ]);
      return nr.trim() ? nr : undefined;
    } catch {
      return undefined;
    }
  }

  ingestTurnArchive(actorId: string, userText: string, assistantText: string): void {
    if (!this.deps.narrativeMemory) return;
    void this.deps.narrativeMemory
      .ingest(
        actorId,
        `Turn archive | user: ${userText.slice(0, 600)} | assistant: ${assistantText.slice(0, 1800)}`,
        "chat:turn_archive",
      )
      .catch(() => {});
  }

  ingestFastPath(actorId: string, lines: string[]): void {
    if (!this.deps.narrativeMemory || lines.length === 0) return;
    const body = lines.join("\n");
    void this.deps.narrativeMemory
      .ingest(actorId, body, "chat:fast_path", { highSignal: true })
      .catch(() => {});
  }

  finalizeTurn(input: FinalizeTurnInput): FinalizeTurnResult {
    const full = input.assistantText.trim();
    if (!full) {
      return this.applyQuota(input);
    }

    const signal = detectMemorySignals(input.userText, full);
    const ts = new Date().toISOString();

    void getTurnWalService()
      .append({
        ts,
        actorId: input.actorId,
        userText: input.userText,
        assistantText: full,
        highSignal: signal.isHighSignal,
        messageId: input.messageId,
        planExecuteUsed: input.planExecuteUsed,
      })
      .catch(() => {});

    getDailyDigestService().observeTurn(input.actorId, input.userText, full, {
      priorityLines: signal.isHighSignal ? signal.extractLines : undefined,
    });

    if (signal.isHighSignal) {
      this.ingestFastPath(input.actorId, signal.extractLines);
      if (this.deps.agentMemorySyncService) {
        for (const line of signal.extractLines) {
          this.deps.agentMemorySyncService.appendMemorySummaryLine(input.actorId, `[fast-path] ${line}`);
        }
      }
    }

    const deferArchive =
      this.stmConfig.mode === "enhanced" &&
      (this.stmConfig.deferTurnArchive || signal.isHighSignal);
    if (!deferArchive) {
      this.ingestTurnArchive(input.actorId, input.userText, full);
    }

    this.deps.hermesEvolutionLoopService?.onAssistantDone(input.actorId, input.userText, full);
    this.deps.userPersonalizationService?.observeTurn(input.actorId, input.userText, full);

    return this.applyQuota(input);
  }

  private applyQuota(input: FinalizeTurnInput): FinalizeTurnResult {
    const units = getAgentRuntimeConfig().quota.unitsPerModelCall;
    const modelCalls = Math.max(1, input.modelCallsConsumed ?? 1);
    if (!this.deps.computeQuotaService || !Number.isFinite(units) || units <= 0) {
      return {};
    }

    const totalConsume = units * modelCalls;
    const adj = this.deps.computeQuotaService.adjust(input.actorId, "consume", totalConsume);
    if (!adj.ok) {
      return {
        quotaSuffix: `（提示：算力配额不足，本次按 ${modelCalls} 次模型调用未扣减共 ${totalConsume} 单位；请扩大 COMPUTE_QUOTA_DEFAULT_UNITS 或释放预留。）`,
      };
    }
    return {};
  }

  /** 轨迹晋升捕获收尾（与 finalizeTurn 分离，便于传入 trajCap 实例） */
  static finalizeTrajectory(
    trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined,
    assistantText: string,
    meta: {
      planExecuteUsed: boolean;
      modelCallsApprox: number;
      pePlan: TaskExecutionPlan | null;
      peExhausted: boolean;
    },
  ): void {
    if (!trajCap) return;
    trajCap.observePePlan(meta.pePlan);
    trajCap.observeSelfCheck(
      meta.planExecuteUsed
        ? meta.peExhausted
          ? "自检未通过或已达到最大重试"
          : "PE 自检通过或未触发重试阈值"
        : "单轮工具环路径",
      meta.planExecuteUsed ? !meta.peExhausted : undefined,
    );
    void trajCap
      .finalizeHermes(assistantText, {
        planExecuteEnabled: meta.planExecuteUsed,
        modelCallsApprox: meta.modelCallsApprox,
        pePlan: meta.pePlan,
        peExhaustedRetries: meta.peExhausted,
      })
      .catch(() => {});
  }
}
