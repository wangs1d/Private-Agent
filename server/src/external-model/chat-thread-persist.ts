import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { join } from "node:path";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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
 *
 * 2026-09-06 P3 修复：删除「masterDelegation 开启时裸 actorId 线程不落盘」的旧过滤。
 * 该过滤属于 2026-08-29 之前的契约（主线程还叫 `master:{actorId}`）；同日重构后
 * {@link resolvePrimaryChatSessionId} 已统一返回裸 actorId，本过滤却把**唯一的主会话
 * 线程**判为不持久化——chat-threads.json 的 sessions 长期为空、重启即丢全部对话
 * 历史（串台放大器：模型失去近期上下文后更依赖陈年记忆）。
 */
export function shouldPersistChatThread(sessionId: string): boolean {
  if (!isChatThreadPersistenceEnabled()) return false;
  const id = sessionId.trim();
  if (!id) return false;
  if (id.startsWith("subagent-")) return false;
  if (id.includes(PE_SESSION_MARKER)) return false;
  if (id.startsWith("master-delegate:")) return false;
  // 笔记/学习线程走独立文件（仍在主文件 handler 上游分流）
  if (id.startsWith(NOTES_CHAT_SESSION_PREFIX)) return true;
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
  /**
   * 启动竞态守卫（2026-09-08）：初始 load 未完成期间为非空 promise。
   * this.data 在 load 完成前是空骨架——此期间任何落盘都会用空 sessions
   * **全量覆写**已持久化的全部会话（实测 dev watch 重启后 chat-threads.json
   * 被清空、当晚对话上下文丢失）。写入方（scheduleSave/deleteSession/flushToDisk）
   * 必须先 await 本 gate。
   */
  private loadGate: Promise<void> | null = null;

  constructor(
    filePath?: string,
    notesFilePath?: string,
    /** 可注入的文件读取器（仅测试用它放慢 load、确定性复现竞态窗口）。 */
    private readonly readFileImpl: (path: string) => Promise<string> = (path) =>
      readFile(path, "utf8"),
  ) {
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
    // 幂等：boot 期间可能被多处触发，复用同一 gate；完成后清空，
    // 此后写入方走 whenLoaded() 的立即通过路径，零开销。
    if (this.loadGate) return this.loadGate;
    const gate = (async () => {
      await Promise.all([this.loadOne(this.filePath, false), this.loadOne(this.notesFilePath, true)]);
    })();
    this.loadGate = gate;
    void gate
      .finally(() => {
        if (this.loadGate === gate) this.loadGate = null;
      })
      .catch(() => {
        /* gate 自身的 rejection 由返回值传给调用方（bootLoads），此处不再重复处理 */
      });
    return gate;
  }

  /** 启动竞态守卫：初始 load 未完成时返回其 promise（写入方必须等待），否则立即通过。 */
  private whenLoaded(): Promise<void> {
    return this.loadGate ?? Promise.resolve();
  }

  private async loadOne(path: string, isNotes: boolean): Promise<void> {
    try {
      const raw = await this.readFileImpl(path);
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
      void (async () => {
        // 启动竞态守卫：先等 load 完成，再读写 this.data——否则写的是空骨架，
        // load 完成后该写入丢失，且 load 一完成就全量覆写掉已持久化的会话。
        await this.whenLoaded();
        const sanitized = sanitizeToolCallMessageChain(nonSystem, "[chat-thread-persist-save]");
        const snapshot = tailMessages(sanitized, getChatThreadPersistMaxMessages());
        // P3 修复：写盘失败必须打日志并保持链条存活。此前 rejection 存进
        // persistChain 无人消费——一次磁盘错误既静默丢弃本次保存，又让链上
        // 后续所有保存被 .then 跳过（持久化永久瘫痪且无任何日志）。
        this.persistChain = this.persistChain
          .then(() => this.writeSession(sessionId, snapshot))
          .catch((err) =>
            console.error(`[chat-thread-persist] 线程落盘失败（${this.filePath}）:`, err),
          );
      })().catch((err) =>
        console.error(`[chat-thread-persist] 线程落盘失败（${this.filePath}）:`, err),
      );
    }, this.debounceMs);
    this.debounceTimers.set(sessionId, timer);
  }

  deleteSession(sessionId: string): void {
    const prev = this.debounceTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    this.debounceTimers.delete(sessionId);
    // 启动竞态守卫：删除必须作用在 load 完成后的数据上——否则删的是空骨架，
    // load 完成后该会话在内存里“复活”，与调用方的清除意图相悖。
    void (async () => {
      await this.whenLoaded();
      const store = this.pickStore(sessionId);
      delete store.sessions[sessionId];
      this.persistChain = this.persistChain
        .then(() => this.flushToDisk())
        .catch((err) =>
          console.error(`[chat-thread-persist] 删除会话落盘失败（${this.filePath}）:`, err),
        );
    })().catch((err) =>
      console.error(`[chat-thread-persist] 删除会话处理失败（${this.filePath}）:`, err),
    );
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
    // 启动竞态守卫（兜底）：load 内部的修复写盘（sanitize/migrate）会走到这里，
    // 等 gate 解析后写的是已加载完成的完整数据——gate 的解析不依赖 flush 本身，
    // 无死锁；外部写入路径已在 scheduleSave/deleteSession 先行等待。
    await this.whenLoaded();
    await writeJsonAtomic(this.filePath, this.data);
    // 仅在 notes 存储非空时落盘
    if (Object.keys(this.notesData.sessions).length > 0 || this.notesDataWasFlushedOnce) {
      this.notesDataWasFlushedOnce = true;
      await writeJsonAtomic(this.notesFilePath, this.notesData);
    }
  }
}

let sharedPersistence: ChatThreadPersistence | null = null;

export function getChatThreadPersistence(): ChatThreadPersistence {
  if (!sharedPersistence) {
    sharedPersistence = new ChatThreadPersistence();
    // 单例创建即启动 load：竞态守卫从进程生命周期的最早时刻生效——
    // boot 里任何先于显式 load() 调用的写入路径也会等待加载完成。
    // 显式 load() 幂等复用同一 gate，rejection 仍会传给 bootLoads 启动链路。
    void sharedPersistence.load().catch(() => {});
  }
  return sharedPersistence;
}

export function resetChatThreadPersistenceForTests(): void {
  sharedPersistence = null;
}
