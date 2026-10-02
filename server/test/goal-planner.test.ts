/**
 * GoalPlanner（计划推进型目标）行为测试（2026-09-24）。
 *
 * 契约：
 *   - 创建：拆步建档，步骤敏感分级落档
 *   - 推进：read/内部步骤派后台任务（launchTask），外部步骤不自动派 → awaiting_confirm
 *   - 完成：TaskHub 终态回调自动推进下一步；全部完成 → markReady 进 ReadyTray
 *   - 失败：步骤失败计划停住（不静默重试），活动台账如实告知
 *   - 重排：replan 替换未完成步骤、保留已完结存档；abandon 终结
 *   - 对账：reconcile 处理重启后 doing 步骤的任务台账缺失
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GoalBoard } = await import("../src/proactivity/goal-board.js");
const { GoalPlanner } = await import("../src/proactivity/goal-planner.js");
const { TaskHub } = await import("../src/task-plane/task-hub.js");

function makeBoard(): InstanceType<typeof GoalBoard> {
  const dir = mkdtempSync(join(tmpdir(), "pa-planner-"));
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {} });
  return board;
}

function cleanup(board: InstanceType<typeof GoalBoard>): void {
  const dir = board.list()[0]?.goalId; // 仅用于让 TS 满意；目录通过 tmpdir 隔离
  void dir;
}

type Launch = { actorId: string; goal: string }[];

test("创建计划：拆步建档 + 敏感分级", () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const r = planner.createPlan({
    actorId: "u1",
    title: "三个月内搬家",
    steps: ["查东站周边两居室房源并整理 5 个候选", "联系中介约看房", "签约付定金"],
  });
  assert.ok(r.ok);
  const steps = planner.stepsOf(r.goal);
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.sensitivity, "read");
  assert.equal(steps[2]!.sensitivity, "act_external", "签约付定金命中外部词");
  assert.equal(r.goal.kind, "plan");
  cleanup(board);
});

test("推进：read 步骤派发，通道缺失如实 blocked（不假装推进）", () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const r = planner.createPlan({ actorId: "u1", title: "T", steps: ["查房源"] });
  assert.ok(r.ok);
  const outcome = planner.advance(r.goal.goalId, "u1");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.reason.includes("未就绪"));
  }
});

test("推进：外部步骤不自动派发 → awaiting_confirm；确认后放行", () => {
  const board = makeBoard();
  const launches: Launch = [];
  const planner = new GoalPlanner({
    goalBoard: board,
    launchTask: (input) => {
      launches.push(input);
      return `task-${launches.length}`;
    },
  });
  const r = planner.createPlan({ actorId: "u1", title: "搬家", steps: ["签约付定金"] });
  assert.ok(r.ok);

  const first = planner.advance(r.goal.goalId, "u1");
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.action, "awaiting_confirm");
    assert.ok(first.reason.includes("需要用户明确同意"));
  }
  assert.equal(launches.length, 0, "外部步骤未确认绝不派发");

  const second = planner.advance(r.goal.goalId, "u1", { confirmExternal: true });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.action, "dispatched");
  }
  assert.equal(launches.length, 1);
});

test("TaskHub 终态回调：done 自动推进；全部完成 → ReadyTray 有完成摘要", () => {
  const board = makeBoard();
  const hub = new TaskHub();
  let seq = 0;
  const planner = new GoalPlanner({
    goalBoard: board,
    // 生产里 agentCore.dispatchBackgroundTask 负责提交台账；桩同口径：派发即 submit
    launchTask: (input) => {
      const id = `task-${++seq}`;
      hub.submit({ taskId: id, sessionId: "u1", goal: input.goal });
      return id;
    },
  });
  planner.attachTaskHub(hub as never);

  const r = planner.createPlan({ actorId: "u1", title: "备考", steps: ["整理考纲", "刷第一套真题"] });
  assert.ok(r.ok);
  const first = planner.advance(r.goal.goalId, "u1");
  assert.ok(first.ok);

  // 第一步任务完成 → 自动派发第二步
  hub.setState("task-1", "done");
  const afterFirst = planner.getPlan(r.goal.goalId)!;
  let steps = planner.stepsOf(afterFirst);
  assert.equal(steps[0]!.status, "done");
  assert.equal(steps[1]!.status, "doing");

  // 第二步完成 → 计划 markReady 进托盘
  hub.setState("task-2", "done");
  const finished = planner.getPlan(r.goal.goalId)!;
  assert.equal(finished.status, "ready");
  assert.ok(String(finished.payload?.body ?? "").includes("备考"), "完成摘要进投递正文");
  assert.equal(board.readyTray().some((g) => g.goalId === finished.goalId), true);

  // 完成后再 advance 拒绝
  const extra = planner.advance(r.goal.goalId, "u1");
  assert.equal(extra.ok, false);
});

test("步骤失败：计划停住，后续步骤不自动推进", () => {
  const board = makeBoard();
  const hub = new TaskHub();
  let seq = 0;
  const activities: string[] = [];
  const planner = new GoalPlanner({
    goalBoard: board,
    launchTask: (input) => {
      const id = `task-${++seq}`;
      hub.submit({ taskId: id, sessionId: "u1", goal: input.goal });
      return id;
    },
    recordActivity: (input) => activities.push(input.title),
  });
  planner.attachTaskHub(hub as never);
  const r = planner.createPlan({ actorId: "u1", title: "装修", steps: ["找施工队", "进场开工"] });
  assert.ok(r.ok);
  planner.advance(r.goal.goalId, "u1");
  hub.setState("task-1", "failed");
  const steps = planner.stepsOf(planner.getPlan(r.goal.goalId)!);
  assert.equal(steps[0]!.status, "failed");
  assert.equal(steps[1]!.status, "todo", "失败后不自动推进");
  assert.ok(activities.some((t) => t.includes("没办成")));
});

test("replan：替换未完成步骤，保留 done 存档，原因落档", () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board, launchTask: () => "noop" });
  const r = planner.createPlan({ actorId: "u1", title: "P", steps: ["一步办完", "第二步"] });
  assert.ok(r.ok);
  const g = planner.getPlan(r.goal.goalId)!;
  const steps = planner.stepsOf(g);
  steps[0]!.status = "done";
  steps[0]!.note = "已完成";
  // 直接重排：给两个新步骤
  const rr = planner.replan(r.goal.goalId, "u1", ["新方向第一步", "新方向第二步"], "预算变了");
  assert.ok(rr.ok);
  const after = planner.stepsOf(planner.getPlan(r.goal.goalId)!);
  assert.equal(after.length, 3); // 1 done 存档 + 2 新步骤
  assert.equal(after[0]!.status, "done");
  assert.equal(after.filter((s) => s.status === "todo").length, 2);
  assert.equal((planner.getPlan(r.goal.goalId)!.payload as { lastReplanReason?: string }).lastReplanReason, "预算变了");
});

test("abandon：终结计划并清反查索引", () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const r = planner.createPlan({ actorId: "u1", title: "不想要了", steps: ["做点啥"] });
  assert.ok(r.ok);
  const out = planner.abandon(r.goal.goalId, "u1", "改主意了");
  assert.equal(out.ok, true);
  assert.equal(planner.getPlan(r.goal.goalId)!.status, "done");
});

test("reconcile：任务台账缺失的 doing 步骤如实标失败", () => {
  const board = makeBoard();
  const hub = new TaskHub();
  const planner = new GoalPlanner({ goalBoard: board, launchTask: () => "task-gone" });
  const r = planner.createPlan({ actorId: "u1", title: "重启场景", steps: ["查房源", "约看房"] });
  assert.ok(r.ok);
  planner.advance(r.goal.goalId, "u1");
  planner.reset(); // 清掉运行中索引（模拟进程重启）
  planner.reconcile(hub as never); // 台账里没有 task-gone → 失败落账
  const steps = planner.stepsOf(planner.getPlan(r.goal.goalId)!);
  assert.equal(steps[0]!.status, "failed");
  assert.equal(steps[1]!.status, "todo");
});

test("轻步骤判定：纯加工步骤标 light，含查询/外部动作的不标", async () => {
  const { isLightStep } = await import("../src/proactivity/goal-planner.js");
  assert.equal(isLightStep("总结一下目前的进展"), true);
  assert.equal(isLightStep("先整理这两天的结果"), true, "前导词容许");
  assert.equal(isLightStep("回顾这周做了什么"), true);
  assert.equal(isLightStep("起草一份给房东的留言"), true);
  assert.equal(isLightStep("查一下明天去大理的机票"), false, "含查询词");
  assert.equal(isLightStep("整理并搜索相关资料"), false, "含搜索词");
  assert.equal(isLightStep("预约周四的看房时间"), false, "外部动作");
  assert.equal(isLightStep("下单购买打印机"), false);
  assert.equal(isLightStep(""), false);
});

test("轻步骤走小预算车道：launchTask 收到 light 标记", () => {
  const board = makeBoard();
  const seen: Array<{ goal: string; light?: boolean }> = [];
  const planner = new GoalPlanner({
    goalBoard: board,
    launchTask: (input) => {
      seen.push({ goal: input.goal, light: input.light });
      return `task-${seen.length}`;
    },
  });
  const r = planner.createPlan({
    actorId: "u1",
    title: "搬家准备",
    steps: ["总结现在的房间物品", "查搬家公司报价"],
  });
  assert.ok(r.ok);
  planner.advance(r.goal.goalId, "u1");
  assert.equal(seen[0]!.light, true, "纯加工步骤带 light 标记");
  const steps = planner.stepsOf(planner.getPlan(r.goal.goalId)!);
  assert.equal(steps[1]!.light, false, "查询步骤不标 light");
});
