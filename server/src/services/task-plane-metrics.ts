/**
 * 后台任务快速通道一次成功率观测（2026-09-06）。
 *
 * 前后台架构的关键运营指标：派发进后台的任务里，快速通道（Flash + 桥工具 +
 * 2 波预算）一次收尾的比例。一次成功率低 → 大量任务在付「升级完整通道」的
 * Pro + planner 账，或最终失败——是调预算/换档位的直接依据（见
 * docs/foreground-background-architecture.md 观测点）。
 *
 * 设计：纯进程内计数器，零依赖零 IO；每 FAST_CHANNEL_LOG_EVERY 个任务打一条
 * 汇总日志。快照可被诊断接口/测试消费。
 */

export type FastChannelOutcome = "fast_ok" | "upgraded_ok" | "failed";

type FastChannelCounters = {
  total: number;
  fastOk: number;
  upgradedOk: number;
  failed: number;
  /** 快速通道尝试耗时样本（ms，仅收尾/升级时刻各记一次） */
  lastFastAttemptMs: number;
  lastOutcomeAt: string;
};

const counters: FastChannelCounters = {
  total: 0,
  fastOk: 0,
  upgradedOk: 0,
  failed: 0,
  lastFastAttemptMs: 0,
  lastOutcomeAt: "",
};

const LOG_EVERY = (() => {
  const n = Number.parseInt(process.env.FAST_CHANNEL_LOG_EVERY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

export function recordFastChannelOutcome(
  outcome: FastChannelOutcome,
  fastAttemptMs: number,
  goalPreview = "",
): void {
  counters.total += 1;
  counters.lastFastAttemptMs = Math.max(0, Math.round(fastAttemptMs));
  counters.lastOutcomeAt = new Date().toISOString();
  if (outcome === "fast_ok") counters.fastOk += 1;
  else if (outcome === "upgraded_ok") counters.upgradedOk += 1;
  else counters.failed += 1;

  if (counters.total % LOG_EVERY === 0) {
    const snap = snapshotFastChannelMetrics();
    console.info(
      `[task-plane] 近 ${snap.total} 个后台任务：快速通道一次成功 ${snap.fastOkRate} | 升级后成功 ${snap.upgradedOk} | 失败 ${snap.failed} | 快速通道均耗 ${snap.avgFastAttemptMs}` +
        (goalPreview ? ` | 最近: ${goalPreview.slice(0, 40)}` : ""),
    );
  }
}

export type FastChannelMetricsSnapshot = {
  total: number;
  fastOk: number;
  upgradedOk: number;
  failed: number;
  /** fastOk / (fastOk + upgradedOk + failed)，无数据时为 "n/a" */
  fastOkRate: string;
  avgFastAttemptMs: string;
  lastOutcomeAt: string;
};

export function snapshotFastChannelMetrics(): FastChannelMetricsSnapshot {
  const finished = counters.fastOk + counters.upgradedOk + counters.failed;
  return {
    total: counters.total,
    fastOk: counters.fastOk,
    upgradedOk: counters.upgradedOk,
    failed: counters.failed,
    fastOkRate:
      finished === 0 ? "n/a" : `${((counters.fastOk / finished) * 100).toFixed(0)}%`,
    avgFastAttemptMs:
      counters.total === 0 ? "n/a" : `${Math.round(counters.lastFastAttemptMs)}ms(最近)`,
    lastOutcomeAt: counters.lastOutcomeAt,
  };
}

/** 测试用：清空计数。 */
export function resetFastChannelMetrics(): void {
  counters.total = 0;
  counters.fastOk = 0;
  counters.upgradedOk = 0;
  counters.failed = 0;
  counters.lastFastAttemptMs = 0;
  counters.lastOutcomeAt = "";
}
