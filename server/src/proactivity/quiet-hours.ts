/**
 * 静默时段（Quiet Hours）—— 三处硬编码（arbiter / arbiter-v2 / frequency-governor）
 * 收敛为单一事实源，支持 env 覆盖：
 *   PROACTIVITY_QUIET_START（默认 23） / PROACTIVITY_QUIET_END（默认 7）
 * 服务器本地时区；跨午夜区间（start > end）与同日区间（start < end）均支持。
 */

function envHour(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) return fallback;
  return parsed;
}

const START = envHour("PROACTIVITY_QUIET_START", 23);
const END = envHour("PROACTIVITY_QUIET_END", 7);

export function quietHourWindow(): { start: number; end: number } {
  return { start: START, end: END };
}

/** 给定小时是否处于静默时段 */
export function isQuietHour(hour: number): boolean {
  if (START === END) return false; // 配置为 0 点差 = 关闭静默
  if (START > END) return hour >= START || hour < END; // 跨午夜（默认 23-7）
  return hour >= START && hour < END;
}

export function isQuietHourNow(d: Date): boolean {
  return isQuietHour(d.getHours());
}

/** 下一个静默结束时刻（静默期提案 defer 到早晨，而非丢弃）；返回 epoch ms */
export function nextQuietEnd(from: Date): number {
  const end = new Date(from);
  end.setHours(END, 0, 0, 0);
  if (end.getTime() <= from.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime();
}
