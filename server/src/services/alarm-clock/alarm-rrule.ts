/**
 * 最小 RRULE（RFC5545）展开 —— 只支持本项目实际会用到的子集：
 *   FREQ=DAILY | WEEKLY | MONTHLY
 *   BYDAY=MO,TU,...,SU（WEEKLY 的"每周哪几天"；MONTHLY 忽略 BYDAY，按月同日）
 *   INTERVAL=n（缺省 1）
 *   UNTIL=YYYYMMDDTHHMMSS / COUNT=n
 *
 * 语义按"本地时钟"（跟当地 07:30，不跟绝对秒数），与手机端 Dart 侧实现一致；
 * DST 切换日不漂移。实现策略：从锚点起按发生序逐个枚举（顺序枚举天然保证
 * WEEKLY BYDAY 不漏跳、COUNT/UNTIL 语义精确），设 2 年硬上限防异常配置死循环。
 */
import type { AlarmRepeat } from "./alarm-types.js";

export type RruleParts = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byday: number[]; // 0=SU..6=SA（JS getDay 语义）
  untilMs: number | null;
  count: number | null;
};

const WEEKDAY_MAP: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 24 * 3600 * 1000;

export function parseRrule(rule: string | null | undefined): RruleParts | null {
  if (!rule) return null;
  const body = rule.trim().replace(/^RRULE:/i, "");
  if (!body) return null;
  const parts: Record<string, string> = {};
  for (const kv of body.split(";")) {
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    parts[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
  }
  const freqRaw = (parts.FREQ ?? "").toUpperCase();
  if (freqRaw !== "DAILY" && freqRaw !== "WEEKLY" && freqRaw !== "MONTHLY") return null;
  const interval = Math.max(1, Number.parseInt(parts.INTERVAL ?? "1", 10) || 1);
  const byday = (parts.BYDAY ?? "")
    .split(",")
    .map((s) => WEEKDAY_MAP[s.trim().toUpperCase()])
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  let untilMs: number | null = null;
  if (parts.UNTIL) {
    const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$/);
    if (m) {
      untilMs = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] ?? "23"), Number(m[5] ?? "59"), Number(m[6] ?? "59"),
      ).getTime();
      if (!Number.isFinite(untilMs)) untilMs = null;
    }
  }
  const countRaw = parts.COUNT ? Number.parseInt(parts.COUNT, 10) : NaN;
  const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : null;
  return { freq: freqRaw, interval, byday, untilMs, count };
}

/** 给定锚点时刻（首跳，本地时间语义）与当前时间，算下一跳 epoch ms；无下一跳返回 null */
export function nextRruleOccurrenceMs(repeat: AlarmRepeat, anchorMs: number, afterMs: number): number | null {
  const parts = parseRrule(repeat.rule);
  if (!parts) return null;
  if (parts.freq === "WEEKLY" && parts.byday.length === 0) return null;

  const anchor = new Date(anchorMs);
  const hardLimitMs = Math.max(afterMs, anchorMs) + 2 * 366 * DAY_MS;
  let occurred = 0; // 已发生的次数（含锚点本身），COUNT 判定用

  // 统一的"第 i 个候选日"迭代器：i=0 即锚点日
  const candidateAt = (dayIndex: number): number | null => {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + dayIndex, anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), 0);
    return d.getTime();
  };

  let i = 0;
  while (i < 1500) {
    const t = candidateAt(i);
    if (t === null || t > hardLimitMs) return null;

    if (parts.freq === "DAILY") {
      i += parts.interval;
    } else if (parts.freq === "WEEKLY") {
      i += 1; // 逐日扫，命中判断在下方
    } else {
      // MONTHLY：直接跳到下个同日
      const cur = new Date(t);
      const nextMonthSameDay = new Date(cur.getFullYear(), cur.getMonth() + parts.interval, Math.min(cur.getDate(), 28), cur.getHours(), cur.getMinutes(), cur.getSeconds(), 0);
      i = Math.round((nextMonthSameDay.getTime() - new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()).getTime()) / DAY_MS);
      if (i <= 0) return null;
    }

    // WEEKLY 命中判定：该日处于 interval 周期且 BYDAY 命中
    if (parts.freq === "WEEKLY") {
      const weekIndex = Math.floor(dayDiffDays(anchorMs, t) / 7);
      if (weekIndex % parts.interval !== 0 || !parts.byday.includes(new Date(t).getDay())) continue;
    }

    // 锚点日当天但时刻早于锚点（如锚点 07:30、候选 07:30 相同则算锚点本身）
    if (t < anchorMs) continue;

    if (t <= afterMs) {
      occurred += 1;
      if (parts.count !== null && occurred >= parts.count) return null;
      if (parts.untilMs !== null && t > parts.untilMs) return null;
      continue;
    }
    // 第一个严格晚于 afterMs 的候选
    if (parts.untilMs !== null && t > parts.untilMs) return null;
    if (parts.count !== null && occurred + 1 > parts.count) return null;
    return t;
  }
  return null;
}

function dayDiffDays(fromMs: number, toMs: number): number {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((b0 - a0) / DAY_MS);
}

/** 触发后推进：返回下一跳 epoch ms（重复闹钟），单次返回 null */
export function advanceAlarmNextFireMs(repeat: AlarmRepeat, fireAtMs: number, nowMs: number): number | null {
  return nextRruleOccurrenceMs(repeat, fireAtMs, nowMs);
}
