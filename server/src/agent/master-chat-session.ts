/** 主 Agent 与用户的多轮对话上下文统一使用该前缀（委派 / 直答共用一条线程）。 */
export const MASTER_CHAT_SESSION_PREFIX = "master:";

export function masterChatSessionId(actorId: string): string {
  return `${MASTER_CHAT_SESSION_PREFIX}${actorId}`;
}

/**
 * 用户主会话线程 id：启用主 Agent 委派时统一 `master:{actorId}`，否则裸 actorId。
 */
export function resolvePrimaryChatSessionId(
  actorId: string,
  masterDelegationEnabled: boolean,
): string {
  return masterDelegationEnabled ? masterChatSessionId(actorId) : actorId;
}

/** 旧版委派模式使用的 session 键（升级时合并到 {@link masterChatSessionId}）。 */
export function legacyMasterDelegateSessionId(actorId: string): string {
  return `master-delegate:${actorId}`;
}
