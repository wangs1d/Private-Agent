import { isScheduleCreateToolName } from "./schedule-tool-names.js";

/** 到点提醒展示文案：补全过短的口语片段。 */
export function formatReminderDisplayMessage(subject: string): string {
  const s = subject.trim();
  if (!s) return "到点提醒";
  if (/喊我起床|叫我起床/.test(s)) return "该起床啦！";
  if (s === "喊我" || s === "叫我") return "该起床啦！";
  if (/吃药/.test(s)) return "该吃药啦";
  if (s.length >= 3) return s;
  return s;
}

function formatRunAtLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs > 0 && diffMs < 90_000) {
    const sec = Math.max(1, Math.round(diffMs / 1000));
    if (sec < 60) return `${sec} 秒后`;
    return `${Math.round(sec / 60)} 分钟后`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const today =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (today) return `今天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

/** 将日程/提醒工具结果转为用户可读的一句回复；无法格式化时返回 null。 */
export function formatScheduleToolResultForUser(
  toolName: string,
  result: Record<string, unknown>,
): string | null {
  if (!isScheduleCreateToolName(toolName)) return null;
  if (result.ok === false) {
    const err = String(result.error ?? "创建失败").trim();
    return `未能创建提醒：${err}`;
  }
  if (result.matched === true && result.taskId) {
    const when = result.nextRunAt ? formatRunAtLocal(String(result.nextRunAt)) : "";
    const msg = formatReminderDisplayMessage(
      String(result.reminderMessage ?? result.title ?? "提醒"),
    );
    return when ? `已设置提醒：${when} — ${msg}` : `已设置提醒：${msg}`;
  }
  if (result.needsRecurrenceConfirm === true) {
    return String(result.hint ?? "请说明这是一次性提醒，还是每天/每周重复。");
  }
  if (result.matched === false && result.hint) {
    return String(result.hint);
  }
  return null;
}
