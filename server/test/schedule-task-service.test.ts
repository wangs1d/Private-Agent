import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleTaskService, type ScheduleTaskChangeAction } from "../src/services/schedule-task-service.js";

async function withTempScheduleFile<T>(fn: (service: ScheduleTaskService, filePath: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-task-service-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  const filePath = join(dir, "schedule-tasks.json");
  process.env.SCHEDULE_TASKS_FILE = filePath;
  try {
    const service = new ScheduleTaskService();
    return await fn(service, filePath);
  } finally {
    if (prev == null) {
      delete process.env.SCHEDULE_TASKS_FILE;
    } else {
      process.env.SCHEDULE_TASKS_FILE = prev;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("preserves absolute runAt values that already include timezone info", async () => {
  await withTempScheduleFile(async (service) => {
    const runAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const task = await service.createTask({
      sessionId: "session-1",
      title: "absolute time reminder",
      description: "absolute time reminder",
      kind: "reminder",
      runAt,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "absolute time reminder",
    });

    assert.equal(task.runAt, runAt);
    assert.equal(task.nextRunAt, runAt);
  });
});

test("parses local naive runAt in the provided timezone without shifting earlier", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "session-local",
      title: "local reminder",
      description: "local reminder",
      kind: "reminder",
      runAt: "2099-01-01T08:30:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "local reminder",
    });

    assert.equal(task.runAt, "2099-01-01T00:30:00.000Z");
  });
});

test("creates cron task and computes next run", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "session-cron",
      title: "cron reminder",
      description: "cron reminder",
      kind: "reminder",
      recurrence: "cron",
      cronExpression: "*/5 * * * *",
      timezone: "Asia/Shanghai",
      reminderMessage: "cron reminder",
    });

    assert.equal(task.recurrence, "cron");
    assert.equal(task.cronExpression, "*/5 * * * *");
    assert.ok(task.nextRunAt);
  });
});

test("triggers webhook task by token", async () => {
  await withTempScheduleFile(async (service) => {
    let fired = 0;
    service.setReminderHandler(async () => {
      fired += 1;
    });
    const task = await service.createTask({
      sessionId: "session-webhook",
      title: "webhook reminder",
      description: "webhook reminder",
      kind: "reminder",
      runAt: "2099-01-01T08:30:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      webhookToken: "hook-1",
      reminderMessage: "webhook reminder",
    });

    const triggered = await service.triggerByWebhookToken("hook-1");
    assert.equal(triggered.taskId, task.taskId);
    assert.equal(fired, 1);
  });
});

test("emits task change events for create update and delete", async () => {
  await withTempScheduleFile(async (service) => {
    const actions: ScheduleTaskChangeAction[] = [];
    service.setTaskChangeHandler(async (action) => {
      actions.push(action);
    });

    const task = await service.createTask({
      sessionId: "session-2",
      title: "change handler reminder",
      description: "change handler reminder",
      kind: "reminder",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "change handler reminder",
    });

    await service.updateTask(task.taskId, { title: "updated title" });
    await service.deleteTask(task.taskId);

    assert.deepEqual(actions, ["created", "updated", "deleted"]);
  });
});
