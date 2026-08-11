import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { AGENT_COMMITMENT_RE } from "../agent/memory-signal.js";
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
  maxMessages: parseInt(process.env.MAX_THREAD_MESSAGES ?? "24", 10),
  maxTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? "6000", 10),
  preserveRecentTurns: 3,
};

const SESSION_RECAP_PREFIX = "[session-recap]";
const SESSION_RECAP_TITLE = "Earlier conversation recap:";
const SESSION_RECAP_MAX_LINES = 14;
const SESSION_RECAP_MAX_CHARS = 1600;
const USER_PREFERENCE_RE = /喜欢|讨厌|偏好|习惯|不要|别|禁忌|生日|纪念日|记住|remember|prefer/i;
const USER_FACT_RE = /我是|我在做|我最近在|我的项目|我正在|我计划|我想做|我需要/i;
const USER_REQUEST_RE = /请|帮我|需要|想要|分析|总结|提醒|安排|继续|修复|优化|看看|做一个/i;
const ASSISTANT_DECISION_RE = /建议|结论|可以|应该|下一步|已为你|已经帮你|稍后|接下来/i;

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

function firstSentence(text: string, maxLen = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentence = normalized.split(/[。！？!?\n]/)[0]?.trim() || normalized;
  return sentence.length > maxLen ? `${sentence.slice(0, maxLen - 3).trimEnd()}...` : sentence;
}

function pushRecapLine(target: string[], line: string): void {
  const normalized = normalizeRecapLine(line);
  if (!normalized) return;
  if (target.includes(normalized)) return;
  target.push(normalized);
}

function extractRecapLinesFromMessages(messages: ChatCompletionMessageParam[]): string[] {
  const priority: string[] = [];
  const general: string[] = [];
  let leadingUserCount = 0;
  let leadingAssistantCount = 0;
  const LEADING_USER_MAX = 4; // 提升前 N 条 user 消息保留量（原 2 → 4）
  const LEADING_ASSISTANT_MAX = 4; // 同上

  // 按消息时间戳生成日期偏移标签（[d-1]=昨天，[d-2]=前天…），让 LLM 能区分历史时间线
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayLabelOf = (msg: ChatCompletionMessageParam): string => {
    const ts = extractMessageTimestamp(msg);
    if (!ts) return ""; // 无时间戳不标日期，避免误导
    const dayStart = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
    const diff = Math.round((todayStart.getTime() - dayStart.getTime()) / 86_400_000);
    if (diff <= 0) return "[今天]";
    if (diff === 1) return "[昨天]";
    return `[${diff}天前]`;
  };

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string") continue;
    const text = stripTimestampText(msg.content);
    if (!text || text.startsWith(SESSION_RECAP_PREFIX)) continue;
    const gist = firstSentence(text);
    if (!gist) continue;
    const dayLabel = dayLabelOf(msg);

    if (msg.role === "user") {
      if (leadingUserCount < LEADING_USER_MAX) {
        pushRecapLine(general, `${dayLabel}Earlier user: ${gist}`.trim());
        leadingUserCount += 1;
        continue;
      }
      if (USER_PREFERENCE_RE.test(text)) {
        pushRecapLine(priority, `${dayLabel}User preference: ${gist}`.trim());
        continue;
      }
      if (USER_FACT_RE.test(text)) {
        pushRecapLine(priority, `${dayLabel}User fact: ${gist}`.trim());
        continue;
      }
      if (USER_REQUEST_RE.test(text) || text.includes("?") || text.includes("？")) {
        pushRecapLine(general, `${dayLabel}Earlier user request: ${gist}`.trim());
      }
      continue;
    }

    if (leadingAssistantCount < LEADING_ASSISTANT_MAX) {
      pushRecapLine(general, `${dayLabel}Earlier assistant: ${gist}`.trim());
      leadingAssistantCount += 1;
      continue;
    }
    if (AGENT_COMMITMENT_RE.test(text)) {
      pushRecapLine(priority, `${dayLabel}Agent commitment: ${gist}`.trim());
      continue;
    }
    if (ASSISTANT_DECISION_RE.test(text)) {
      pushRecapLine(general, `${dayLabel}Earlier agent conclusion: ${gist}`.trim());
    }
  }

  const lines = [...priority, ...general].slice(0, SESSION_RECAP_MAX_LINES);
  return lines;
}

function buildSessionRecapMessage(
  existingLines: string[],
  droppedMessages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam | null {
  const merged: string[] = [];
  for (const line of existingLines) pushRecapLine(merged, line);
  for (const line of extractRecapLinesFromMessages(droppedMessages)) pushRecapLine(merged, line);

  if (merged.length === 0) return null;

  const lines: string[] = [];
  let totalChars = SESSION_RECAP_PREFIX.length + SESSION_RECAP_TITLE.length + 2;
  for (const line of merged) {
    if (lines.length >= SESSION_RECAP_MAX_LINES) break;
    if (totalChars + line.length + 4 > SESSION_RECAP_MAX_CHARS) break;
    lines.push(`- ${line}`);
    totalChars += line.length + 4;
  }
  if (lines.length === 0) return null;

  return {
    role: "assistant",
    content: `${SESSION_RECAP_PREFIX}\n${SESSION_RECAP_TITLE}\n${lines.join("\n")}`,
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
export function foldCompletedToolChains(msgs: ChatCompletionMessageParam[]): boolean {
  if (msgs.length < 2) return false;
  const result: ChatCompletionMessageParam[] = [];
  let i = 0;
  let changed = false;

  while (i < msgs.length) {
    const msg = msgs[i];

    // 检测 assistant(tool_calls) 起始
    if (msg && msg.role === "assistant") {
      const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        // 收集后续连续的 tool 结果
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "tool") {
          j++;
        }

        // 检查 tool 结果后面是否紧跟 assistant(content)（已完成的轮次）
        if (j < msgs.length && msgs[j].role === "assistant") {
          const following = msgs[j];
          const followingToolCalls = (following as { tool_calls?: unknown[] }).tool_calls;
          const hasFollowingContent =
            typeof following.content === "string" && following.content.trim().length > 0;

          if (!Array.isArray(followingToolCalls) || followingToolCalls.length === 0) {
            // 已完成的 tool_call 链：assistant(tool_calls) → tool* → assistant(content)
            // 折叠为单条 assistant(content)，移除 tool_calls 与 tool 结果
            if (hasFollowingContent) {
              result.push(following);
            } else {
              // assistant(content) 为空（异常情况），保留占位
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
            i = j + 1;
            continue;
          }
          // following 也带 tool_calls → 多轮工具调用中的中间步，继续向后找最终 assistant(content)
          // 先 push 当前 assistant(tool_calls) + tool 结果，让下一轮循环处理
          // （实际上多轮工具调用在 streamCompletion 中会被 trimThread/sanitize 处理，
          //  这里只折叠「已完成」的尾部链）
        } else if (j >= msgs.length || msgs[j].role !== "assistant") {
          // 未完成的 tool_call 链：assistant(tool_calls) → tool*（无后续 assistant content）
          // 折叠为单条 assistant 占位消息
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
      }
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
    if (!t) {
      t = [{ role: "system", content: sessionSys ?? defaultSystemPrompt }];
      this.history.set(sessionId, t);
    }
    // 防串台已根源解决：afterTurnCompleted 在轮次完成时调用 foldCompletedToolChains
    // 移除 raw tool 结果。这里无需再做事后隔断。
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

    // 优先按天切分：保留「当天全部消息」+「历史按天整体 recap」。
    // 这与前端「当天渲染、历史折叠」语义对齐：今天对话不丢，历史压成摘要。
    if (this.trimByDayBoundary(msgs, config)) {
      return;
    }

    // 按天切分后仍超 token 上限（当天消息太多），降级到 token 维度裁剪
    if (msgs.length <= 1 + config.maxMessages) {
      const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (totalTokens <= config.maxTokens) return;
      this.smartTrimByTokens(msgs, config);
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

    const totalTokens = msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens > config.maxTokens) {
      this.smartTrimByTokens(msgs, config);
    }
  }

  /**
   * 按本地日期边界切分会话线程：
   * - 「今天」的全部消息原样保留（含工具链成对保护）
   * - 「今天之前」的所有消息整体压成一条 [session-recap] 摘要
   * - 没有时间戳的消息按今天处理，避免误归入历史
   *
   * @returns true 表示已成功按天切分（无需上层再裁剪）；
   *          false 表示当天消息已使 token 超限，上层需降级到 smartTrimByTokens
   */
  private trimByDayBoundary(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
  ): boolean {
    if (msgs.length <= 1) return true; // 仅 system，无需压缩

    const sys = msgs[0];
    const separated = separateRecapMessages(msgs.slice(1));
    const body = separated.body;
    if (body.length === 0) return true;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

    // 仿人记忆连续性：保留"今天 + 昨天"原文，只把前天及更早压成 recap。
    // 人类对昨天的对话仍有清晰记忆，不应被压成 8 行摘要。
    const recentMessages: ChatCompletionMessageParam[] = []; // 今天 + 昨天
    const olderMessages: ChatCompletionMessageParam[] = []; // 前天及更早

    for (const msg of body) {
      const ts = extractMessageTimestamp(msg);
      // 无时间戳（极旧数据或非 user/assistant）按今天处理，避免被错误归入历史 recap
      if (!ts || ts.getTime() >= yesterdayStart.getTime()) {
        recentMessages.push(msg);
      } else {
        olderMessages.push(msg);
      }
    }

    // 无历史消息：不需要按天 recap，但仍可能 token 超限 → 让上层处理
    if (olderMessages.length === 0) {
      const totalTokens =
        estimateMessageTokens(sys) +
        recentMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
      return totalTokens <= config.maxTokens;
    }

    // 仅"前天及更早"的历史整体压成一条 recap
    const recap = buildSessionRecapMessage(separated.recapLines, olderMessages);

    // 重组后 token 检查：若当天+昨天消息本身就超限，让上层走 smartTrimByTokens
    const sysTokens = estimateMessageTokens(sys);
    const recapTokens = recap ? estimateMessageTokens(recap) : 0;
    const recentTokens = recentMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (sysTokens + recapTokens + recentTokens > config.maxTokens) {
      return false;
    }

    msgs.length = 0;
    msgs.push(sys);
    if (recap) msgs.push(recap);
    msgs.push(
      ...sanitizeToolCallMessageChain(recentMessages, "[chat-thread-store-day]"),
    );
    return true;
  }

  private smartTrimByTokens(
    msgs: ChatCompletionMessageParam[],
    config: typeof DEFAULT_SMART_TRIM_CONFIG,
  ): void {
    if (msgs.length <= 2) return;
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
    const annotated = msgs.map((msg) =>
      annotateMessageIfNeeded(msg, extractMessageTimestamp(msg) ?? now, now),
    );
    msgs.length = 0;
    msgs.push(...annotated);
    // 根源防串台：轮次完成的瞬间折叠已完成的 tool_call 链，移除 raw tool 结果。
    // 下一轮 LLM 只看到干净的 assistant(content)，不会把上轮 tool 结果当成当前轮语境。
    foldCompletedToolChains(msgs);
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
): { kept: ChatCompletionMessageParam[]; dropped: ChatCompletionMessageParam[] } {
  if (messages.length <= maxMessages) {
    return {
      kept: sanitizeToolCallMessageChain(messages, "[chat-thread-store-trim]"),
      dropped: [],
    };
  }
  const groups = groupMessagesPreservingToolPairs(messages);
  const keptGroups: ChatCompletionMessageParam[][] = [];
  let total = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    if (total + groups[g].length > maxMessages) continue;
    keptGroups.unshift(groups[g]);
    total += groups[g].length;
  }
  const keptSet = new Set(keptGroups.flat());
  const kept = sanitizeToolCallMessageChain(keptGroups.flat(), "[chat-thread-store-trim]");
  const dropped = messages.filter((msg) => !keptSet.has(msg));
  return { kept, dropped };
}
