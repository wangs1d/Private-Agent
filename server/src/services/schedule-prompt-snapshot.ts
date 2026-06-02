import type { ScheduleTaskService } from "./schedule-task-service.js";

const RECURRENCE_LABEL: Record<string, string> = {
  none: "单次",
  daily: "每天",
  weekly: "每周",
  yearly: "每年",
};

/**
 * 每轮对话注入的日程快照（读服务端 ScheduleTaskService，与 App「日程」页服务端数据一致）。
 */
export function buildSchedulePromptSnapshot(
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
): string {
  const now = Date.now();
  const from = new Date(now).toISOString();
  const to = new Date(now + 14 * 86400000).toISOString();
  const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });

  if (tasks.length === 0) {
    return [
      "【当前日程 · 服务端实时】暂无活跃提醒/日程（共 0 条）。",
      "用户可能在 App「日程」页已删除；回答日程相关问题以此为准，勿凭屏幕截图或对话历史中的旧列表作答。",
    ].join("\n");
  }

  const lines = tasks.slice(0, 15).map((t) => {
    const when = t.nextRunAt ?? t.runAt;
    const rec = RECURRENCE_LABEL[t.recurrence] ?? t.recurrence;
    const title = t.reminderMessage?.trim() || t.title;
    return `- ${title} · ${when} · ${rec}`;
  });
  const tail =
    tasks.length > 15
      ? `\n（另有 ${tasks.length - 15} 条，请调 calendar.list_tasks 查看完整列表）`
      : "";
  return [
    `【当前日程 · 服务端实时】共 ${tasks.length} 条活跃提醒/日程：`,
    ...lines,
    tail,
    "回答日程/提醒问题时优先参考本快照；用户可在 App「日程」页直接删改，勿凭截图或历史旧数据作答。",
  ]
    .filter(Boolean)
    .join("\n");
}
