import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { MASTER_CHAT_SESSION_PREFIX, NOTES_CHAT_SESSION_PREFIX } from "../agent/master-chat-session.js";
import { mergeActorThreadIntoMasterThread } from "./chat-thread-merge.js";
import { compactValidChatMessages, repairKimiAssistantToolCallReasoning, sanitizeToolCallMessageChain } from "./chat-thread-sanitize.js";

const PE_SESSION_MARKER = "\u007fpe\u007f";

type PersistedSession = {
  updatedAt: string;
  messages: ChatCompletionMessageParam[];
};

type PersistedShape = {
  sessions: Record<string, PersistedSession>;
};

function envPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isChatThreadPersistenceEnabled(): boolean {
  const raw = process.env.AGENT_CHAT_THREAD_PERSIST?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  return true;
}

export function getChatThreadPersistMaxMessages(): number {
  return envPositiveInt(process.env.AGENT_CHAT_THREAD_PERSIST_MAX_MESSAGES, 16);
}

/**
 * 仅持久化用户主会话线程，排除子 Agent、Plan-Execute 临时 session 等。
 *
 * Notes 线程（`notes:{actorId}`）同样持久化，但走独立的 `chat-threads-notes.json` 文件，
 * 保证与主会话物理隔离。
 */
export function shouldPersistChatThread(sessionId: string): boolean {
  if (!isChatThreadPersistenceEnabled()) return false;
  const id = sessionId.trim();
  if (!id) return false;
  if (id.startsWith("subagent-")) return false;
  if (id.includes(PE_SESSION_MARKER)) return false;
  if (id.startsWith("master-delegate:")) return false;
  // 笔记/学习线程走独立文件
  if (id.startsWith(NOTES_CHAT_SESSION_PREFIX)) return true;
  // 主 Agent 模式下裸 actorId 线程已废弃，避免与 master:{actorId} 分裂
  if (
    getAgentRuntimeConfig().masterDelegation.enabled &&
    !id.startsWith(MASTER_CHAT_SESSION_PREFIX) &&
    !id.includes(":")
  ) {
    return false;
  }
  return true;
}

/** 笔记线程使用独立文件，与主会话分离存储。 */
export function isNotesThreadSessionId(sessionId: string): boolean {
  return sessionId.startsWith(NOTES_CHAT_SESSION_PREFIX);
}

function tailMessages(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): ChatCompletionMessageParam[] {
  if (messages.length <= maxMessages) return messages;

  const groups: ChatCompletionMessageParam[][] = [];
  let i = messages.length - 1;

  while (i >= 0) {
    const msg = messages[i];
    if (!msg || typeof msg.role !== "string") {
      i--;
      continue;
    }
    if (msg.role === "tool") {
      const group: ChatCompletionMessageParam[] = [];
      while (i >= 0) {
        const toolMsg = messages[i];
        if (!toolMsg || toolMsg.role !== "tool") break;
        group.unshift(toolMsg);
        i--;
      }
      if (i >= 0 && messages[i].role === "assistant") {
        const assistantMsg = messages[i];
        const hasToolCalls = Array.isArray((assistantMsg as { tool_calls?: unknown }).tool_calls);
        if (hasToolCalls) {
          group.unshift(assistantMsg);
          i--;
        }
      }
      if (group.some((m) => m.role === "assistant")) {
        groups.unshift(group);
      } else if (group.length > 0) {
        console.warn(
          `[chat-thread-persist] Dropping orphan tool group (${group.length} messages) during tail trim`,
        );
      }
    } else {
      groups.unshift([msg]);
      i--;
    }
  }

  const result: ChatCompletionMessageParam[] = [];
  let total = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    if (total + groups[g].length > maxMessages) continue;
    result.unshift(...groups[g]);
    total += groups[g].length;
  }

  return result;
}

/**
 * 服务端多轮对话线程落盘（重启后恢复最近 N 条非 system 消息）。
 *
 * Notes 线程（`notes:{actorId}`）使用独立落盘文件 `chat-threads-notes.json`，
 * 与主会话文件 `chat-threads.json` 物理隔离。两份数据通过不同的
 * 内存 store / file path 隔离，但共用同一份 schema。
 */
export class ChatThreadPersistence {
  private readonly filePath: string;
  private readonly notesFilePath: string;
  private data: PersistedShape = { sessions: {} };
  private notesData: PersistedShape = { sessions: {} };
  private notesDataWasFlushedOnce = false;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly debounceMs = 250;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(filePath?: string, notesFilePath?: string) {
    const defaultDir = join(process.cwd(), "data");
    this.filePath =
      filePath?.trim() ||
      process.env.AGENT_CHAT_THREAD_PERSIST_FILE?.trim() ||
      join(defaultDir, "chat-threads.json");
    this.notesFilePath =
      notesFilePath?.trim() ||
      process.env.AGENT_CHAT_THREAD_PERSIST_NOTES_FILE?.trim() ||
      join(defaultDir, "chat-threads-notes.json");
  }

  /** 当前实例的物理落盘路径（仅用于单测 / 调试）。 */
  getFilePath(): string {
    return this.filePath;
  }

  getNotesFilePath(): string {
    return this.notesFilePath;
  }

  private pickStore(sessionId: string): PersistedShape {
    return isNotesThreadSessionId(sessionId) ? this.notesData : this.data;
  }

  async load(): Promise<void> {
    await Promise.all([this.loadOne(this.filePath, false), this.loadOne(this.notesFilePath, true)]);
  }

  private async loadOne(path: string, isNotes: boolean): Promise<void> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (!parsed?.sessions || typeof parsed.sessions !== "object") return;
      if (isNotes) {
        this.notesData = parsed;
      } else {
        this.data = parsed;
        this.sanitizeAllPersistedSessions();
        this.migrateSplitActorThreads();
      }
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw e;
    }
  }

  /** 启动时修复已落盘的损坏 tool 链，避免下次对话继续 400。 */
  private sanitizeAllPersistedSessions(): void {
    let changed = false;
    for (const [sessionId, row] of Object.entries(this.data.sessions)) {
      if (!row?.messages?.length) continue;
      const sanitized = sanitizeToolCallMessageChain(row.messages, "[chat-thread-persist-load]");
      if (sanitized.length !== row.messages.length) {
        console.warn(
          `[chat-thread-persist] Repaired session ${sessionId} on load: ` +
          `${row.messages.length} → ${sanitized.length} messages`,
        );
        row.messages = sanitized;
        row.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      void this.flushToDisk();
    }
  }

  /** 将裸 actorId 线程合并进 `master:{actorId}` 并落盘一次。 */
  private migrateSplitActorThreads(): void {
    const masterIds = Object.keys(this.data.sessions).filter((id) =>
      id.startsWith(MASTER_CHAT_SESSION_PREFIX),
    );
    let changed = false;
    for (const masterId of masterIds) {
      const actorId = masterId.slice(MASTER_CHAT_SESSION_PREFIX.length);
      if (!actorId) continue;
      const rawRow = this.data.sessions[actorId];
      const masterRow = this.data.sessions[masterId];
      if (!rawRow?.messages?.length) continue;
      const merged = mergeActorThreadIntoMasterThread(
        rawRow.messages,
        masterRow?.messages ?? [],
      );
      this.data.sessions[masterId] = {
        updatedAt: new Date().toISOString(),
        messages: merged,
      };
      delete this.data.sessions[actorId];
      changed = true;
    }
    if (changed) {
      void this.flushToDisk();
    }
  }

  loadRestoredMessages(sessionId: string): ChatCompletionMessageParam[] | null {
    if (!shouldPersistChatThread(sessionId)) return null;
    const store = this.pickStore(sessionId);
    const row = store.sessions[sessionId];
    if (!row?.messages?.length) return null;
    const max = getChatThreadPersistMaxMessages();
    const raw = tailMessages(
      row.messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool"),
      max,
    );
    const sanitized = repairKimiAssistantToolCallReasoning(
      sanitizeToolCallMessageChain(raw, "[chat-thread-persist]"),
    );
    if (sanitized.length !== raw.length) {
      console.warn(
        `[chat-thread-persist] Session ${sessionId}: sanitized ${raw.length - sanitized.length} ` +
        `orphan tool/assistant messages from persisted history (was ${raw.length}, now ${sanitized.length}).`,
      );
    }
    return sanitized;
  }

  scheduleSave(sessionId: string, threadMessages: ChatCompletionMessageParam[]): void {
    if (!shouldPersistChatThread(sessionId)) return;
    const nonSystem = threadMessages.filter((m) => m.role !== "system");
    if (nonSystem.length === 0) return;

    const prev = this.debounceTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      const sanitized = sanitizeToolCallMessageChain(nonSystem, "[chat-thread-persist-save]");
      const snapshot = tailMessages(sanitized, getChatThreadPersistMaxMessages());
      this.persistChain = this.persistChain.then(() => this.writeSession(sessionId, snapshot));
    }, this.debounceMs);
    this.debounceTimers.set(sessionId, timer);
  }

  deleteSession(sessionId: string): void {
    const store = this.pickStore(sessionId);
    delete store.sessions[sessionId];
    const prev = this.debounceTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    this.debounceTimers.delete(sessionId);
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
  }

  private async writeSession(
    sessionId: string,
    messages: ChatCompletionMessageParam[],
  ): Promise<void> {
    const store = this.pickStore(sessionId);
    store.sessions[sessionId] = {
      updatedAt: new Date().toISOString(),
      messages,
    };
    await this.flushToDisk();
  }

  private async flushToDisk(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    // 仅在 notes 存储非空时落盘
    if (Object.keys(this.notesData.sessions).length > 0 || this.notesDataWasFlushedOnce) {
      this.notesDataWasFlushedOnce = true;
      await mkdir(dirname(this.notesFilePath), { recursive: true });
      await writeFile(this.notesFilePath, `${JSON.stringify(this.notesData, null, 2)}\n`, "utf8");
    }
  }
}

let sharedPersistence: ChatThreadPersistence | null = null;

export function getChatThreadPersistence(): ChatThreadPersistence {
  if (!sharedPersistence) {
    sharedPersistence = new ChatThreadPersistence();
  }
  return sharedPersistence;
}

export function resetChatThreadPersistenceForTests(): void {
  sharedPersistence = null;
}
