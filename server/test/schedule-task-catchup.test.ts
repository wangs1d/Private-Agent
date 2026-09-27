/**
 * 定时任务补发（catch-up）回归测试：
 *  1. runtime 离线跨过触发点 → 重启补跑时窗内（>5min，<24h）标记补发：
 *     reminder 文案带【补发】前缀，agent_task 注入补发语境（原定时间锚点）。
 *  2. 准点触发（lag < 5min）不得误标补发。
 *  3. 超窗（>24h）不执行：记 status=missed 的 run、单次任务收口 completed、
 *     周期任务推进到未来槽位且只记一次 missed、超窗通知恰好一次。
 * 背景：2026-09-24 早8点科技早报因 runtime 未运行漏触发，用户定调
 * "检测到实际没有完成的时候就需要补发"。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ScheduleTaskService,
  type ScheduleTaskRecord,
} from "../src/services/schedule-task-service.js";

async function withTempScheduleFile<T>(
  fn: (service: ScheduleTaskService) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "schedule-task-catchup-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    return await fn(new ScheduleTaskService());
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 直接改内存里的 nextRunAt（parseRunAt 拒绝过去时间，只能创建后回拨）模拟离线跨点。 */
function backdateNextRunAt(service: ScheduleTaskService, taskId: string, toMs: number): void {
  const store = (
    service as unknown as { byTaskId: Map<string, ScheduleTaskRecord> }
  ).byTaskId;
  const task = store.get(taskId);
  assert.ok(task, "task should exist in memory store");
  task.nextRunAt = new Date(toMs).toISOString();
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("窗内补发：reminder 迟到执行带【补发】前缀且 run 记录补发标记", async () => {
  await withTempScheduleFile(async (service) => {
    const delivered: string[] = [];
    service.setReminderHandler(async (_task, message) => {
      delivered.push(message);
    });
    const task = await service.createTask({
      sessionId: "catchup-session",
      title: "科技早报",
      description: "科技早报",
      kind: "reminder",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "该看科技早报了",
    });
    // 模拟 runtime 离线 30 分钟后重启：nextRunAt 落在 30 分钟前
    backdateNextRunAt(service, task.taskId, Date.now() - 30 * 60_000);

    await service.runSchedulerTick();
    const message = await waitFor(() => delivered[0]);
    assert.ok(message.startsWith("【补发】"), `补发文案应带前缀，实际：${message}`);
    const run = await waitFor(() => service.listRuns(task.taskId)[0]);
    assert.equal(run.status, "success");
    assert.equal((run.output as { catchUp?: boolean }).catchUp, true);
    // 单次任务补发后正常收口
    assert.equal(service.getTask(task.taskId)?.status, "completed");
  });
});

test("准点触发（lag<5min）不误标补发", async () => {
  await withTempScheduleFile(async (service) => {
    const delivered: string[] = [];
    service.setReminderHandler(async (_task, message) => {
      delivered.push(message);
    });
    const task = await service.createTask({
      sessionId: "catchup-ontime",
      title: "喝水提醒",
      description: "喝水提醒",
      kind: "reminder",
      runAt: new Date(Date.now() + 10_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "该喝水了",
    });
    backdateNextRunAt(service, task.taskId, Date.now() - 1_000);

    await service.runSchedulerTick();
    const message = await waitFor(() => delivered[0]);
    assert.ok(!message.includes("【补发】"), `准点触发不应带补发前缀，实际：${message}`);
    const run = await waitFor(() => service.listRuns(task.taskId)[0]);
    assert.equal(run.status, "success");
    assert.equal((run.output as { catchUp?: boolean }).catchUp, undefined);
  });
});

test("窗内补发：agent_task 注入原定时间锚点的补发语境", async () => {
  await withTempScheduleFile(async (service) => {
    const prompts: string[] = [];
    service.setAgentTaskHandler(async (task) => {
      prompts.push(task.agentTask?.prompt ?? "");
      return { type: "agent_task", ok: true };
    });
    const task = await service.createTask({
      sessionId: "catchup-agent",
      title: "科技早报",
      description: "科技早报",
      kind: "agent_task",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      agentTask: { prompt: "给我一份科技早报" },
    });
    const plannedAt = Date.now() - 45 * 60_000;
    backdateNextRunAt(service, task.taskId, plannedAt);

    await service.runSchedulerTick();
    const prompt = await waitFor(() => prompts[0]);
    assert.ok(prompt.includes("补发任务"), `应注入补发语境：${prompt}`);
    assert.ok(prompt.includes("给我一份科技早报"), `原 prompt 应保留：${prompt}`);
    assert.ok(prompt.includes(new Date(plannedAt).toISOString().slice(0, 10)), `应含原定时间：${prompt}`);
  });
});

test("超窗：不执行、记 missed、单次任务收口、通知恰好一次", async () => {
  await withTempScheduleFile(async (service) => {
    let handlerFired = 0;
    let missedNotifications = 0;
    service.setReminderHandler(async () => {
      handlerFired += 1;
    });
    service.setTaskMissedHandler((_task, plannedAt) => {
      missedNotifications += 1;
      assert.ok(plannedAt, "missed 通知应携带原定时间");
    });
    const task = await service.createTask({
      sessionId: "catchup-stale",
      title: "过期提醒",
      description: "过期提醒",
      kind: "reminder",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "早就过期的提醒",
    });
    // 离线 25 小时（> 24h 补发窗口）
    backdateNextRunAt(service, task.taskId, Date.now() - 25 * 3_600_000);

    await service.runSchedulerTick();
    await waitFor(() => service.listRuns(task.taskId)[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(handlerFired, 0, "超窗不得执行提醒");
    assert.equal(missedNotifications, 1, "超窗通知应恰好一次");
    const run = service.listRuns(task.taskId)[0];
    assert.equal(run?.status, "missed");
    assert.equal(service.getTask(task.taskId)?.status, "completed");
    assert.equal(service.getTask(task.taskId)?.nextRunAt, null);
  });
});

test("超窗：周期任务推进到未来槽位且只记一次 missed", async () => {
  await withTempScheduleFile(async (service) => {
    let missedNotifications = 0;
    service.setReminderHandler(async () => {});
    service.setTaskMissedHandler(() => {
      missedNotifications += 1;
    });
    // 每日 08:00（Asia/Shanghai）的任务，nextRunAt 已是 25 小时前的一个旧槽位
    const task = await service.createTask({
      sessionId: "catchup-daily",
      title: "每日早报",
      description: "每日早报",
      kind: "reminder",
      runAt: "2099-01-01T08:00:00",
      recurrence: "daily",
      timezone: "Asia/Shanghai",
      reminderMessage: "早报到",
    });
    backdateNextRunAt(service, task.taskId, Date.now() - 25 * 3_600_000);

    await service.runSchedulerTick();
    await waitFor(() => service.listRuns(task.taskId)[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(missedNotifications, 1, "连环陈旧槽位只应通知一次");
    const missedRuns = service.listRuns(task.taskId).filter((r) => r.status === "missed");
    assert.equal(missedRuns.length, 1, "连环陈旧槽位只应记一次 missed");
    const after = service.getTask(task.taskId);
    assert.equal(after?.status, "active", "周期任务补发超窗后仍应继续调度");
    const nextMs = new Date(after?.nextRunAt ?? "").getTime();
    assert.ok(Number.isFinite(nextMs) && nextMs > Date.now(), "nextRunAt 应推进到未来");
  });
});
