import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  MASTER_CHAT_SESSION_PREFIX,
  legacyMasterDelegateSessionId,
  masterChatSessionId,
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

/**
 * 主会话收养（2026-08-29 master 委派层删除后的所有权迁移）：
 * 裸 `actorId` 是唯一主线程；内存中缺失时从存量 `master:{actorId}` 线程**复制**收养。
 * 复制而非移动：旧 master: 条目原样保留，回滚（重新启用委派）后历史不丢。
 */
export function adoptPrimaryThreadFromMasterThread(
  history: Map<string, ChatCompletionMessageParam[]>,
  sessionId: string,
): ChatCompletionMessageParam[] | undefined {
  if (!sessionId || sessionId.includes(":")) return undefined;
  if (history.has(sessionId)) return undefined;
  const masterThread = history.get(masterChatSessionId(sessionId));
  if (!masterThread?.length) return undefined;
  history.set(sessionId, masterThread);
  return masterThread;
}
