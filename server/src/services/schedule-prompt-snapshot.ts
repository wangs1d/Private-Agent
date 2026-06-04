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
  const maxItems = extended ? 8 : 5;
  const from = new Date(now).toISOString();
  const to = new Date(now + horizonDays * 86400000).toISOString();
  const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });

  if (tasks.length === 0) {
    return extended
      ? "【当前日程 · 服务端实时】未来 7 天暂无活跃提醒或日程。"
      : "【今日日程 · 服务端实时】今天暂无活跃提醒或日程。";
  }

  const lines = tasks.slice(0, maxItems).map((task) => {
    const when = task.nextRunAt ?? task.runAt;
    const recurrence = RECURRENCE_LABEL[task.recurrence] ?? task.recurrence;
    const title = task.reminderMessage?.trim() || task.title;
    return `- ${title} | ${when} | ${recurrence}`;
  });

  const hiddenCount = tasks.length - lines.length;
  const header = extended
    ? `【当前日程 · 服务端实时】未来 ${horizonDays} 天共 ${tasks.length} 条活跃提醒或日程：`
    : `【今日日程 · 服务端实时】今天共 ${tasks.length} 条活跃提醒或日程：`;

  return [
    header,
    ...lines,
    hiddenCount > 0 ? `（另有 ${hiddenCount} 条未展开，需要更多时调用 calendar.list_tasks。）` : "",
    "回答日程相关问题时优先以这份快照为准；需要更远时间范围时再调用日程工具检索。",
  ]
    .filter(Boolean)
    .join("\n");
}
