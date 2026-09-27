/**
 * 审计时间线（AuditTrailService）聚合测试（2026-09-24）。
 *
 * 契约：
 *   - 四源聚合：代办台账 / 目标板 / 任务面 / 挂起确认，时间倒序
 *   - 计划步骤派生的任务（taskId 被步骤引用）不重复出条
 *   - summary 三段式：等确认 / 在办在盯 / 最近办结；空态 null
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AgentActivityStore } = await import("../src/proactivity/activity-store.js");
const { GoalBoard } = await import("../src/proactivity/goal-board.js");
const { GoalPlanner } = await import("../src/proactivity/goal-planner.js");
const { AuditTrailService } = await import("../src/proactivity/audit-timeline.js");
const { TaskHub } = await import("../src/task-plane/task-hub.js");
const { PendingConfirmationStore } = await import("../src/proactivity/pending-confirmation-store.js");

function makeStore(): InstanceType<typeof AgentActivityStore> {
  return new AgentActivityStore(join(mkdtempSync(join(tmpdir(), "pa-audit-")), "activities.json"));
}

test("四源聚合 + 计划任务去重 + summary 三段式", () => {
  const store = makeStore();
  store.record({ actorId: "u1", kind: "action.purchase", title: "已订购牛奶", summary: "s" });
  store.record({ actorId: "u1", kind: "action.message", title: "已把改期信息告诉小王", summary: "s" });

  const board = new GoalBoard({ dataPath: mkdtempSync(join(tmpdir(), "pa-audit-")), emitGoal: () => {} });
  const planner = new GoalPlanner({ goalBoard: board, launchTask: () => "task-plan-1" });
  const created = planner.createPlan({ actorId: "u1", title: "搬家计划", steps: ["查房源", "约看房"] });
  assert.ok(created.ok);
  const adv = planner.advance(created.goal.goalId, "u1");
  assert.ok(adv.ok && adv.action === "dispatched");

  const hub = new TaskHub();
  hub.submit({ taskId: "task-plan-1", sessionId: "u1", goal: "【计划推进】搬家计划｜第 1 步：查房源" });
  hub.submit({ taskId: "task-free", sessionId: "u1", goal: "帮我看看今天油价" });

  const confirms = new PendingConfirmationStore();
  confirms.register({
    actorId: "u1",
    kind: "hub",
    steps: [],
    rationale: "要替你向张总发送催促消息",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    origin: "hub",
  });

  const svc = new AuditTrailService({
    activityStore: store,
    goalBoard: board,
    taskHub: hub,
    pendingConfirmations: confirms,
  });

  const entries = svc.timeline("u1", 50);
  const titles = entries.map((e) => e.title);

  // 计划条目在，其派生任务不出条
  assert.ok(titles.some((t) => t.includes("搬家计划")));
  assert.ok(!titles.some((t) => t.includes("【计划推进】搬家计划")), "计划派生任务不重复出条");
  // 自由任务照常出条
  assert.ok(titles.some((t) => t.includes("油价")));
  // 待确认与台账
  assert.ok(entries.some((e) => e.bucket === "awaiting" && e.source === "pending_confirm"));
  assert.ok(entries.some((e) => e.bucket === "done" && e.source === "ledger" && e.title.includes("牛奶")));

  // 时间倒序
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1]!.ts >= entries[i]!.ts);
  }

  const summary = svc.summary("u1")!;
  assert.ok(summary.includes("等你确认"));
  assert.ok(summary.includes("在办"));
  assert.ok(summary.includes("最近办结"));
});

test("空态：timeline 空 + summary null（零编造）", () => {
  const svc = new AuditTrailService({
    activityStore: makeStore(),
    goalBoard: new GoalBoard({ dataPath: mkdtempSync(join(tmpdir(), "pa-audit-")), emitGoal: () => {} }),
    taskHub: new TaskHub(),
  });
  assert.equal(svc.timeline("ghost", 10).length, 0);
  assert.equal(svc.summary("ghost"), null);
});
