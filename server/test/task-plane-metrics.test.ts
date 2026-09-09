/**
 * 后台任务首轮一次成功率观测回归（2026-09-06）。
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.FAST_CHANNEL_LOG_EVERY = "1000"; // 测试内不打汇总日志

const {
  recordBackgroundOutcome,
  snapshotBackgroundMetrics,
  resetBackgroundMetrics,
} = await import("../src/services/task-plane-metrics.js");

test("计数与一次成功率快照", () => {
  resetBackgroundMetrics();
  assert.equal(snapshotBackgroundMetrics().firstTryRate, "n/a");

  recordBackgroundOutcome("direct_ok", 820, "查比特币价格");
  recordBackgroundOutcome("direct_ok", 700, "找猫照片");
  recordBackgroundOutcome("upgraded_ok", 900, "多步任务");
  recordBackgroundOutcome("failed", 950, "坏任务");

  const snap = snapshotBackgroundMetrics();
  assert.equal(snap.total, 4);
  assert.equal(snap.firstTryOk, 2);
  assert.equal(snap.upgradedOk, 1);
  assert.equal(snap.failed, 1);
  assert.equal(snap.firstTryRate, "50%");
  assert.ok(snap.avgFirstAttemptMs.includes("950"));
  assert.ok(snap.lastOutcomeAt);
});

test("reset 清空全部计数", () => {
  resetBackgroundMetrics();
  recordBackgroundOutcome("direct_ok", 100);
  resetBackgroundMetrics();
  const snap = snapshotBackgroundMetrics();
  assert.equal(snap.total, 0);
  assert.equal(snap.firstTryRate, "n/a");
});
