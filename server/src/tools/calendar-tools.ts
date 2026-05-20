/**
 * 内置 Calendar 工具：在对话中把「定时提醒 / 日程」落到服务端 `ScheduleTaskService`，
 * 与 Web 聊天里用自然语言建日程、`/chat/schedule-draft` 同源解析（`calendar.create_from_text`）。
 */
import { resolveActorId } from "../agent/actor-id.js";
import type { ScheduleIntentService } from "../services/schedule-intent-service.js";
import type { ScheduleDraft } from "../services/schedule-intent-service.js";
import type { CreateScheduleTaskInput, ScheduleTaskService } from "../services/schedule-task-service.js";
import { toolResultFromScheduleParse } from "./schedule-create-guard.js";
import type { ToolRegistry } from "./tool-registry.js";

export function buildScheduleCreateInput(
  draft: ScheduleDraft,
  sessionId: string,
  timezone: string,
): CreateScheduleTaskInput {
  const tz = timezone.trim() || "Asia/Shanghai";
  if (draft.kind === "reminder") {
    return {
      sessionId,
      title: draft.title,
      description: draft.description,
      kind: "reminder",
      runAt: draft.runAt,
      recurrence: draft.recurrence,
      timezone: tz,
      reminderMessage: draft.reminderMessage?.trim() || draft.description,
    };
  }
  if (draft.kind === "action") {
    if (!draft.action?.url) {
      throw new Error("动作任务缺少 action.url");
    }
    return {
      sessionId,
      title: draft.title,
      description: draft.description,
      kind: "action",
      runAt: draft.runAt,
      recurrence: draft.recurrence,
      timezone: tz,
      action: draft.action,
    };
  }
  return {
    sessionId,
    title: draft.title,
    description: draft.description,
    kind: "weather_brief",
    runAt: draft.runAt,
    recurrence: draft.recurrence,
    timezone: tz,
  };
}

export function registerCalendarTools(
  registry: ToolRegistry,
  scheduleTaskService: ScheduleTaskService,
  scheduleIntentService: ScheduleIntentService,
): void {
  registry.register("calendar.create_from_text", async (input, context) => {
    const text = String(input.text ?? "").trim();
    if (!text) return { ok: false, error: "text 不能为空" };
    const sessionId = resolveActorId(context);
    const tz = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const parsed = await scheduleIntentService.parseForCreate(sessionId, text);
    const guarded = toolResultFromScheduleParse(parsed);
    if (!guarded.proceed) {
      return guarded.result;
    }
    const draft = guarded.draft;
    try {
      const payload = buildScheduleCreateInput(draft, sessionId, tz);
      const task = await scheduleTaskService.createTask(payload);
      return {
        ok: true,
        matched: true,
        taskId: task.taskId,
        title: task.title,
        kind: task.kind,
        nextRunAt: task.nextRunAt,
        recurrence: task.recurrence,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("calendar.create_task", async (input, context) => {
    const sessionId = resolveActorId(context);
    const title = String(input.title ?? "").trim();
    const description = String(input.description ?? "").trim();
    const runAt = String(input.runAt ?? "").trim();
    const kindRaw = String(input.kind ?? "reminder").trim();
    const recurrenceRaw = String(input.recurrence ?? "none").trim();
    const timezone = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    if (!title || !description || !runAt) {
      return { ok: false, error: "title、description、runAt（ISO 时间字符串）必填" };
    }
    if (kindRaw !== "reminder" && kindRaw !== "action" && kindRaw !== "weather_brief") {
      return { ok: false, error: "kind 须为 reminder、action 或 weather_brief" };
    }
    if (!["none", "daily", "weekly"].includes(recurrenceRaw)) {
      return { ok: false, error: "recurrence 须为 none、daily 或 weekly" };
    }
    const recurrence = recurrenceRaw as "none" | "daily" | "weekly";
    try {
      if (kindRaw === "reminder") {
        const reminderMessage = String(input.reminderMessage ?? description).trim();
        const task = await scheduleTaskService.createTask({
          sessionId,
          title,
          description,
          kind: "reminder",
          runAt,
          recurrence,
          timezone,
          reminderMessage,
        });
        return {
          ok: true,
          taskId: task.taskId,
          title: task.title,
          kind: task.kind,
          nextRunAt: task.nextRunAt,
          recurrence: task.recurrence,
        };
      }
      if (kindRaw === "weather_brief") {
        const task = await scheduleTaskService.createTask({
          sessionId,
          title,
          description,
          kind: "weather_brief",
          runAt,
          recurrence,
          timezone,
        });
        return {
          ok: true,
          taskId: task.taskId,
          title: task.title,
          kind: task.kind,
          nextRunAt: task.nextRunAt,
          recurrence: task.recurrence,
        };
      }
      const actionIn = input.action as Record<string, unknown> | undefined;
      const url = String(actionIn?.url ?? input.actionUrl ?? "").trim();
      if (!url) return { ok: false, error: "action 任务需提供 action.url 或 actionUrl" };
      const methodRaw = String(actionIn?.method ?? input.actionMethod ?? "POST").toUpperCase();
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodRaw)
        ? (methodRaw as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
        : "POST";
      const task = await scheduleTaskService.createTask({
        sessionId,
        title,
        description,
        kind: "action",
        runAt,
        recurrence,
        timezone,
        action: { url, method, body: actionIn?.body },
      });
      return {
        ok: true,
        taskId: task.taskId,
        title: task.title,
        kind: task.kind,
        nextRunAt: task.nextRunAt,
        recurrence: task.recurrence,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("calendar.list_tasks", async (input, context) => {
    const sessionId = resolveActorId(context);
    const from =
      input.from != null && String(input.from).trim()
        ? String(input.from).trim()
        : new Date(Date.now() - 2 * 86400000).toISOString();
    const to =
      input.to != null && String(input.to).trim()
        ? String(input.to).trim()
        : new Date(Date.now() + 120 * 86400000).toISOString();
    const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
    return {
      ok: true,
      from,
      to,
      count: tasks.length,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        kind: t.kind,
        status: t.status,
        recurrence: t.recurrence,
        nextRunAt: t.nextRunAt,
        runAt: t.runAt,
        timezone: t.timezone,
      })),
    };
  });
}
