import type { ScheduleTaskService } from "./schedule-task-service.js";

const RECURRENCE_LABEL: Record<string, string> = {
  none: "单次",
  daily: "每天",
  weekly: "每周",
  yearly: "每年",
};

const SCHEDULE_RECALL_RE =
  /日程|提醒|安排|待办|计划|行程|会议|约会|闹钟|calendar|schedule|remind|todo|task/i;

const SCHEDULE_FAR_RANGE_RE =
  /明天|后天|下周|下个月|本月|本周|未来|之后|以后|全部|所有|最近几天|最近一周|长期|tomorrow|next week|next month|future|all/i;

export function shouldInjectScheduleSnapshot(userText: string | undefined): boolean {
  const text = userText?.trim() ?? "";
  return Boolean(text) && SCHEDULE_RECALL_RE.test(text);
}

export function shouldUseExtendedScheduleWindow(userText: string | undefined): boolean {
  const text = userText?.trim() ?? "";
  return Boolean(text) && SCHEDULE_FAR_RANGE_RE.test(text);
}

export function buildSchedulePromptSnapshot(
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
  userText?: string,
): string {
  const now = Date.now();
  const extended = shouldUseExtendedScheduleWindow(userText);
  const horizonDays = extended ? 7 : 1;
  const maxItems = extended ? 5 : 3;
  const from = new Date(now).toISOString();
  const to = new Date(now + horizonDays * 86_400_000).toISOString();
  const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
  const rangeLabel = extended ? `${horizonDays}d` : "today";

  if (tasks.length === 0) {
    return `SCH|range=${rangeLabel}|count=0`;
  }

  const lines = tasks.slice(0, maxItems).map((task) => {
    const when = task.nextRunAt ?? task.runAt;
    const recurrence = RECURRENCE_LABEL[task.recurrence] ?? task.recurrence;
    const title = task.reminderMessage?.trim() || task.title;
    return `- ${when}|${recurrence}|${title}`;
  });

  const hiddenCount = tasks.length - lines.length;
  const header = `SCH|range=${rangeLabel}|count=${tasks.length}|shown=${lines.length}|more=${Math.max(0, hiddenCount)}`;

  return [
    header,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}
