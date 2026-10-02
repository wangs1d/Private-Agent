// 话题级 dismiss 追踪 + 按小时接受率画像 单测（2026-10-01 学习闭环补强）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { TopicDismissTracker, topicKeyOfProposal } from "../src/proactivity/topic-dismiss-tracker.js";

const T0 = new Date(2026, 9, 1, 10, 0, 0).getTime();

// ─── OutcomeStore.hourlyReceptivity ───

test("hourlyReceptivity: 已决策 outcome 按小时分桶 + Laplace 平滑，delivered/viewed 不进分母", () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-hourly-"));
  try {
    const store = new OutcomeStore(join(dir, "outcomes.json"));
    // 10 点：2 正 1 负 → (2+1)/(3+2) = 0.6；11 点：只 delivered → 无已决策样本
    const rows = [
      { deliveryId: "d1", actorId: "u1", kind: "k", channel: "in_app", outcome: "accepted" as const, at: T0 },
      { deliveryId: "d2", actorId: "u1", kind: "k", channel: "in_app", outcome: "replied" as const, at: T0 + 60_000 },
      { deliveryId: "d3", actorId: "u1", kind: "k", channel: "in_app", outcome: "dismissed" as const, at: T0 + 120_000 },
      { deliveryId: "d4", actorId: "u1", kind: "k", channel: "in_app", outcome: "delivered" as const, at: T0 + 3 * 3600_000 },
    ];
    for (const r of rows) store.record(r);
    const byHour = store.hourlyReceptivity("u1", T0 + 3600_000);
    assert.equal(byHour.get(10)?.samples, 3);
    assert.ok(Math.abs((byHour.get(10)?.rate ?? 0) - 0.6) < 1e-9, `rate=0.6, got ${byHour.get(10)?.rate}`);
    assert.equal(byHour.get(13), undefined, "只有 delivered 的时段无已决策样本");
    assert.equal(byHour.get(11), undefined);
    // 其他 actor 隔离
    assert.equal(store.hourlyReceptivity("someone-else", T0 + 3600_000).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── TopicDismissTracker ───

test("topicDismiss: 连续 3 次触发建议一次；再 dismiss 不重复建议（30 天间隔）", () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-dismiss-"));
  try {
    const tracker = new TopicDismissTracker({ dataPath: dir, now: () => T0 });
    assert.equal(tracker.note("u1", "发件人:李雷"), null);
    assert.equal(tracker.note("u1", "发件人:李雷"), null);
    const hit = tracker.note("u1", "发件人:李雷");
    assert.ok(hit, "第 3 次触发建议");
    assert.equal(hit!.topic, "发件人:李雷");
    assert.equal(hit!.count, 3);
    // 第 4/5 次：30 天内不再建议
    assert.equal(tracker.note("u1", "发件人:李雷", T0 + 3600_000), null);
    assert.equal(tracker.note("u1", "发件人:李雷", T0 + 2 * 3600_000), null);
    // 31 天后再次达阈值 → 可再建议
    assert.equal(tracker.note("u1", "发件人:李雷", T0 + 31 * 24 * 3600_000), null, "计数窗口外重置，此次是第 1 条");
    assert.equal(tracker.note("u1", "发件人:李雷", T0 + 31 * 24 * 3600_000 + 60_000), null);
    const again = tracker.note("u1", "发件人:李雷", T0 + 31 * 24 * 3600_000 + 120_000);
    assert.ok(again, "窗口重置后重新计满 3 条可再建议");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("topicDismiss: 正反馈清零 + 话题键归一", () => {
  const tracker = new TopicDismissTracker({ now: () => T0 });
  tracker.note("u1", "王者荣耀");
  tracker.note("u1", "王者荣耀");
  tracker.resetTopic("u1", "王者荣耀");
  assert.equal(tracker.note("u1", "王者荣耀"), null, "清零后第 1 条不触发");
  assert.equal(tracker.note("u1", "王者荣耀"), null);

  // 话题键：message_watch 提案取发件人；普通提案取摘要前缀
  assert.equal(
    topicKeyOfProposal({ title: "发现日程变动", summary: "李雷：会议推迟", detail: { 发件人: "李雷", 原文: "会议推迟到周四" } }),
    "发件人:李雷",
  );
  assert.equal(topicKeyOfProposal({ title: "t", summary: "你关注的「刘浩存」有新动态" }), "你关注的「刘浩存」有新动态");
});
