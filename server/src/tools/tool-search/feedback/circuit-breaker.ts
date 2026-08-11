import type { ToolRegistryStore } from "../registry/store.js";
import { HistoryScoreStore } from "../retrieval/history-score.js";

export type ToolFailureCircuitBreakerOptions = {
  historyStore?: HistoryScoreStore;
  failureRateThreshold?: number;
  minSamples?: number;
  consecutiveFailureThreshold?: number;
};

export type CircuitBreakerDecision = {
  tripped: boolean;
  resource_id: string;
  failure_rate: number;
  consecutive_failures: number;
  status_changed: boolean;
};

/**
 * Phase-5 故障熔断。
 *
 * 滑动窗口达到阈值后将资源状态标记为 rate_limited。这里用 console.warn
 * 作为 audit-service 未注入时的降级告警通道。
 */
export class ToolFailureCircuitBreaker {
  private readonly historyStore: HistoryScoreStore;
  private readonly failureRateThreshold: number;
  private readonly minSamples: number;
  private readonly consecutiveFailureThreshold: number;

  constructor(
    private readonly store: ToolRegistryStore,
    options?: ToolFailureCircuitBreakerOptions,
  ) {
    this.historyStore = options?.historyStore ?? new HistoryScoreStore();
    this.failureRateThreshold = clamp(
      options?.failureRateThreshold ?? Number(process.env.AGENT_TOOL_FAILURE_RATE_LIMIT ?? 0.6),
      0.05,
      1,
    );
    this.minSamples = Math.max(
      1,
      options?.minSamples ?? Number(process.env.AGENT_TOOL_FAILURE_MIN_SAMPLES ?? 5),
    );
    this.consecutiveFailureThreshold = Math.max(
      1,
      options?.consecutiveFailureThreshold ??
        Number(process.env.AGENT_TOOL_CONSECUTIVE_FAILURE_LIMIT ?? 3),
    );
  }

  async evaluate(resourceId: string): Promise<CircuitBreakerDecision> {
    const score = await this.historyStore.getScore(resourceId);
    const tripped =
      (score.sample_count >= this.minSamples &&
        score.failure_rate >= this.failureRateThreshold) ||
      score.consecutive_failures >= this.consecutiveFailureThreshold;

    let statusChanged = false;
    if (tripped) {
      const updated = await this.store.updateStatus(resourceId, "rate_limited");
      statusChanged = updated != null;
      console.warn(
        `[tool-search:circuit-breaker] resource rate_limited: ${resourceId} failure_rate=${score.failure_rate.toFixed(3)} consecutive=${score.consecutive_failures}`,
      );
    }

    return {
      tripped,
      resource_id: resourceId,
      failure_rate: score.failure_rate,
      consecutive_failures: score.consecutive_failures,
      status_changed: statusChanged,
    };
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
