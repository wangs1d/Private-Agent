import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ScheduleTaskService } from "../src/services/schedule-task-service.js";

async function withScheduleService(
  fn: (service: ScheduleTaskService) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "schedule-task-service-"));
  const previousFile = process.env.SCHEDULE_TASKS_FILE;
  const previousAllowPrivate = process.env.SCHEDULE_ACTION_ALLOW_PRIVATE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  delete process.env.SCHEDULE_ACTION_ALLOW_PRIVATE;
  try {
    const service = new ScheduleTaskService();
    await fn(service);
  } finally {
    if (previousFile == null) {
      delete process.env.SCHEDULE_TASKS_FILE;
    } else {
      process.env.SCHEDULE_TASKS_FILE = previousFile;
    }
    if (previousAllowPrivate == null) {
      delete process.env.SCHEDULE_ACTION_ALLOW_PRIVATE;
    } else {
      process.env.SCHEDULE_ACTION_ALLOW_PRIVATE = previousAllowPrivate;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("agent_task runs its injected handler and completes one-shot tasks", async () => {
  await withScheduleService(async (service) => {
    const calls: string[] = [];
    service.setAgentTaskHandler(async (task) => {
      calls.push(task.agentTask?.prompt ?? "");
      return { ok: true, text: "done" };
    });

    const task = await service.createTask({
      sessionId: "u1",
      title: "Run agent",
      description: "Run an agent task",
      kind: "agent_task",
      runAt: futureIso(),
      recurrence: "none",
      agentTask: { prompt: "summarize my day" },
    });

    await service.triggerNow(task.taskId);

    assert.deepEqual(calls, ["summarize my day"]);
    assert.equal(service.getTask(task.taskId)?.status, "completed");
    const [run] = service.listRuns(task.taskId);
    assert.equal(run.status, "success");
    assert.deepEqual(run.output, { ok: true, text: "done" });
  });
});

test("yearly recurrence advances the next run by one UTC year", async () => {
  await withScheduleService(async (service) => {
    const task = await service.createTask({
      sessionId: "u1",
      title: "Birthday",
      description: "Birthday reminder",
      kind: "reminder",
      runAt: futureIso(),
      recurrence: "yearly",
      reminderMessage: "Birthday tomorrow",
    });
    const originalYear = new Date(task.nextRunAt!).getUTCFullYear();

    await service.triggerNow(task.taskId);

    const updated = service.getTask(task.taskId);
    assert.equal(updated?.status, "active");
    assert.equal(new Date(updated!.nextRunAt!).getUTCFullYear(), originalYear + 1);
  });
});

test("action tasks block localhost and private-network URLs by default", async () => {
  await withScheduleService(async (service) => {
    const task = await service.createTask({
      sessionId: "u1",
      title: "Webhook",
      description: "Call local webhook",
      kind: "action",
      runAt: futureIso(),
      recurrence: "none",
      action: { url: "http://127.0.0.1:65535/hook", method: "POST" },
    });

    await service.triggerNow(task.taskId);

    const [run] = service.listRuns(task.taskId);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /本机|内网|localhost/);
    assert.equal(service.getTask(task.taskId)?.status, "active");
  });
});
