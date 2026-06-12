/**
 * 日程创建去重：同一轮（chatUserMessageId）+ 相似内容只创建一次。
 * 跨轮（用户主动说「再设一个」）必须能正常创建。
 * 防止 reminder.plan / calendar.create_from_text / calendar.create_task 在同一轮被多次调用导致重复创建。
 */
const SCHEDULE_CREATE_DEDUP_TTL_MS = 30_000; // 30s 内同 round 重复去重

interface ScheduleCreateDedupEntry {
  result: Record<string, unknown>;
  ts: number;
}

const scheduleCreateDedupCache = new Map<string, ScheduleCreateDedupEntry>();

/** 清理过期条目 */
export function cleanScheduleCreateDedupCache(): void {
  const now = Date.now();
  for (const [key, entry] of scheduleCreateDedupCache) {
    if (now - entry.ts > SCHEDULE_CREATE_DEDUP_TTL_MS) {
      scheduleCreateDedupCache.delete(key);
    }
  }
}

/**
 * 检查并记录日程创建去重。
 * @param roundId 通常为 context.chatUserMessageId || context.sessionId
 * @param contentKey 用于区分不同内容的 key（如 title + runAt 的前缀）
 * @returns 缓存命中时返回缓存结果（含 deduped=true），未命中返回 null
 */
export function checkScheduleCreateDedup(
  roundId: string,
  contentKey: string,
): (Record<string, unknown> & { deduped: true }) | null {
  cleanScheduleCreateDedupCache();
  const dedupKey = `${roundId}:${contentKey}`;
  const cached = scheduleCreateDedupCache.get(dedupKey);
  if (cached) {
    return { ...cached.result, deduped: true };
  }
  return null;
}

/**
 * 写入日程创建去重缓存。
 * @param roundId 同上
 * @param contentKey 同上
 * @param result 工具返回值
 */
export function setScheduleCreateDedup(
  roundId: string,
  contentKey: string,
  result: Record<string, unknown>,
): void {
  const dedupKey = `${roundId}:${contentKey}`;
  scheduleCreateDedupCache.set(dedupKey, { result, ts: Date.now() });
}
