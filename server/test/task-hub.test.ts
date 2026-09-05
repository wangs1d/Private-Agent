/**
 * TaskHub（2026-09-05 双面架构接缝）行为测试。
 *
 * 契约：
 *   - 任务记录生命周期：running → done/failed/cancelled；
 *   - activeSummary 只在有活跃任务时产出（无任务时 prompt 零污染）；
 *   - 进度快照供"怎么样了"零 LLM 直答；
 *   - 终态记录保留一段时间后 prune。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { TaskHub } = await import("../src/task-plane/task-hub.js");

test("submit → done：记录生命周期与进度快照", () => {
  const hub = new TaskHub();
  hub.submit({ taskId: "t1", sessionId: "s1", replyAnchorId: "m1", goal: "查刘浩存最近的动态" });
  hub.setProgress("t1", "正在使用 search_web");
  assert.equal(hub.get("t1")?.state, "running");
  assert.equal(hub.get("t1")?.progressLine, "正在使用 search_web");
  assert.equal(hub.get("t1")?.replyAnchorId, "m1");

  hub.setState("t1", "done");
  assert.equal(hub.get("t1")?.state, "done");
  // 终态任务不再出现在活跃列表
  assert.equal(hub.activeRecords("s1").length, 0);
});

test("activeSummary：无任务返回 undefined（路由 prompt 零污染）", () => {
  const hub = new TaskHub();
  assert.equal(hub.activeSummary("sess-empty"), undefined);
});

test("activeSummary：活跃任务产出摘要，含状态/目标/进度", () => {
  const hub = new TaskHub();
  hub.submit({ taskId: "t2", sessionId: "s2", goal: "帮我订明天去上海的机票" });
  hub.setProgress("t2", "正在查询航班");
  const summary = hub.activeSummary("s2");
  assert.ok(summary, "有活跃任务时应产出摘要");
  assert.ok(summary.includes("订明天去上海的机票"), "摘要应含任务目标");
  assert.ok(summary.includes("正在查询航班"), "摘要应含进度快照");
  assert.ok(summary.includes("running"), "摘要应含状态");
});

test("activeSummary：会话隔离 + 最近任务优先 + 数量封顶 3", () => {
  const hub = new TaskHub();
  for (let i = 0; i < 5; i++) {
    hub.submit({ taskId: `t-${i}`, sessionId: "s3", goal: `任务${i}` });
  }
  hub.submit({ taskId: "t-other", sessionId: "s4", goal: "别的会话" });
  const summary = hub.activeSummary("s3") ?? "";
  assert.ok(!summary.includes("别的会话"), "不同会话不得串台");
  assert.ok(!summary.includes("任务0"), "应只保留最近 3 个任务");
  assert.ok(summary.includes("任务4"), "最近任务应在摘要中");
});

test("失败/取消状态正确流转", () => {
  const hub = new TaskHub();
  hub.submit({ taskId: "f1", sessionId: "s5", goal: "查个东西" });
  hub.setState("f1", "failed");
  hub.submit({ taskId: "f2", sessionId: "s5", goal: "再查一个" });
  hub.setState("f2", "cancelled");
  assert.equal(hub.activeRecords("s5").length, 0);
  assert.equal(hub.get("f1")?.state, "failed");
  assert.equal(hub.get("f2")?.state, "cancelled");
});
