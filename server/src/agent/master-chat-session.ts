/** 主 Agent 与用户的多轮对话上下文统一使用该前缀（委派 / 直答共用一条线程）。 */
export const MASTER_CHAT_SESSION_PREFIX = "master:";

/** 笔记/学习专用对话线程前缀（与主会话物理隔离，记忆独立存储）。 */
export const NOTES_CHAT_SESSION_PREFIX = "notes:";

export function masterChatSessionId(actorId: string): string {
  return `${MASTER_CHAT_SESSION_PREFIX}${actorId}`;
}

/**
 * 笔记/学习专用对话线程 id：与主会话独立存储。Agent 可在主会话里通过
 * `notes_chat.recall_main` / `notes.recall_history` 跨上下文查阅。
 */
export function notesChatSessionId(actorId: string): string {
  return `${NOTES_CHAT_SESSION_PREFIX}${actorId}`;
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

/** 判定是否为笔记/学习专用 session。 */
export function isNotesChatSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(NOTES_CHAT_SESSION_PREFIX);
}
