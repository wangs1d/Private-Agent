import type { ScheduleRecurrence, ScheduleTaskRecord } from "./schedule-task-service.js";

/** 用 runAt 的本地时刻作为重复模板（时、分），在区间内生成各次执行时刻（UTC ms）。 */
export function expandTaskOccurrenceTimes(
  task: Pick<ScheduleTaskRecord, "runAt" | "recurrence" | "status">,
  fromMs: number,
  toMs: number,
): number[] {
  if (task.status === "cancelled") return [];
  const anchor = new Date(task.runAt);
  if (Number.isNaN(anchor.getTime())) return [];

  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const d = anchor.getDate();
  const hh = anchor.getHours();
  const mm = anchor.getMinutes();
  const ss = anchor.getSeconds();
  const ms = anchor.getMilliseconds();

  const mk = (year: number, month: number, day: number) =>
    new Date(year, month, day, hh, mm, ss, ms).getTime();

  if (task.recurrence === "none") {
    const t = anchor.getTime();
    return t >= fromMs && t <= toMs ? [t] : [];
  }

  const out: number[] = [];
  const fromDay = new Date(fromMs);
  fromDay.setHours(0, 0, 0, 0);
  const toDay = new Date(toMs);
  toDay.setHours(23, 59, 59, 999);

  for (
    let cursor = new Date(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate());
    cursor.getTime() <= toDay.getTime();
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const cy = cursor.getFullYear();
    const cm = cursor.getMonth();
    const cd = cursor.getDate();

    if (task.recurrence === "daily") {
      pushIfInRange(out, mk(cy, cm, cd), fromMs, toMs);
      continue;
    }
    if (task.recurrence === "weekly") {
      if (cursor.getDay() !== anchor.getDay()) continue;
      pushIfInRange(out, mk(cy, cm, cd), fromMs, toMs);
      continue;
    }
    // yearly
    if (cm !== mo || cd !== d) continue;
    pushIfInRange(out, mk(cy, cm, cd), fromMs, toMs);
  }

  return out.sort((a, b) => a - b);
}

function pushIfInRange(out: number[], t: number, fromMs: number, toMs: number): void {
  if (t >= fromMs && t <= toMs) out.push(t);
}

export function taskHasOccurrenceInRange(
  task: ScheduleTaskRecord,
  fromMs: number,
  toMs: number,
): boolean {
  return expandTaskOccurrenceTimes(task, fromMs, toMs).length > 0;
}

export function recurrenceLabel(recurrence: ScheduleRecurrence): string {
  switch (recurrence) {
    case "daily":
      return "每天重复";
    case "weekly":
      return "每周重复";
    case "yearly":
      return "每年重复";
    default:
      return "单次提醒";
  }
}
