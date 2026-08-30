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
 * 用户主会话线程 id。
 *
 * 2026-08-29 master 委派层删除：主会话统一回归裸 `actorId`，对话脑是主线程的
 * 唯一所有者与写者。`masterDelegationEnabled` 参数保留仅为调用方兼容，不再影响结果。
 * 存量 `master:{actorId}` 线程由 chat-thread-adopt 在首访裸会话时一次性收养（复制）。
 */
export function resolvePrimaryChatSessionId(
  actorId: string,
  _masterDelegationEnabled?: boolean,
): string {
  return actorId;
}

/** 旧版委派模式使用的 session 键（升级时合并到 {@link masterChatSessionId}）。 */
export function legacyMasterDelegateSessionId(actorId: string): string {
  return `master-delegate:${actorId}`;
}

/** 判定是否为笔记/学习专用 session。 */
export function isNotesChatSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(NOTES_CHAT_SESSION_PREFIX);
}
