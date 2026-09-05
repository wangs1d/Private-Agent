import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { adoptLegacyMasterDelegateThread, adoptPrimaryThreadFromMasterThread } from "./chat-thread-adopt.js";
import { masterChatSessionId } from "../agent/master-chat-session.js";
import { AGENT_COMMITMENT_RE, MEMORY_EXPLICIT_RE } from "../agent/memory-signal.js";
import type { ChatThreadPersistence } from "./chat-thread-persist.js";
import { getChatThreadPersistence } from "./chat-thread-persist.js";
import type { ChatUserTurn } from "./types.js";
import type { RecapSummarizer } from "../services/conversation-rolling-summarizer.js";
import { layerRecapLinesByBudget } from "../services/conversation-rolling-summarizer.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import {
  compactValidChatMessages,
  repairKimiAssistantToolCallReasoning,
  sanitizeToolCallMessageChain,
} from "./chat-thread-sanitize.js";
import { stripLeadingTimestampFrames } from "../utils/timestamp-frame.js";

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
  maxMessages: parseInt(process.env.MAX_THREAD_MESSAGES ?? "24", 10),
  maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? "6000", 10),
  preserveRecentTurns: 3,
};

// ── 近期窗口裁剪参数（2026-09-05，替代「今天+昨天全文」策略）──
/** 原样保留的近期消息窗口（≈6 轮 user/assistant 配对）。 */
const RECENT_WINDOW_MESSAGES = 12;
/** 折叠批次：窗口外攒够一批才折叠一次，recap 不随轮重写（保护 prefix cache）。 */
const RECAP_BATCH_MESSAGES = 6;
/** 已有 recap 行的单行 token 粗估（recap 上限 14 行/1600 字符）。 */
const RECAP_LINE_TOKEN_ESTIMATE = 40;

// 条内压缩配置：对「非最近 N 轮」的超长 assistant 消息（LLM 已消费过的输出）做无损级压缩，
// 让同一 token 预算保留更多轮次，减少整条 drop 进 recap（信息断层 + 额外一次 LLM 摘要调用）。
const CHAT_LONG_ASSISTANT_MAX_CHARS = parseInt(
  process.env.CHAT_LONG_ASSISTANT_MAX_CHARS ?? "800",
  10,
);
const CHAT_COMPRESS_PRESERVE_RECENT_TURNS = 2;

const SESSION_RECAP_PREFIX = "[session-recap]";
const SESSION_RECAP_TITLE = "Earlier conversation recap:";
const SESSION_RECAP_MAX_LINES = 14;
const SESSION_RECAP_MAX_CHARS = 1600;

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
    // 不设低封顶：压缩后的工具消息可达 4-7k 字符（≈3-5k token），按 1000 封顶会
    // 低估占用、让 MAX_CONTEXT_TOKENS 预算判断偏松而放行超限内容。
    tokens += estimateTokens(msg.content);
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

/** 容错解析时间帧文本里的本地时间（兼容残缺/变体帧，如模型复述出的 `[ts:...]周四[now]`）。 */
function parseFrameDateLoose(text: string): Date | null {
  const head = text.slice(0, 240);
  const m = head.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}T${m[2]}`);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 时间轴单行条目。 */
type TimelineEntry = { date: Date; roleLabel: string };

// 2026-09-05 时间轴瘦身：线程裁剪后消息 ≤24 条 + recap，80 上限形同虚设；
// 收紧到 24 与线程上限对齐，并去掉相对时间段（「3m ago」每轮重算 → 该块字节
// 每轮全变、永远全价计费）。绝对时间 + system 当前时间已足够推算相对时间。
const TIMELINE_MAX_ENTRIES = 24;
const TIMELINE_HEADER =
  "【对话时间轴｜系统元数据】以下是此前各条消息的发生时间（本地时间），供时间关联推理使用；" +
  "「现在」以 system 提示中的当前时间为准。本块是系统注入的元数据，不是对话内容，严禁复述或引用本块格式。";

export type TimestampFreeLlmView = {
  /** 供本次 LLM 请求使用的消息视图：历史正文已去 `[ts:]` 前缀，末尾前注入时间轴 system 消息。 */
  messages: ChatCompletionMessageParam[];
};

/**
 * 构造「无时间戳前缀」的 LLM 请求视图（根治时间戳帧复述泄漏）。
 *
 * 设计（2026-09-03）：
 * - 存储层不动：`[ts:...]` 前缀仍是线程消息的元数据载体（按天裁剪 / recap / 恢复 / 编辑
 *   都依赖解析它），绝不就地剥离调用方持有的线程消息。
 * - 视图层剥离：发往 LLM 的每条 user/assistant 正文剥掉首行前缀——模型上下文里不再有
 *   「每条消息都以 [ts: 开头」的强模仿模式，从根源消除复述诱因（system prompt 禁令
 *   打不过几百条 in-context 示范）。
 * - 时间轴补位：在最后一条 user 消息（本轮输入）之前插入一个 system 块，按发生顺序
 *   一次性给出全部时间（绝对时间 + 请求时现算的相对时间），时间关联能力不回退。
 *   块位于上下文尾部，每轮只有它之后的字节变化（本来也只有本轮新消息），prefix cache
 *   命中率与旧方案持平。
 * - 克隆式：只克隆被剥离的消息对象，其余消息与输入共享同一对象引用（调用方可据此
 *   用对象身份区分「视图新增」与「线程原有」，做工具循环后的回写）。
 */
/** 克隆消息对象并透传 clientMessageId 反向索引（编辑/删除按它定位线程消息）。 */
function cloneMessageWithClientId(
  msg: ChatCompletionMessageParam,
  content: ChatCompletionMessageParam["content"],
): ChatCompletionMessageParam {
  const cloned = { ...msg, content } as ChatCompletionMessageParam;
  const clientId = readUserMessageClientId(msg);
  if (clientId) userMessageClientIdMap.set(cloned, clientId);
  return cloned;
}

export function buildTimestampFreeLlmView(
  msgs: ChatCompletionMessageParam[],
): TimestampFreeLlmView {
  const timeline: TimelineEntry[] = [];
  const view = msgs.map((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") return msg;
    const roleLabel = msg.role === "user" ? "用户" : "助手";

    if (Array.isArray(msg.content)) {
      const parts = msg.content;
      const textIdx = parts.findIndex(
        (part) => part && typeof part === "object" && (part as { type?: string }).type === "text",
      );
      if (textIdx < 0) return msg;
      const part = parts[textIdx] as { type: "text"; text: string };
      const original = part.text ?? "";
      const date = extractMessageTimestamp(msg) ?? parseFrameDateLoose(original);
      const stripped = stripLeadingTimestampFrames(original);
      if (date && !stripped.startsWith("[session-recap]")) {
        timeline.push({ date, roleLabel });
      }
      if (stripped === original) return msg;
      const clonedParts = parts.slice();
      clonedParts[textIdx] = { ...part, text: stripped };
      return cloneMessageWithClientId(msg, clonedParts);
    }

    if (typeof msg.content !== "string") return msg;
    const original = msg.content;
    const date = extractMessageTimestamp(msg) ?? parseFrameDateLoose(original);
    const stripped = stripLeadingTimestampFrames(original);
    if (date && !stripped.startsWith("[session-recap]")) {
      timeline.push({ date, roleLabel });
    }
    if (stripped === original) return msg;
    return cloneMessageWithClientId(msg, stripped);
  });

  // 时间轴注入点：最后一条 user 消息（本轮输入）之前。条目过少（<2，如 ephemeral 单轮）
  // 时时间轴无增量价值，跳过注入，只保留剥离。
  if (timeline.length >= 2) {
    let lastUserIdx = -1;
    for (let i = view.length - 1; i >= 0; i--) {
      if (view[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const rows = timeline.slice(-TIMELINE_MAX_ENTRIES).map((entry) => {
      // 不再拼相对时间段：它每轮随请求时刻重算，导致整个时间轴块字节每轮变化，
      // prefix cache 永远失配、按全价计费；绝对时间 + 当前时间足以推算相对时间。
      return `- ${formatLocalDateTime(entry.date)} ${weekdayCn(entry.date)} ${entry.roleLabel}`;
    });
    const timelineMsg: ChatCompletionMessageParam = {
      role: "system",
      content: `${TIMELINE_HEADER}\n${rows.join("\n")}`,
    };
    const insertAt = lastUserIdx >= 0 ? lastUserIdx : view.length;
    view.splice(insertAt, 0, timelineMsg);
  }

  return { messages: view };
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

function stripTimestampText(content: string): string {
  const parsed = readMessageTimestampPrefix(content);
  return (parsed?.rest ?? content).trim();
}

function isSessionRecapMessage(msg: ChatCompletionMessageParam | undefined): boolean {
  if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") return false;
  return stripTimestampText(msg.content).startsWith(SESSION_RECAP_PREFIX);
}

function extractSessionRecapLines(content: string | undefined): string[] {
  if (!content) return [];
  const text = stripTimestampText(content);
  if (!text.startsWith(SESSION_RECAP_PREFIX)) return [];
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter((line) => line && line !== SESSION_RECAP_TITLE);
}

function normalizeRecapLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function pushRecapLine(target: string[], line: string): void {
  const normalized = normalizeRecapLine(line);
  if (!normalized) return;
  if (target.includes(normalized)) return;
  target.push(normalized);
}

/** 把 recap 行数组渲染为 recap 消息的 content（与 extractSessionRecapLines 双向兼容）。 */
function buildSessionRecapContent(lines: string[]): string {
  // 事件化分层 + 预算裁剪（记忆连续性 Phase 2）：按行首时间标签（[今天]/[昨天]/[N天前]）
  // 重新排序（今天 → 昨天 → 本周 → 更早），并按预算裁剪——近层全量、远层压缩，
  // 避免简单 slice 丢失近因、时间线乱跳、跳转不可追溯。
  const plain = lines.map((l) => l.replace(/^-+\s*/, "").trim()).filter(Boolean);
  const ordered = layerRecapLinesByBudget(plain, SESSION_RECAP_MAX_LINES);
  return `${SESSION_RECAP_PREFIX}\n${SESSION_RECAP_TITLE}\n${ordered.map((l) => `- ${l}`).join("\n")}`;
}

/**
 * 中文相对天数标签（与 recap 时间线前缀统一）：今天 / 昨天 / N天前。
 * 供无 LLM 摘要器时的兜底 recap 行使用，保证时间线可追溯。
 */
function relativeDayCnLabel(at: Date, now: Date = new Date()): string {
  const daysElapsed = dayDiff(at, now);
  if (daysElapsed <= 0) return "今天";
  if (daysElapsed === 1) return "昨天";
  return `${daysElapsed}天前`;
}

/**
 * 从被 trim 丢弃的消息中生成兜底 recap 行（无 LLM 摘要器时保证连续性）。
 * 每条 `[今天]/[昨天]/[N天前] 内容`，去重、限长、限条数。
 * 语义化精炼仍由异步 enhanceRecap（LLM 滚动摘要）负责，本函数只是「先用原文占位」，
 * 避免旧消息被丢弃后彻底无痕、跨天记忆断层。
 */
function minimalRecapLinesFromDropped(
  droppedMessages: ChatCompletionMessageParam[],
  now: Date = new Date(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const msg of droppedMessages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string") continue;
    const ts = extractMessageTimestamp(msg) ?? now;
    const text = stripTimestampText(msg.content);
    if (!text || text.startsWith(SESSION_RECAP_PREFIX)) continue;
    const label = relativeDayCnLabel(ts, now);
    const norm = normalizeRecapLine(`[${label}] ${text}`);
    if (!norm || norm.length > SESSION_RECAP_MAX_CHARS) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= SESSION_RECAP_MAX_LINES) break;
  }
  return out;
}

function buildSessionRecapMessage(
  existingLines: string[],
  droppedMessages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam | null {
  // 同步路径只合并已有的 recap 行（去重、排序、预算裁剪），不再做旧的正则提取；
  // 被丢弃消息的具体摘要交由 LLM 滚动摘要异步增强（enhanceRecap）。
  // 但无已有行时不再返回 null：用被丢弃消息原文生成兜底 recap（含 [今天]/[昨天]/[N天前]
  // 日期标签）占位，保证跨天连续性不因摘要器缺失/未完成而断层；异步增强完成后会替换为精炼版。
  // 同步兜底：已有 recap 行 + 本次被丢弃历史消息生成的原文兜底行，二者合并（去重）。
  // 修复原逻辑「已有 recap 行时完全忽略 droppedMessages」导致的跨天断层：
  // 若仅靠异步 enhanceRecap（LLM 摘要）吸收新丢弃消息，而增强器缺失/失败时，
  // 这些新历史消息将永久丢失。合并后即便无 LLM，也能以原文占位形式保留。
  const merged: string[] = [];
  for (const line of existingLines) pushRecapLine(merged, line);
  for (const line of minimalRecapLinesFromDropped(droppedMessages)) pushRecapLine(merged, line);

  const base = merged;
  if (base.length === 0) return null;

  // 字符预算截断（1600 chars）先行；行数预算交给 buildSessionRecapContent 的
  // layerRecapLinesByBudget 按时间桶裁剪（近层全量、远层压缩），避免简单 slice 丢近因。
  const lines: string[] = [];
  let totalChars = SESSION_RECAP_PREFIX.length + SESSION_RECAP_TITLE.length + 2;
  for (const line of base) {
    if (totalChars + line.length + 4 > SESSION_RECAP_MAX_CHARS) break;
    lines.push(`- ${line}`);
    totalChars += line.length + 4;
  }
  if (lines.length === 0) return null;

  return {
    role: "assistant",
    content: buildSessionRecapContent(lines),
  };
}

function separateRecapMessages(messages: ChatCompletionMessageParam[]): {
  body: ChatCompletionMessageParam[];
  recapLines: string[];
} {
  const body: ChatCompletionMessageParam[] = [];
  const recapLines: string[] = [];
  for (const msg of messages) {
    if (isSessionRecapMessage(msg)) {
      recapLines.push(...extractSessionRecapLines(typeof msg.content === "string" ? msg.content : ""));
      continue;
    }
    body.push(msg);
  }
  return { body, recapLines };
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

/**
 * 从根源折叠「已完成的 tool_call 链」，防止串台。
 *
 * 根源问题：OpenAI 协议里 tool 消息没有「轮次边界」。一轮工具调用完成后，thread 里留下
 *   assistant(tool_calls) → tool → tool → assistant(content)
 * 下一轮 LLM 看到这些 raw tool 结果，会把它们当成「刚发生的事」去承接，导致回复开头出现
 * 「哈哈被你看穿了，我刚查 XX 没查到」之类的串台。
 *
 * 旧方案（已废弃）：closeIncompleteToolTurns 在下一轮 user 消息 push 后才插入 system 分隔提示，
 * 靠 prompt「恳求」LLM 别串台——治标不治本，raw tool 结果仍在 thread 里。
 *
 * 新方案（根源）：在轮次完成的瞬间（afterTurnCompleted），把已完成的 tool_call 链折叠成
 * 单条干净的 assistant 消息，彻底移除 tool 角色消息。LLM 下一轮根本看不到 raw tool 结果，
 * 无法串台。折叠时保留最终 assistant 回复的正文与时间戳，不丢失语义。
 *
 * 折叠规则：
 *   assistant(tool_calls, 无content) → tool* → assistant(content)
 *   压缩为：
 *   assistant(content)
 *
 * 未完成的 tool_call 链（无后续 assistant(content)，如被新消息打断）：折叠为单条 assistant
 * 占位消息，明确标注「上一轮工具调用未完成」，避免 LLM 把孤立的 tool_calls 当成当前轮语境。
 *
 * 幂等：已是普通 assistant（无 tool_calls）的消息不会被重复处理。
 */
function hasToolCalls(msg: ChatCompletionMessageParam): boolean {
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

/**
 * 移除会话中间（index > 0）的 transient system 消息，只保留 msgs[0] 的主 system prompt。
 * tool loop 会把「工具调用原则」等临时指令 push 进 messages（即 thread 数组），
 * 若不清理会逐轮累积，污染后续轮次的对话历史，导致 LLM 丢失对前文的感知。
 */
function removeTransientSystemMessages(msgs: ChatCompletionMessageParam[]): void {
  if (msgs.length <= 1) return;
  let write = 1;
  for (let read = 1; read < msgs.length; read++) {
    if (msgs[read].role === "system") continue;
    msgs[write++] = msgs[read];
  }
  msgs.length = write;
}

export function foldCompletedToolChains(msgs: ChatCompletionMessageParam[]): boolean {
  if (msgs.length < 2) return false;
  const result: ChatCompletionMessageParam[] = [];
  let i = 0;
  let changed = false;

  while (i < msgs.length) {
    const msg = msgs[i];

    // 检测 assistant(tool_calls) 起始，折叠整条工具链（含多轮）为单条最终 assistant(content)
    if (msg && msg.role === "assistant" && hasToolCalls(msg)) {
      let j = i;
      let finalAssistant: ChatCompletionMessageParam | null = null;

      // 向前扫描：跳过连续的 assistant(tool_calls) → tool* 段，直到最终 assistant(content) 或链被打断
      while (j < msgs.length) {
        const m = msgs[j];
        if (m.role === "assistant") {
          if (hasToolCalls(m)) {
            j++;
            while (j < msgs.length && msgs[j].role === "tool") {
              j++;
            }
            continue;
          }
          finalAssistant = m;
          j++;
          break;
        }
        break; // 遇到非 assistant 消息（如新的 user）→ 链被打断
      }

      if (finalAssistant) {
        const content =
          typeof finalAssistant.content === "string" ? finalAssistant.content.trim() : "";
        if (content) {
          result.push(finalAssistant);
        } else {
          result.push({
            role: "assistant",
            content: annotateTimeframe(
              "[上一轮工具调用已完成但未生成可见回复]",
              new Date(),
              new Date(),
            ),
          });
        }
        changed = true;
        i = j;
        continue;
      }

      // 未完成的 tool_call 链：assistant(tool_calls) → tool*（无后续 assistant content）
      result.push({
        role: "assistant",
        content: annotateTimeframe(
          "[上一轮工具调用尚未完成即被新消息打断，未生成完整回复]",
          new Date(),
          new Date(),
        ),
      });
      changed = true;
      i = j;
      continue;
    }

    result.push(msg);
    i++;
  }

  if (changed) {
    msgs.length = 0;
    msgs.push(...result);
  }
  return changed;
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

  /**
   * 滚动摘要增强器（LLM 增量摘要）——recap 的唯一生成者。
   * 为 null 时仅保留已有 recap 行（不生成新摘要），不影响对话主链路。
   * 通过 setRecapSummarizer 注入（bootstrap 装配）。
   */
  private recapSummarizer: RecapSummarizer | null = null;

  /**
   * 每个 session 的增强序号：trim 触发增强时递增。
   * 增强完成回写前检查序号是否仍为触发值，防止旧结果覆盖期间新生成的 recap。
   */
  private readonly recapEnhanceSeq = new Map<string, number>();

  /** 注入滚动摘要增强器（null 关闭）。 */
  setRecapSummarizer(summarizer: RecapSummarizer | null): void {
    this.recapSummarizer = summarizer;
  }

  /**
   * 把「被 trim 丢弃的历史消息」异步交给 LLM 增强 recap。
   * - 不阻塞 trimThread 主链路（fire-and-forget）
   * - 失败静默：保留同步生成的已有 recap 行
   * - seq 守卫：期间若又有新 trim 触发增强，丢弃本次旧结果
   *
   * 增量合并契约（2026-09-05 漂移修复）：summarizer 只为「新对话」产新行，
   * 已有 recap 行在此原样保留、不经 LLM 重发。此前 LLM 全量重发 recap，
   * 小模型改写会把事实逐步漂移（实测"七点提醒我开线上会议"在多次折叠重写后
   * 变成"七点半线上会议"，错误随每次折叠复利传播并注入后续上下文）。
   */
  private async enhanceRecap(
    sessionId: string,
    existingLines: string[],
    droppedMessages: ChatCompletionMessageParam[],
  ): Promise<void> {
    const summarizer = this.recapSummarizer;
    if (!summarizer || !sessionId || droppedMessages.length === 0) return;
    const seq = (this.recapEnhanceSeq.get(sessionId) ?? 0) + 1;
    this.recapEnhanceSeq.set(sessionId, seq);
    try {
      const lines = await summarizer({ existingLines, droppedMessages });
      if (!lines || lines.length === 0) return;
      // 期间又发生了 trim → recap 已有更新版本，丢弃本次结果，避免覆盖
      if (this.recapEnhanceSeq.get(sessionId) !== seq) return;
      const merged = [...existingLines];
      for (const line of lines) pushRecapLine(merged, line);
      if (merged.length === existingLines.length) return; // 新行全部与已有行重复
      this.applyEnhancedRecap(sessionId, merged);
    } catch {
      // 静默失败：保留同步生成的已有 recap 行
    }
  }

  private applyEnhancedRecap(sessionId: string, lines: string[]): void {
    const msgs = this.history.get(sessionId);
    if (!msgs) return;
    const recapMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: buildSessionRecapContent(lines),
    };
    const index = msgs.findIndex(isSessionRecapMessage);
    if (index >= 0) {
      msgs[index] = recapMsg;
    } else {
      // 无同步 recap 消息（首次压缩、此前无历史 recap）：在 system 之后插入，
      // 保证 LLM 摘要对后续轮次可见。
      msgs.splice(1, 0, recapMsg);
    }
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  /**
   * 可选的「会话首条 system」提供者。
   *
   * 设计目的：让 RuntimeKernel minimal 模式下，sessionSys（薄身份 system）由 thread-store
   * 在会话首次创建时一次性写入 msgs[0]，provider 后续轮次不再覆盖——
   * 真正实现"首轮注入一次"，而不是"每轮重发但靠 prefix cache"。
   *
   * 协议：回调返回非空字符串时，thread-store 在新建会话时用它作为 msgs[0]；
   * 返回 null/undefined 时回退 defaultSystemPrompt（旧行为）。
   *
   * 模型无关性：该机制只影响 msgs[0] 内容，与具体 provider 模型解耦——
   * OpenAI / Kimi / DeepSeek / Claude 等所有 OpenAI-compatible provider 都遵循
   * "msgs[0] = system message" 的统一协议。
   */
  private sessionSystemProvider: (() => string | null | undefined) | null = null;

  constructor(private readonly persistence: ChatThreadPersistence | null) {}

  /**
   * 注入会话首条 system 提供者（通常由 bootstrap 调用，传入 RuntimeKernel.buildSessionSystem）。
   * 传 null 解除注入，回退 defaultSystemPrompt 行为。
   */
  setSessionSystemProvider(provider: (() => string | null | undefined) | null): void {
    this.sessionSystemProvider = provider;
  }

  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.persistence?.deleteSession(sessionId);
  }

  thread(sessionId: string, defaultSystemPrompt: string): ChatCompletionMessageParam[] {
    const sessionSys = this.sessionSystemProvider?.() ?? null;
    let t = this.history.get(sessionId);
    if (!t) {
      t = adoptLegacyMasterDelegateThread(this.history, sessionId);
    }
    if (!t) {
      // master 委派层删除后的所有权迁移：裸 actorId 主线程缺失时从 master: 收养
      t = adoptPrimaryThreadFromMasterThread(this.history, sessionId);
    }
    if (!t && this.persistence) {
      const restored = this.persistence.loadRestoredMessages(sessionId);
      if (restored?.length) {
        const now = new Date();
        t = [
          { role: "system", content: sessionSys ?? defaultSystemPrompt },
          ...repairKimiAssistantToolCallReasoning(
            compactValidChatMessages(
              restored.map((msg) => annotateMessageIfNeeded(msg, extractMessageTimestamp(msg) ?? now, now)),
            ),
          ),
        ];
        this.history.set(sessionId, t);
      }
    }
    if (!t && this.persistence && !sessionId.includes(":")) {
      // 持久层同规则收养：裸会话无落盘数据但存量 master:{actorId} 有 → 复制恢复
      const masterRestored = this.persistence.loadRestoredMessages(masterChatSessionId(sessionId));
      if (masterRestored?.length) {
        const now = new Date();
        t = [
          { role: "system", content: sessionSys ?? defaultSystemPrompt },
          ...repairKimiAssistantToolCallReasoning(
            compactValidChatMessages(
              masterRestored.map((msg) => annotateMessageIfNeeded(msg, extractMessageTimestamp(msg) ?? now, now)),
            ),
          ),
        ];
        this.history.set(sessionId, t);
      }
    }
    if (!t) {
      t = [{ role: "system", content: sessionSys ?? defaultSystemPrompt }];
      this.history.set(sessionId, t);
    }
    // 防串台已根源解决：afterTurnCompleted 在轮次完成时调用 foldCompletedToolChains
    // 移除 raw tool 结果。这里无需再做事后隔断。
    return t;
  }

  trimThread(msgs: ChatCompletionMessageParam[], maxMessages?: number, sessionId?: string): void {
    const compacted = sanitizeToolCallMessageChain(compactValidChatMessages(msgs), "[chat-thread-store]");
    msgs.length = 0;
    msgs.push(...repairKimiAssistantToolCallReasoning(compacted));

    const config = {
      ...DEFAULT_SMART_TRIM_CONFIG,
      maxMessages: maxMessages ?? DEFAULT_SMART_TRIM_CONFIG.maxMessages,
    };

    // 优先近期窗口切分：保留「最近 N 条」原文 +「更早（含当天早些时候）」压成 recap。
    // 2026-09-05 策略替换：旧「今天+昨天全文」窗口会让长会话整天背着大历史
    // （受 MAX_CONTEXT_TOKENS 兜底前最多 24 条原样重发）。
    // 记忆不丢的三层保障（与窗口大小无关）：
    //   1) 每轮 live turn 在 TurnLifecycle.finalizeTurn 已完成长期记忆种植
    //      （turn WAL / daily journal / 统一整合链路 / epitome），输入是轮次文本本身；
    //   2) daily journal 保留当天全部对话原文，当日词法召回（journalRecall）不受影响；
    //   3) 被折叠消息进入 recap（规则摘要 + enhanceRecap LLM 滚动摘要增强）。
    if (this.trimByRecentWindow(msgs, config, sessionId)) {
      return;
    }

    // 近期窗口+recap 后仍超 token 上限（近期消息太大），降级到 token 维度裁剪
    if (msgs.length <= 1 + config.maxMessages) {
      const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (totalTokens <= config.maxTokens) return;
      this.smartTrimByTokens(msgs, config, sessionId);
      return;
    }

    // 消息条数也超限（极少触发，今天消息爆量）：保留最近 N 条 + recap
    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const trimResult = trimPreservingToolPairs(separated.body, config.maxMessages);
    const recap = buildSessionRecapMessage(separated.recapLines, trimResult.dropped);
    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(...trimResult.kept);

    // 丢弃消息较多时异步交给 LLM 滚动摘要增强（不阻塞主链路）
    this.enhanceRecap(sessionId ?? "", separated.recapLines, trimResult.dropped).catch(() => {});

    const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens > config.maxTokens) {
      this.smartTrimByTokens(msgs, config, sessionId);
    }
  }

  /**
   * 按近期窗口切分会话线程（2026-09-05，替代旧 trimByDayBoundary 的「今天+昨天全文」）：
   * - 最近 RECENT_WINDOW_MESSAGES 条原样保留（含工具链成对保护）
   * - 更早的消息（含当天早些时候）压成一条 [session-recap] 摘要
   * - 折叠按 RECAP_BATCH_MESSAGES 批次触发：窗口满 + 攒够一批才折叠一次，
   *   避免 recap 每轮重写导致 prefix cache 每轮全断
   *
   * 记忆连续性保障：被折叠轮次的长期记忆种植在 finalizeTurn 已完成（与线程无关），
   * 当天原文仍在 daily journal，折叠内容进 recap 并由 enhanceRecap 增强。
   *
   * @returns true 表示已成功按窗口切分（无需上层再裁剪）；
   *          false 表示近期消息已使 token 超限，上层需降级到 smartTrimByTokens
   */
  private trimByRecentWindow(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
    sessionId?: string,
  ): boolean {
    if (msgs.length <= 1) return true; // 仅 system，无需压缩

    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const body = separated.body;
    if (body.length === 0) return true;

    // 未超「窗口 + 折批」阈值：不折叠，仅做 token 超限判定（超限交上层 smartTrimByTokens）
    const foldThreshold = RECENT_WINDOW_MESSAGES + RECAP_BATCH_MESSAGES;
    if (body.length <= foldThreshold) {
      const totalTokens =
        estimateMessageTokens(sys) +
        separated.recapLines.length * RECAP_LINE_TOKEN_ESTIMATE +
        body.reduce((s, m) => s + estimateMessageTokens(m), 0);
      return totalTokens <= config.maxTokens;
    }

    // 折叠最旧的 (body.length - RECENT_WINDOW_MESSAGES) 条进 recap；
    // 折叠后窗口保持 RECENT_WINDOW_MESSAGES，recap 约每 RECAP_BATCH_MESSAGES 轮更新一次
    const foldCount = body.length - RECENT_WINDOW_MESSAGES;
    const foldedMessages = body.slice(0, foldCount);
    const keptMessages = body.slice(foldCount);

    const recap = buildSessionRecapMessage(separated.recapLines, foldedMessages);

    // 历史消息折叠后异步交给 LLM 滚动摘要增强（不阻塞主链路）。
    // 不依赖同步 recap 是否存在：无已有 recap 行时由 enhanceRecap 完成后插入。
    this.enhanceRecap(sessionId ?? "", separated.recapLines, foldedMessages).catch(() => {});

    // 重组后 token 检查：若近期窗口消息本身就超限，让上层走 smartTrimByTokens
    const sysTokens = estimateMessageTokens(sys);
    const recapTokens = recap ? estimateMessageTokens(recap) : 0;
    const keptTokens = keptMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (sysTokens + recapTokens + keptTokens > config.maxTokens) {
      return false;
    }

    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(
      ...sanitizeToolCallMessageChain(keptMessages, "[chat-thread-store-window]"),
    );
    return true;
  }

  /**
   * 条内压缩：把「非最近 preserveRecentTurns 轮」的超长 assistant 消息压到 maxChars。
   *
   * 背景：历史窗口 token 预算固定（MAX_CONTEXT_TOKENS），超预算时旧逻辑只会
   * 「整条 drop 进 recap」——长 assistant 回复（LLM 已消费过的输出）占预算越多，
   * 被 drop 的轮次越多，信息断层越严重，还白触发一次 LLM 滚动摘要（输出也耗 token）。
   *
   * 本函数在 drop 之前先压缩超长 assistant 消息（保留头尾、标记已压缩），
   * 让同一预算保留约 2 倍轮次；仍超预算才走整条 drop。
   * 安全约束：
   * - 只动 assistant 纯文本；user / tool / 多模态 content 一律不碰；
   * - 最近 preserveRecentTurns 轮全量保留（LLM 追赶问需要完整衔接，防幻觉）；
   * - 已压缩（带 [已压缩 前缀）与 recap 消息跳过；
   * - 防过度压缩守卫（2026-08）：承诺/结论轮不压缩（与窗口 pin 同一保护类，
   *   "答应过的事"被腰斩比占 token 危害大）；含代码围栏的消息不压缩
   *   （代码被头尾截断后完全不可用，用户"再发一下那段代码"时模型只能看到残骸）；
   * - 切点对齐句子边界（见 compressAssistantTextForWindow），压缩无收益则保持原文。
   */
  private compressOversizedAssistantMessages(
    msgs: ChatCompletionMessageParam[],
    maxChars: number,
    preserveRecentTurns: number = CHAT_COMPRESS_PRESERVE_RECENT_TURNS,
  ): void {
    if (!Number.isFinite(maxChars) || maxChars < 200 || msgs.length <= 4) return;
    const recentStart = Math.max(1, msgs.length - preserveRecentTurns * 2);
    for (let i = 1; i < recentStart; i++) {
      const msg = msgs[i];
      if (msg.role !== "assistant" || typeof msg.content !== "string") continue;
      const text = msg.content;
      if (text.length <= maxChars) continue;
      if (text.includes("[session-recap]")) continue; // recap 内容不动
      if (/^\[已压缩/.test(text)) continue; // 已压缩过（幂等）
      if (AGENT_COMMITMENT_RE.test(text)) continue; // 承诺/结论轮不压缩
      if (text.includes("```")) continue; // 含代码块的消息不压缩
      const compressed = compressAssistantTextForWindow(text, maxChars);
      if (!compressed) continue;
      msg.content = compressed;
    }
  }

  private smartTrimByTokens(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
    sessionId?: string,
  ): void {
    if (msgs.length <= 2) return;
    // 先做条内压缩（非最近 2 轮的超长 assistant 消息压到阈值），释放预算后再决定丢哪些组。
    // 纯规则、同步、零 LLM 调用；压缩后总 token 仍超才走整条 drop + recap。
    this.compressOversizedAssistantMessages(msgs, CHAT_LONG_ASSISTANT_MAX_CHARS);
    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const rest = separated.body;
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

    const droppedMessages = olderMessages.filter((msg) => !preservedOlder.includes(msg));
    const recap = buildSessionRecapMessage(separated.recapLines, droppedMessages);

    // 丢弃消息异步交给 LLM 滚动摘要增强（不阻塞主链路，失败保留已有 recap 行）
    if (droppedMessages.length > 0) {
      this.enhanceRecap(sessionId ?? "", separated.recapLines, droppedMessages).catch(() => {});
    }

    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(
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
    model?: string,
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
        content: annotateUserContentIfString(openAiUserContentFromTurn(userTurn, { model }), userAt, now),
      } as ChatCompletionMessageParam;
      tagUserMessageClientId(userMsg, clientMessageId);
      msgs.push(userMsg);
    }
    msgs.push({ role: "assistant", content: annotateTimeframe(trimmed, assistantAt, now) });
    this.trimThread(msgs, maxThreadMessages, sessionId);
    this.persistence?.scheduleSave(sessionId, msgs);
  }

  appendAssistantContinuation(
    sessionId: string,
    clientMessageId: string | undefined,
    continuation: string,
    maxThreadMessages?: number,
  ): string | null {
    const trimmed = continuation.trim();
    if (!trimmed) return null;
    const msgs = this.history.get(sessionId);
    if (!msgs) return null;

    let assistantIndex = -1;
    if (clientMessageId) {
      const found = findUserMessageByClientId(msgs, clientMessageId);
      if (found) {
        for (let i = found.index + 1; i < msgs.length; i++) {
          const msg = msgs[i];
          if (!msg) continue;
          if (msg.role === "user") break;
          if (msg.role === "assistant" && typeof msg.content === "string") {
            assistantIndex = i;
            break;
          }
        }
      }
    }

    if (assistantIndex < 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.role === "assistant" && typeof msg.content === "string") {
          assistantIndex = i;
          break;
        }
      }
    }

    if (assistantIndex < 0) return null;
    const msg = msgs[assistantIndex];
    if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") return null;

    const parsed = readMessageTimestampPrefix(msg.content);
    const body = (parsed?.rest ?? msg.content).trim();
    const mergedBody = body ? `${body}\n\n${trimmed}` : trimmed;
    msg.content = parsed ? `${parsed.prefix}\n${mergedBody}` : annotateTimeframe(mergedBody, new Date());
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
    return mergedBody;
  }

  appendAssistantFollowup(
    sessionId: string,
    clientMessageId: string | undefined,
    text: string,
    maxThreadMessages?: number,
  ): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const msgs = this.history.get(sessionId);
    if (!msgs) return null;

    let insertAfter = msgs.length - 1;
    if (clientMessageId) {
      const found = findUserMessageByClientId(msgs, clientMessageId);
      if (found) {
        insertAfter = found.index;
        for (let i = found.index + 1; i < msgs.length; i++) {
          const msg = msgs[i];
          if (!msg) continue;
          if (msg.role === "user") break;
          insertAfter = i;
        }
      }
    }

    const assistantMsg = {
      role: "assistant",
      content: annotateTimeframe(trimmed, new Date()),
    } as ChatCompletionMessageParam;
    msgs.splice(Math.max(0, insertAfter + 1), 0, assistantMsg);
    this.trimThread(msgs, maxThreadMessages);
    this.persistence?.scheduleSave(sessionId, msgs);
    return trimmed;
  }

  afterTurnCompleted(sessionId: string, msgs: ChatCompletionMessageParam[]): void {
    const now = new Date();
    // P0-1 冻结历史消息时间戳：已有时间戳前缀的消息保持字节级原样（相对时间
    // 不再随轮次重写），保证 thread 前缀稳定，最大化 DeepSeek 等 provider 的
    // prompt prefix cache 命中率。仅对缺失时间戳的消息（极旧数据/纯 tool 消息）
    // 补一次原始时间戳，且补完后不再刷新。相对时间的语义在写入锚点时刻已固定，
    // 会话临近轮次的绝对时间足够 LLM 判断时序。
    const annotated = msgs.map((msg) => {
      if (
        (msg.role === "user" || msg.role === "assistant") &&
        typeof msg.content === "string"
      ) {
        if (readMessageTimestampPrefix(msg.content)) return msg; // 已有时间戳 → 冻结
        return annotateMessageIfNeeded(msg, extractMessageTimestamp(msg) ?? now, now);
      }
      return msg;
    });
    msgs.length = 0;
    msgs.push(...annotated);
    // 根源防串台：轮次完成的瞬间折叠已完成的 tool_call 链，移除 raw tool 结果。
    // 下一轮 LLM 只看到干净的 assistant(content)，不会把上轮 tool 结果当成当前轮语境。
    foldCompletedToolChains(msgs);
    // 清理 tool loop 残留在会话中间的 transient system 消息（如「工具调用原则」），
    // 只保留 msgs[0] 的主 system prompt，避免污染后续轮次的对话历史。
    removeTransientSystemMessages(msgs);
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

  /**
   * 跨轮并行冲突检测辅助：返回「clientMessageId 之后、最新一条 user 纯文本」。
   *
   * 用途：后台复杂任务被某个 chatUserMessageId 触发；当它在后台执行期间，用户可能
   * 又发了新消息（新的 user turn）。续接迟到的后台结果前，需要知道这条中断后的
   * 最新用户话题是否已与原任务目标脱钩，据此决定续接还是丢弃。
   *
   * 仅在 clientMessageId 能定位到该消息、且其后存在新的 user 消息时返回其一；
   * 否则返回 undefined（表示用户没有在任务执行中插话，可安全续接，不触发额外分类）。
   */
  latestUserTextAfter(
    sessionId: string,
    defaultSystemPrompt: string,
    clientMessageId: string,
  ): string | undefined {
    if (!clientMessageId) return undefined;
    const msgs = this.thread(sessionId, defaultSystemPrompt);
    const found = findUserMessageByClientId(msgs, clientMessageId);
    if (!found) return undefined;
    // 自触发消息之后向后扫描，取最后一条带文本的 user 消息。
    for (let i = msgs.length - 1; i > found.index; i--) {
      const m = msgs[i];
      if (m && m.role === "user" && typeof m.content === "string") {
        const text = m.content.trim();
        if (text && text.length > 0) return text;
      }
    }
    return undefined;
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

/**
 * pin 判定（滑动窗口驱逐 → 优先级驱逐）：用户显式要求记住的轮次、agent 做出
 * 承诺/结论的轮次，不允许被更新的内容无声挤出窗口——被挤掉后"答应过的事"
 * 只能靠 recap 兜底重注入，保真度和时序都变差。
 */
function isPinnedGroup(group: ChatCompletionMessageParam[]): boolean {
  for (const msg of group) {
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content) continue;
    if (msg.role === "user" && MEMORY_EXPLICIT_RE.test(content)) return true;
    if (msg.role === "assistant" && AGENT_COMMITMENT_RE.test(content)) return true;
  }
  return false;
}

/**
 * 头尾保留 + 句子边界对齐的确定性压缩（零 LLM）。
 * 防过度压缩设计：
 * - 头尾切点优先对齐句末标点（。！？!?\n…），避免截出半句话污染上下文；
 *   但边界对齐最多只牺牲窗口的一半（保不住就退回原始切点），防止信息过度损失；
 * - 压缩无收益（边界回退后没有变短）返回 null，调用方保持原文。
 * 返回文本以 [已压缩 前缀标注（调用方的幂等检查依赖此前缀）。
 */
export function compressAssistantTextForWindow(text: string, maxChars: number): string | null {
  if (!Number.isFinite(maxChars) || maxChars < 200 || text.length <= maxChars) return null;
  const keep = Math.floor(maxChars / 2);
  if (keep <= 0) return null;

  const headRaw = text.slice(0, keep);
  const tailRaw = text.slice(-keep);

  // 头段：回退到最后一个句末标点（含标点本身）；回退超过窗口一半则放弃对齐
  const headBoundary = Math.max(
    headRaw.lastIndexOf("。"),
    headRaw.lastIndexOf("！"),
    headRaw.lastIndexOf("？"),
    headRaw.lastIndexOf("!"),
    headRaw.lastIndexOf("?"),
    headRaw.lastIndexOf("\n"),
    headRaw.lastIndexOf("…"),
  );
  const head =
    headBoundary >= Math.floor(headRaw.length / 2)
      ? headRaw.slice(0, headBoundary + 1)
      : headRaw;

  // 尾段：前进到第一个句末标点之后；前进超过窗口一半则放弃对齐
  const tailBoundaryMatch = tailRaw.match(/[。！？!?\n…]/);
  const tailBoundary = tailBoundaryMatch?.index ?? -1;
  const tail =
    tailBoundary >= 0 && tailBoundary <= Math.floor(tailRaw.length / 2)
      ? tailRaw.slice(tailBoundary + 1)
      : tailRaw;

  const headTrimmed = head.trimEnd();
  const tailTrimmed = tail.trimStart();
  if (!headTrimmed || !tailTrimmed) return null;

  const result = `[已压缩·${text.length}字符→${headTrimmed.length + tailTrimmed.length}] ${headTrimmed} … ${tailTrimmed}`;
  // 压缩无收益（标记+边界对齐反而变长/等长）就不压
  if (result.length >= text.length) return null;
  return result;
}

export function trimPreservingToolPairs(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): { kept: ChatCompletionMessageParam[]; dropped: ChatCompletionMessageParam[] } {
  if (messages.length <= maxMessages) {
    return {
      kept: sanitizeToolCallMessageChain(messages, "[chat-thread-store-trim]"),
      dropped: [],
    };
  }
  const groups = groupMessagesPreservingToolPairs(messages);

  // 选择改为"预算内优先级"而非纯尾部截断：
  // 1) 从尾部向后贪心装填（原行为，近因优先）；
  // 2) pin 回填：被挤出的显式记忆/承诺组，预算不足时从保留窗口的**最旧端**
  //    驱逐非 pin 组腾位——早期"帮我记住 X / 我会帮你 Y"不再被新闲聊顶掉，
  //    同时保证最近的对话尾部完整无损。
  const selected = new Array<boolean>(groups.length).fill(false);
  let total = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    if (total + groups[g]!.length > maxMessages) continue;
    selected[g] = true;
    total += groups[g]!.length;
  }
  for (let g = 0; g < groups.length; g++) {
    if (selected[g] || !isPinnedGroup(groups[g]!)) continue;
    const need = groups[g]!.length;
    if (total + need > maxMessages) {
      let freed = 0;
      for (let s = 0; s < groups.length && freed < need; s++) {
        if (!selected[s] || s === g || isPinnedGroup(groups[s]!)) continue;
        selected[s] = false;
        freed += groups[s]!.length;
      }
      total -= freed;
    }
    if (total + need <= maxMessages) {
      selected[g] = true;
      total += need;
    }
  }

  const kept = sanitizeToolCallMessageChain(
    groups.filter((_, g) => selected[g]).flat(),
    "[chat-thread-store-trim]",
  );
  const keptSet = new Set(kept);
  const dropped = messages.filter((msg) => !keptSet.has(msg));
  return { kept, dropped };
}
