/**
 * 稳定用户标识：优先 WebSocket / 工具上下文中的 `userId`，否则回退 `sessionId`（兼容旧客户端）。
 * #8 隔离强化：`userId` / `sessionId` 均先 trim，纯空白视为缺失；两者皆空时回退到
 * 与 file-processing / voice-message 一致的身份哨兵 `anonymous`，避免返回空串导致
 * 无身份请求的记忆被收拢进同一 `""` 共享桶（跨请求串台）。
 */
export function resolveActorId(ctx: { userId?: string | undefined; sessionId: string }): string {
  const u = ctx.userId?.trim();
  if (u) return u;
  const s = ctx.sessionId?.trim();
  if (s) return s;
  return "anonymous";
}
