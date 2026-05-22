/** 会写入 ScheduleTaskService 的日程/提醒工具（注册名，带点号）。 */
export const SCHEDULE_CREATE_TOOL_NAMES = new Set([
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.create_task",
]);

export function isScheduleCreateToolName(toolName: string): boolean {
  const n = toolName.trim();
  if (SCHEDULE_CREATE_TOOL_NAMES.has(n)) return true;
  const normalized = n.replace(/_/g, ".");
  return SCHEDULE_CREATE_TOOL_NAMES.has(normalized);
}
