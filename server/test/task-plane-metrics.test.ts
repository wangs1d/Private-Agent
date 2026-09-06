/**
 * 快速通道一次成功率观测回归（2026-09-06）。
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.FAST_CHANNEL_LOG_EVERY = "1000"; // 测试内不打汇总日志

const {
  recordFastChannelOutcome,
  snapshotFastChannelMetrics,
  resetFastChannelMetrics,
} = await import("../src/services/task-plane-metrics.js");

test("计数与一次成功率快照", () => {
  resetFastChannelMetrics();
  assert.equal(snapshotFastChannelMetrics().fastOkRate, "n/a");

  recordFastChannelOutcome("fast_ok", 820, "查比特币价格");
  recordFastChannelOutcome("fast_ok", 700, "找猫照片");
  recordFastChannelOutcome("upgraded_ok", 900, "多步任务");
  recordFastChannelOutcome("failed", 950, "坏任务");

  const snap = snapshotFastChannelMetrics();
  assert.equal(snap.total, 4);
  assert.equal(snap.fastOk, 2);
  assert.equal(snap.upgradedOk, 1);
  assert.equal(snap.failed, 1);
  assert.equal(snap.fastOkRate, "50%");
  assert.ok(snap.avgFastAttemptMs.includes("950"));
  assert.ok(snap.lastOutcomeAt);
});

test("reset 清空全部计数", () => {
  resetFastChannelMetrics();
  recordFastChannelOutcome("fast_ok", 100);
  resetFastChannelMetrics();
  const snap = snapshotFastChannelMetrics();
  assert.equal(snap.total, 0);
  assert.equal(snap.fastOkRate, "n/a");
});
