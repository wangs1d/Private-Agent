/**
 * 稳定用户标识：优先 WebSocket / 工具上下文中的 `userId`，否则回退 `sessionId`（兼容旧客户端）。
 * #8 隔离强化：`userId` / `sessionId` 均先 trim，纯空白视为缺失；两者皆空时回退到
 * 与 file-processing / voice-message 一致的身份哨兵 `anonymous`，避免返回空串导致
 * 无身份请求的记忆被收拢进同一 `""` 共享桶（跨请求串台）。
 */

export const ANONYMOUS_ACTOR_ID = "anonymous";

export function resolveActorId(ctx: { userId?: string | undefined; sessionId: string }): string {
  const u = ctx.userId?.trim();
  if (u) return u;
  const s = ctx.sessionId?.trim();
  if (s) return s;
  return ANONYMOUS_ACTOR_ID;
}

/**
 * 匿名/临时身份判定：无 userId 且无 sessionId 的请求没有稳定身份，
 * 其"长期记忆"会落进共享桶造成跨请求串台。此类身份只允许会话内（短期）记忆，
 * 长期记忆读写一律拦截。
 */
export function isEphemeralActorId(actorId: string | undefined | null): boolean {
  const t = actorId?.trim();
  return !t || t === ANONYMOUS_ACTOR_ID;
}

const warnedEphemeralActors = new Set<string>();

/** 匿名身份触发长期记忆拦截时告警（每进程每身份只告警一次，避免刷日志）。 */
export function warnEphemeralActorMemoryBlocked(actorId: string, action: string): void {
  if (warnedEphemeralActors.has(actorId)) return;
  warnedEphemeralActors.add(actorId);
  console.warn(
    `[actor-id] 无稳定身份（actorId="${actorId}"）的${action}已被拦截：` +
      `客户端未传 userId/sessionId，长期记忆写入共享桶会导致跨请求串台。` +
      `请检查该链路是否遗漏身份字段。`,
  );
}
