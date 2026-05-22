import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  MASTER_CHAT_SESSION_PREFIX,
  legacyMasterDelegateSessionId,
} from "../agent/master-chat-session.js";

/**
 * 将旧版 `master-delegate:{actorId}` 线程迁入统一的 `master:{actorId}`，避免升级后短期记忆断裂。
 */
export function adoptLegacyMasterDelegateThread(
  history: Map<string, ChatCompletionMessageParam[]>,
  sessionId: string,
): ChatCompletionMessageParam[] | undefined {
  if (!sessionId.startsWith(MASTER_CHAT_SESSION_PREFIX)) return undefined;
  const actorId = sessionId.slice(MASTER_CHAT_SESSION_PREFIX.length);
  if (!actorId) return undefined;
  const legacyId = legacyMasterDelegateSessionId(actorId);
  const legacy = history.get(legacyId);
  if (!legacy) return undefined;
  history.set(sessionId, legacy);
  history.delete(legacyId);
  return legacy;
}
