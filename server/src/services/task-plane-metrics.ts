/**
 * 后台任务首轮一次成功率观测（2026-09-06）。
 *
 * 前后台架构的关键运营指标：派发进后台的任务里，首轮（轻量档 + 能力束工具）
 * 一次收尾的比例。一次成功率低 → 大量任务在付「升级完整通道」的
 * Pro + planner 账，或最终失败——是调预算/换档位的直接依据（见
 * docs/foreground-background-architecture.md 观测点）。
 *
 * 设计：纯进程内计数器，零依赖零 IO；每 FAST_CHANNEL_LOG_EVERY 个任务打一条
 * 汇总日志。快照可被诊断接口/测试消费。
 */

export type BackgroundOutcome = "direct_ok" | "upgraded_ok" | "failed";

type BackgroundCounters = {
  total: number;
  firstTryOk: number;
  upgradedOk: number;
  failed: number;
  /** 快速通道尝试耗时样本（ms，仅收尾/升级时刻各记一次） */
  lastFirstAttemptMs: number;
  lastOutcomeAt: string;
};

const counters: BackgroundCounters = {
  total: 0,
  firstTryOk: 0,
  upgradedOk: 0,
  failed: 0,
  lastFirstAttemptMs: 0,
  lastOutcomeAt: "",
};

const LOG_EVERY = (() => {
  const n = Number.parseInt(process.env.FAST_CHANNEL_LOG_EVERY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

export function recordBackgroundOutcome(
  outcome: BackgroundOutcome,
  firstAttemptMs: number,
  goalPreview = "",
): void {
  counters.total += 1;
  counters.lastFirstAttemptMs = Math.max(0, Math.round(firstAttemptMs));
  counters.lastOutcomeAt = new Date().toISOString();
  if (outcome === "direct_ok") counters.firstTryOk += 1;
  else if (outcome === "upgraded_ok") counters.upgradedOk += 1;
  else counters.failed += 1;

  if (counters.total % LOG_EVERY === 0) {
    const snap = snapshotBackgroundMetrics();
    console.info(
      `[task-plane] 近 ${snap.total} 个后台任务：一次成功 ${snap.firstTryRate} | 升级后成功 ${snap.upgradedOk} | 失败 ${snap.failed} | 首轮均耗 ${snap.avgFirstAttemptMs}` +
        (goalPreview ? ` | 最近: ${goalPreview.slice(0, 40)}` : ""),
    );
  }
}

export type BackgroundMetricsSnapshot = {
  total: number;
  firstTryOk: number;
  upgradedOk: number;
  failed: number;
  /** firstTryOk / (firstTryOk + upgradedOk + failed)，无数据时为 "n/a" */
  firstTryRate: string;
  avgFirstAttemptMs: string;
  lastOutcomeAt: string;
};

export function snapshotBackgroundMetrics(): BackgroundMetricsSnapshot {
  const finished = counters.firstTryOk + counters.upgradedOk + counters.failed;
  return {
    total: counters.total,
    firstTryOk: counters.firstTryOk,
    upgradedOk: counters.upgradedOk,
    failed: counters.failed,
    firstTryRate:
      finished === 0 ? "n/a" : `${((counters.firstTryOk / finished) * 100).toFixed(0)}%`,
    avgFirstAttemptMs:
      counters.total === 0 ? "n/a" : `${Math.round(counters.lastFirstAttemptMs)}ms(最近)`,
    lastOutcomeAt: counters.lastOutcomeAt,
  };
}

/** 测试用：清空计数。 */
export function resetBackgroundMetrics(): void {
  counters.total = 0;
  counters.firstTryOk = 0;
  counters.upgradedOk = 0;
  counters.failed = 0;
  counters.lastFirstAttemptMs = 0;
  counters.lastOutcomeAt = "";
}
