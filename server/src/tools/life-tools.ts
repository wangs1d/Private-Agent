import { resolveActorId } from "../agent/actor-id.js";
import {
  inferRecurrenceFromUserText,
  type ScheduleIntentService,
} from "../services/schedule-intent-service.js";
import type {
  ScheduleRecurrence,
  ScheduleTaskService,
} from "../services/schedule-task-service.js";
import { buildScheduleCreateInput, formatNextRunAtLocal } from "./calendar-tools.js";
import { toolResultFromScheduleParse } from "./schedule-create-guard.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerLifeTools(
  registry: ToolRegistry,
  scheduleTaskService: ScheduleTaskService,
  scheduleIntentService: ScheduleIntentService,
): void {
  registry.register("budget.calculate", async (input) => {
    const income = Number(input.income ?? 0);
    const rent = Number(input.rent ?? 0);
    const food = Number(input.food ?? 0);
    const transport = Number(input.transport ?? 0);
    const remain = income - rent - food - transport;
    return {
      summary: "预算计算完成",
      remain,
      advice: remain >= 0 ? "收支健康，可适度储蓄" : "收支为负，建议降低可选消费",
    };
  });

  registry.register("shopping.suggest", async (input) => {
    const item = String(input.item ?? "未知商品");
    const budget = Number(input.budget ?? 0);
    return {
      summary: "购物建议已生成",
      item,
      budget,
      suggestion: budget >= 200 ? "可选品质款，关注售后和保修" : "优先性价比款，注意核心参数",
    };
  });

  registry.register("reminder.plan", async (input, context) => {
    const sessionId = resolveActorId(context);
    const tz = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const text = String(input.text ?? "").trim();
    const subject = String(input.subject ?? "").trim();
    const date = String(input.date ?? "").trim();
    const parseSource = text || [date, subject].filter(Boolean).join(" ").trim();

    if (!parseSource) {
      const runAt = String(input.runAt ?? "").trim();
      const reminderMessage = String(input.reminderMessage ?? subject).trim() || "到点提醒";
      if (!runAt || !subject) {
        return {
          ok: false,
          error: "请提供 text（自然语言，含时间与事项），或同时提供 subject 与 date/runAt",
        };
      }
      const recurrenceRaw = String(input.recurrence ?? "none").trim();
      let recurrence: ScheduleRecurrence =
        recurrenceRaw === "daily" || recurrenceRaw === "weekly" || recurrenceRaw === "cron"
          ? recurrenceRaw
          : "none";
      const textForRecurrence = String(input.text ?? "").trim();
      if (textForRecurrence) {
        recurrence = inferRecurrenceFromUserText(textForRecurrence);
      }
      try {
        const task = await scheduleTaskService.createTask({
          sessionId,
          title: subject,
          description: subject,
          kind: "reminder",
          runAt,
          recurrence,
          timezone: tz,
          cronExpression: String(input.cronExpression ?? "").trim() || undefined,
          webhookToken: String(input.webhookToken ?? "").trim() || undefined,
          reminderMessage,
        });
        return {
          ok: true,
          matched: true,
          summary: "提醒已写入日程",
          taskId: task.taskId,
          title: task.title,
          kind: task.kind,
          nextRunAt: task.nextRunAt,
          nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, tz),
          recurrence: task.recurrence,
          reminderMessage,
          webhookToken: task.webhookToken,
          cronExpression: task.cronExpression,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    }

    const parsed = await scheduleIntentService.parseForCreate(
      sessionId,
      parseSource,
      { userTimezone: context.clientLocation?.timezone?.trim() || tz },
    );
    const guarded = toolResultFromScheduleParse(parsed);
    if (!guarded.proceed) {
      return guarded.result;
    }
    const draft = guarded.draft;
    if (draft.kind !== "reminder") {
      return {
        ok: true,
        matched: false,
        hint: `解析出了 ${draft.kind} 任务；若只需提醒请改用更明确的提醒表述，或使用 calendar.create_from_text。`,
      };
    }
    try {
      const payload = buildScheduleCreateInput(draft, sessionId, tz);
      const task = await scheduleTaskService.createTask(payload);
      return {
        ok: true,
        matched: true,
        summary: "提醒已写入日程",
        taskId: task.taskId,
        title: task.title,
        kind: task.kind,
        nextRunAt: task.nextRunAt,
        nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, tz),
        recurrence: task.recurrence,
        reminderMessage: task.reminderMessage ?? draft.reminderMessage,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });
}
