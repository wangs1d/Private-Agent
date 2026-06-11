import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { adoptLegacyMasterDelegateThread } from "./chat-thread-adopt.js";
import type { ChatThreadPersistence } from "./chat-thread-persist.js";
import { getChatThreadPersistence } from "./chat-thread-persist.js";
import type { ChatUserTurn } from "./types.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import {
  compactValidChatMessages,
  repairKimiAssistantToolCallReasoning,
  sanitizeToolCallMessageChain,
} from "./chat-thread-sanitize.js";

/**
 * 客户端生成的 messageId → 所属 thread 消息对象的反向索引。
 * 用 WeakMap 而非 Map：消息从 thread 中移除（删除/trim/重建）后随 GC 自动释放，不会泄漏；
 * 进程重启或从磁盘 reload 后旧消息没有 clientMessageId，无法编辑/删除，仅影响历史数据，可接受。
 */
const userMessageClientIdMap = new WeakMap<ChatCompletionMessageParam, string>();

export function tagUserMessageClientId(
  msg: ChatCompletionMessageParam,
  clientMessageId: string | undefined,
): void {
  if (clientMessageId) userMessageClientIdMap.set(msg, clientMessageId);
}

function readUserMessageClientId(msg: ChatCompletionMessageParam): string | undefined {
  return userMessageClientIdMap.get(msg);
}

function findUserMessageByClientId(
  thread: ChatCompletionMessageParam[],
  clientMessageId: string,
): { index: number; msg: ChatCompletionMessageParam } | null {
  if (!clientMessageId) return null;
  for (let i = 0; i < thread.length; i++) {
    const msg = thread[i];
    if (msg && msg.role === "user" && readUserMessageClientId(msg) === clientMessageId) {
      return { index: i, msg };
    }
  }
  return null;
}

const DEFAULT_SMART_TRIM_CONFIG = {
  maxMessages: parseInt(process.env.MAX_THREAD_MESSAGES ?? "20", 10),
  maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? "8000", 10),
  preserveRecentTurns: 4,
};

const TIME_FRAME_PREFIX = "[timeframe:";

/**
 * 单条消息时间戳前缀：固定在消息首行，供 LLM 精确关联时间维度。
 * 格式：`[ts:ISO_LOCAL|WEEKDAY|RELATIVE]`，例：`[ts:2026-06-10 14:35:22|周二|3m ago]`。
 * 兼容历史 `[timeframe:...]` 前缀（旧数据 strip 掉即可，新写入统一用 `ts:`）。
 */
const TS_FRAME_PREFIX = "[ts:";
const TS_FRAME_REGEX = /^\[ts:[^\]]+\]\n?/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function weekdayCn(date: Date): string {
  return WEEKDAY_CN[date.getDay()] ?? "";
}

function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = text.replace(/[\u4e00-\u9fa5]/g, " ").split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords * 0.25);
}

function estimateMessageTokens(msg: ChatCompletionMessageParam | null | undefined): number {
  if (!msg || typeof msg.role !== "string") return 0;
  let tokens = 2;
  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        tokens += estimateTokens((part as { text?: string }).text);
      } else if (part.type === "image_url") {
        tokens += 500;
      }
    }
  }
  if ("tool_calls" in msg && Array.isArray((msg as { tool_calls?: unknown[] }).tool_calls)) {
    tokens += 50 * ((msg as { tool_calls: unknown[] }).tool_calls?.length ?? 0);
  }
  if (msg.role === "tool" && typeof msg.content === "string") {
    tokens += Math.min(estimateTokens(msg.content), 1000);
  }
  return tokens;
}

function weekdayName(date: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()] ?? "Unknown";
}

function timeOfDayLabel(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "deep night";
  if (hour < 8) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function dayDiff(from: Date, to: Date): number {
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((toDay - fromDay) / 86_400_000);
}

function describeRelativeTime(at: Date, now = new Date()): string {
  const diffMs = now.getTime() - at.getTime();
  if (diffMs < 0) return "in the future";

  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = dayDiff(at, now);

  if (diffMinutes <= 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (sameLocalDay(at, now)) return `${diffHours}h ago`;
  if (diffDays === 1) return `yesterday ${timeOfDayLabel(at)}`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 14) return "last week";
  if (diffDays < 31) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 62) return "last month";
  return `${Math.floor(diffDays / 30)}mo ago`;
}

/** 构造 LLM 可见的时间戳前缀：`[ts:YYYY-MM-DD HH:MM:SS|周X|relative]`。 */
export function buildMessageTimestampPrefix(at: Date, now: Date = new Date()): string {
  return `${TS_FRAME_PREFIX}${formatLocalDateTime(at)}|${weekdayCn(at)}|${describeRelativeTime(at, now)}]`;
}

/** 提取消息首行的时间戳前缀；返回 null 表示无前缀。 */
export function readMessageTimestampPrefix(line: string): { prefix: string; rest: string } | null {
  const trimmed = line.trimStart();
  const tsMatch = trimmed.match(TS_FRAME_REGEX);
  if (tsMatch) {
    return { prefix: tsMatch[0].replace(/\n$/, ""), rest: trimmed.slice(tsMatch[0].length) };
  }
  if (trimmed.startsWith(TIME_FRAME_PREFIX)) {
    const newlineIdx = trimmed.indexOf("\n");
    const prefix = newlineIdx >= 0 ? trimmed.slice(0, newlineIdx) : trimmed;
    const rest = newlineIdx >= 0 ? trimmed.slice(newlineIdx + 1).trim() : "";
    return { prefix, rest };
  }
  return null;
}

/** 从 `[ts:YYYY-MM-DD HH:MM:SS|周X|relative]` 解析出原始 Date，便于持久化/排序。 */
export function parseMessageTimestamp(line: string): Date | null {
  const prefix = readMessageTimestampPrefix(line);
  if (!prefix) return null;
  const m = prefix.prefix.match(/\[ts:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|/);
  if (!m?.[1]) return null;
  const normalized = m[1].replace(" ", "T");
  const ts = Date.parse(normalized);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 从消息对象中尝试读取已注入的时间戳；用于恢复历史时保持原时间，避免重新打标后顺序乱跳。 */
function extractMessageTimestamp(msg: ChatCompletionMessageParam): Date | null {
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  if (typeof msg.content === "string") return parseMessageTimestamp(msg.content);
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const text = (part as { text?: string }).text ?? "";
        const ts = parseMessageTimestamp(text);
        if (ts) return ts;
      }
    }
  }
  return null;
}

/**
 * 供 Provider 在调 LLM 前给本轮 user 消息打时间戳前缀（避免「同 1 句用户话，下轮才看到时间」）。
 * 已有时间戳则不重复打，保持唯一。
 */
export function annotateUserContentForLlm(
  content: string | ChatCompletionMessageParam["content"],
  now: Date = new Date(),
): string | ChatCompletionContentPart[] {
  return annotateUserContentIfString(content, now, now);
}

/** 比较一条 user 消息的纯文本是否等于 `incoming`（去时间戳前缀后比较，避免重复追加）。 */
function userMessageTextMatches(msg: ChatCompletionMessageParam, incoming: string): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") {
    const parsed = readMessageTimestampPrefix(msg.content);
    return (parsed?.rest ?? msg.content).trim() === incoming.trim();
  }
  if (Array.isArray(msg.content)) {
    const first = msg.content[0];
    if (first && typeof first === "object" && (first as { type?: string }).type === "text") {
      const text = (first as { text?: string }).text ?? "";
      const parsed = readMessageTimestampPrefix(text);
      return (parsed?.rest ?? text).trim() === incoming.trim();
    }
  }
  return false;
}

/**
 * 在每条 user / assistant 消息首行注入精确时间戳（年/月/日/时/分/秒 + 星期 + 相对当前时间）。
 * 重复调用同一消息时自动用新时间刷新；兼容历史 `[timeframe:...]` 前缀。
 */
function annotateTimeframe(content: string, at: Date, now: Date = new Date()): string {
  const trimmed = content.trimStart();
  const existing = readMessageTimestampPrefix(trimmed);
  const rest = existing ? existing.rest : trimmed;
  const prefix = buildMessageTimestampPrefix(at, now);
  return `${prefix}\n${rest}`;
}

function annotateMessageIfNeeded(
  msg: ChatCompletionMessageParam,
  at: Date,
  now: Date = new Date(),
): ChatCompletionMessageParam {
  if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
    return { ...msg, content: annotateTimeframe(msg.content, at, now) };
  }
  return msg;
}

function annotateUserContentIfString(
  content: ChatCompletionMessageParam["content"],
  at: Date,
  now: Date = new Date(),
): string | ChatCompletionContentPart[] {
  if (typeof content === "string") return annotateTimeframe(content, at, now);
  if (Array.isArray(content) && content.length > 0) {
    // 多模态：仅在第一个 text part 注入时间戳，保留 image_url 等
    const parts: ChatCompletionContentPart[] = content.map((part, idx) => {
      if (idx === 0 && part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const text = (part as { text?: string }).text ?? "";
        return { ...(part as object), type: "text", text: annotateTimeframe(text, at, now) } as ChatCompletionContentPart;
      }
      return part as ChatCompletionContentPart;
    });
    return parts;
  }
  return "";
}

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
        const now = new Date();
        t = [
          { role: "system", content: defaultSystemPrompt },
          ...repairKimiAssistantToolCallReasoning(
            compactValidChatMessages(
              restored.map((msg) => annotateMessageIfNeeded(msg, extractMessageTimestamp(msg) ?? now, now)),
            ),
          ),
        ];
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
    const compacted = sanitizeToolCallMessageChain(compactValidChatMessages(msgs), "[chat-thread-store]");
    msgs.length = 0;
    msgs.push(...repairKimiAssistantToolCallReasoning(compacted));

    const config = {
      ...DEFAULT_SMART_TRIM_CONFIG,
      maxMessages: maxMessages ?? DEFAULT_SMART_TRIM_CONFIG.maxMessages,
    };

    if (msgs.length <= 1 + config.maxMessages) {
      const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (totalTokens <= config.maxTokens) return;
      this.smartTrimByTokens(msgs, config);
      return;
    }

    const sys = msgs[0];
    const rest = msgs.slice(1);
    const trimmed = trimPreservingToolPairs(rest, config.maxMessages);
    msgs.length = 0;
    msgs.push(sys, ...trimmed);

    const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens > config.maxTokens) {
      this.smartTrimByTokens(msgs, config);
    }
  }

  private smartTrimByTokens(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
  ): void {
    if (msgs.length <= 2) return;
    const sys = msgs[0];
    const rest = msgs.slice(1);
    const recentMessages = rest.slice(-config.preserveRecentTurns * 2);
    const olderMessages = rest.slice(0, -config.preserveRecentTurns * 2);
    let currentTokens =
      estimateMessageTokens(sys) + recentMessages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

    const olderGroups = groupMessagesPreservingToolPairs(olderMessages);
    const preservedOlder: ChatCompletionMessageParam[] = [];
    for (let g = olderGroups.length - 1; g >= 0 && currentTokens < config.maxTokens; g--) {
      const group = olderGroups[g];
      const groupTokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (currentTokens + groupTokens > config.maxTokens) continue;
      preservedOlder.unshift(...group);
      currentTokens += groupTokens;
    }

    msgs.length = 0;
    msgs.push(
      sys,
      ...sanitizeToolCallMessageChain([...preservedOlder, ...recentMessages], "[chat-thread-store-trim]"),
    );
  }

  appendTurn(
    sessionId: string,
    defaultSystemPrompt: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    now: Date = new Date(),
    clientMessageId?: string,
  ): void {
    const trimmed = assistantText.trim();
    if (!trimmed) return;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    const userAt = new Date(now.getTime());
    const assistantAt = new Date(now.getTime() + 1); // 1ms 偏移，避免同毫秒时排序并列
    const incomingUserText = userTurn.text;
    // 兼容两种调用姿势：
    // 1. Provider 已在 streamCompletion 里把 user 消息 push 进 msgs（此时最后一条就是 user）→ 只刷新时间戳
    // 2. Plan-Execute 等场景下没有 push → 新增一条带时间戳的 user 消息
    const last = msgs[msgs.length - 1];
    if (last && last.role === "user" && userMessageTextMatches(last, incomingUserText)) {
      const next = {
        ...last,
        content: annotateUserContentIfString(last.content, userAt, now),
      } as ChatCompletionMessageParam;
      tagUserMessageClientId(next, clientMessageId ?? readUserMessageClientId(last));
      msgs[msgs.length - 1] = next;
    } else {
      const userMsg = {
        role: "user",
        content: annotateUserContentIfString(openAiUserContentFromTurn(userTurn), userAt, now),
      } as ChatCompletionMessageParam;
      tagUserMessageClientId(userMsg, clientMessageId);
      msgs.push(userMsg);
    }
    msgs.push({ role: "assistant", content: annotateTimeframe(trimmed, assistantAt, now) });
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  afterTurnCompleted(sessionId: string, msgs: ChatCompletionMessageParam[]): void {
    const now = new Date();
    const annotated = msgs.map((msg) =>
      annotateMessageIfNeeded(msg, extractMessageTimestamp(msg) ?? now, now),
    );
    msgs.length = 0;
    msgs.push(...annotated);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  /**
   * 删除指定 clientMessageId 的 user 消息及其后所有内容（assistant / tool 链）。
   * 供 provider 在 streamCompletion 写入新一轮（编辑后的）user 消息前调用：
   *   1. 先删掉旧 user 消息及之后内容
   *   2. 再 push 新 user 消息并跑 Agent
   * 这样编辑时不会留下「同 id 两条 user 消息」的脏数据。
   * @returns 是否命中并截断
   */
  removeUserMessageAndAfter(
    sessionId: string,
    clientMessageId: string | undefined,
  ): boolean {
    if (!clientMessageId) return false;
    const msgs = this.history.get(sessionId);
    if (!msgs) return false;
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return false;
    if (found.index < msgs.length) {
      msgs.length = found.index;
      this.persistence?.scheduleSave(sessionId, msgs);
    }
    return true;
  }

  /**
   * 读取 user 消息的纯文本（去时间戳前缀），用于客户端编辑回填 / 服务端校验。
   * @returns 命中则返回文本，未命中返回 null
   */
  readUserMessageText(
    sessionId: string,
    clientMessageId: string,
  ): string | null {
    if (!clientMessageId) return null;
    const msgs = this.history.get(sessionId);
    if (!msgs) return null;
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return null;
    if (typeof found.msg.content === "string") {
      const parsed = readMessageTimestampPrefix(found.msg.content);
      return (parsed?.rest ?? found.msg.content).trim();
    }
    return null;
  }

  /**
   * 编辑一条 user 消息：替换内容，并截断到该消息之后的所有内容（assistant / tool 链）。
   * 通常编辑后服务端会再走一次 Agent 重答（参考 `agentCore.handleUserMessage`）。
   */
  editUserMessage(
    sessionId: string,
    defaultSystemPrompt: string,
    clientMessageId: string,
    newText: string,
    now: Date = new Date(),
  ): { ok: boolean; reason?: string; index?: number } {
    if (!clientMessageId) return { ok: false, reason: "missing_message_id" };
    const text = newText.trim();
    if (!text) return { ok: false, reason: "empty_text" };
    const msgs = this.history.get(sessionId);
    if (!msgs) return { ok: false, reason: "session_not_found" };
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return { ok: false, reason: "message_not_found" };
    const { index, msg } = found;
    const replaced = {
      ...msg,
      content: annotateUserContentIfString(text, now, now),
    } as ChatCompletionMessageParam;
    tagUserMessageClientId(replaced, clientMessageId);
    msgs[index] = replaced;
    if (index < msgs.length - 1) {
      msgs.length = index + 1;
    }
    this.persistence?.scheduleSave(sessionId, msgs);
    return { ok: true, index };
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

function groupMessagesPreservingToolPairs(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[][] {
  const groups: ChatCompletionMessageParam[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg || typeof msg.role !== "string") {
      i++;
      continue;
    }
    if (msg.role === "assistant" && Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
      const group: ChatCompletionMessageParam[] = [msg];
      i++;
      while (i < messages.length && messages[i]?.role === "tool") {
        group.push(messages[i]);
        i++;
      }
      groups.push(group);
      continue;
    }
    if (msg.role === "tool") {
      const orphanTools: ChatCompletionMessageParam[] = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        orphanTools.push(messages[i]);
        i++;
      }
      if (orphanTools.length > 0) {
        console.warn(`[chat-thread-store] Skipping ${orphanTools.length} orphan tool message(s) during trim`);
      }
      continue;
    }
    groups.push([msg]);
    i++;
  }
  return groups;
}

function trimPreservingToolPairs(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): ChatCompletionMessageParam[] {
  if (messages.length <= maxMessages) {
    return sanitizeToolCallMessageChain(messages, "[chat-thread-store-trim]");
  }
  const groups = groupMessagesPreservingToolPairs(messages);
  const result: ChatCompletionMessageParam[] = [];
  let total = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    if (total + groups[g].length > maxMessages) continue;
    result.unshift(...groups[g]);
    total += groups[g].length;
  }
  return sanitizeToolCallMessageChain(result, "[chat-thread-store-trim]");
}
