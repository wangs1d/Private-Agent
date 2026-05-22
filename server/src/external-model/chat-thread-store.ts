import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { adoptLegacyMasterDelegateThread } from "./chat-thread-adopt.js";
import type { ChatThreadPersistence } from "./chat-thread-persist.js";
import { getChatThreadPersistence } from "./chat-thread-persist.js";
import type { ChatUserTurn } from "./types.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";

const DEFAULT_MAX_TURN_MESSAGES = 48;

export class ChatThreadStore {
  private readonly history = new Map<string, ChatCompletionMessageParam[]>();

  constructor(private readonly persistence: ChatThreadPersistence | null) {}

  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.persistence?.deleteSession(sessionId);
  }

  thread(sessionId: string, defaultSystemPrompt: string): ChatCompletionMessageParam[] {
    let t = this.history.get(sessionId);
    if (!t) {
      t = adoptLegacyMasterDelegateThread(this.history, sessionId);
    }
    if (!t && this.persistence) {
      const restored = this.persistence.loadRestoredMessages(sessionId);
      if (restored?.length) {
        t = [{ role: "system", content: defaultSystemPrompt }, ...restored];
        this.history.set(sessionId, t);
      }
    }
    if (!t) {
      t = [{ role: "system", content: defaultSystemPrompt }];
      this.history.set(sessionId, t);
    }
    return t;
  }

  trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number): void {
    const cap = maxMessages ?? DEFAULT_MAX_TURN_MESSAGES;
    if (msgs.length <= 1 + cap) return;
    const sys = msgs[0];
    const rest = msgs.slice(1).slice(-cap);
    msgs.length = 0;
    msgs.push(sys, ...rest);
  }

  appendTurn(
    sessionId: string,
    defaultSystemPrompt: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
  ): void {
    const trimmed = assistantText.trim();
    if (!trimmed) return;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    msgs.push({ role: "user", content: openAiUserContentFromTurn(userTurn) });
    msgs.push({ role: "assistant", content: trimmed });
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  afterTurnCompleted(sessionId: string, msgs: ChatCompletionMessageParam[]): void {
    this.persistence?.scheduleSave(sessionId, msgs);
  }
}

let sharedStore: ChatThreadStore | null = null;

export function getChatThreadStore(): ChatThreadStore {
  if (!sharedStore) {
    sharedStore = new ChatThreadStore(getChatThreadPersistence());
  }
  return sharedStore;
}

export function resetChatThreadStoreForTests(): void {
  sharedStore = null;
}
