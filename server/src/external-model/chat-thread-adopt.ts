import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  MASTER_CHAT_SESSION_PREFIX,
  legacyMasterDelegateSessionId,
} from "../agent/master-chat-session.js";
import { mergeActorThreadIntoMasterThread } from "./chat-thread-merge.js";

/**
 * 将旧版 `master-delegate:{actorId}` 或裸 `actorId` 线程迁入统一的 `master:{actorId}`，
 * 避免升级后 / 路由切换时短期对话上下文断裂。
 */
export function adoptLegacyMasterDelegateThread(
  history: Map<string, ChatCompletionMessageParam[]>,
  sessionId: string,
): ChatCompletionMessageParam[] | undefined {
  if (!sessionId.startsWith(MASTER_CHAT_SESSION_PREFIX)) return undefined;
  const actorId = sessionId.slice(MASTER_CHAT_SESSION_PREFIX.length);
  if (!actorId) return undefined;

  const legacyDelegate = history.get(legacyMasterDelegateSessionId(actorId));
  if (legacyDelegate) {
    history.set(sessionId, legacyDelegate);
    history.delete(legacyMasterDelegateSessionId(actorId));
    return legacyDelegate;
  }

  const rawActorThread = history.get(actorId);
  const masterThread = history.get(sessionId);

  if (rawActorThread && masterThread) {
    const merged = mergeActorThreadIntoMasterThread(rawActorThread, masterThread);
    history.set(sessionId, merged);
    history.delete(actorId);
    return merged;
  }

  if (rawActorThread) {
    history.set(sessionId, rawActorThread);
    history.delete(actorId);
    return rawActorThread;
  }

  return masterThread;
}
