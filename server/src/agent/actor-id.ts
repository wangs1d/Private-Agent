/**
 * 稳定用户标识：优先 WebSocket / 工具上下文中的 `userId`，否则回退 `sessionId`（兼容旧客户端）。
 */
export function resolveActorId(ctx: { userId?: string | undefined; sessionId: string }): string {
  const u = ctx.userId?.trim();
  if (u) return u;
  return ctx.sessionId;
}
