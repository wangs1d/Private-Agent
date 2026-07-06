import { randomUUID } from "node:crypto";

import type { ExternalChatProvider } from "../external-model/types.js";
import type { LlmExecutionMode } from "./task-router.js";

type InterimTemplateMap = Record<LlmExecutionMode, string>;

const KEYWORD_TEMPLATES: Array<{ pattern: RegExp; map: InterimTemplateMap }> = [
  {
    pattern: /天气|气温|下雨|下雪|温度|weather/i,
    map: {
      master_delegate: "好的，我先看看天气。",
      plan_execute: "我先确认一下天气。",
      direct_llm: "让我先查一下天气。",
      master_only: "我先看看天气。",
      fast_chat: "我先看看天气。",
    },
  },
  {
    pattern: /搜索|查一下|查询|联网|搜一搜|search|browse|lookup/i,
    map: {
      master_delegate: "好的，我先联网去查。",
      plan_execute: "我先查一下资料。",
      direct_llm: "让我先查一下。",
      master_only: "我先去搜一下。",
      fast_chat: "我先查一下。",
    },
  },
  {
    pattern: /写|起草|文案|润色|改写|总结|摘要|翻译/i,
    map: {
      master_delegate: "好的，我先准备一下。",
      plan_execute: "我先理一下思路。",
      direct_llm: "让我先写一版。",
      master_only: "我先整理一下。",
      fast_chat: "我先整理一下。",
    },
  },
  {
    pattern: /代码|编程|debug|脚本|sql|api/i,
    map: {
      master_delegate: "好的，我先派个技术助手看看。",
      plan_execute: "我先拆解一下实现步骤。",
      direct_llm: "让我先看一下代码。",
      master_only: "我先看看代码。",
      fast_chat: "我先看看代码。",
    },
  },
  {
    pattern: /时间|日期|星期|几点|今天|最新|最近|新闻|动态|发生|什么情况|怎么了/i,
    map: {
      master_delegate: "好的，我先去看看。",
      plan_execute: "我先确认一下。",
      direct_llm: "让我查一下。",
      master_only: "我先看一下。",
      fast_chat: "我先看一下。",
    },
  },
];

const DEFAULT_TEMPLATES: InterimTemplateMap = {
  master_delegate: "好的，我先处理一下。",
  plan_execute: "好的，我先理一下。",
  direct_llm: "好的，我先看一下。",
  master_only: "好的，我先看一下。",
  fast_chat: "好的，我先看一下。",
};

const NOISE_PREFIXES = /^(你好|hi|hello|hey|谢谢|thanks|thank you|再见|bye)[!，,。？?\s]*$/i;
const INTERIM_ACK_TIMEOUT_MS = 1800;
const INTERIM_ACK_SYSTEM_PROMPT =
  "You are generating only the first-phase acknowledgment for a conversation. " +
  "Reply with exactly one short natural sentence in the user's language. " +
  "This is only a quick human-like acknowledgment before work starts, not the actual answer. " +
  "Do not answer the task. Do not explain the topic. Do not paraphrase the final result. " +
  "Do not include facts, examples, lists, markdown, or explanations. " +
  "Prefer a brief first-person action line like checking, searching, or looking into it. " +
  "You may sound playful, cute, teasing, or lightly funny if it fits, but stay short and do not overperform. " +
  "Keep it to one sentence only. " +
  "Keep it under 18 Chinese characters or under 12 English words.";

const ANSWERISH_INTERIM_RE =
  /是指|就是|本质|核心|区别|原理|作用|主要|通常|比如|例如|指的是|简单说|一句话|换句话说|意思是|可以理解为|it is|it means|in short|for example|the difference/i;

export function shouldEmitInterimAck(
  text: string,
  mode: LlmExecutionMode,
  opts: { enabled: boolean } = { enabled: true },
): boolean {
  if (!opts.enabled) return false;
  if (mode === "fast_chat") return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  if (t.length < 4) return false;
  if (NOISE_PREFIXES.test(t)) return false;
  return true;
}

export function shouldUsePhasedAsyncConversation(
  text: string,
  mode: LlmExecutionMode,
  opts: { enabled: boolean } = { enabled: true },
): boolean {
  return shouldEmitInterimAck(text, mode, opts);
}

export function buildInterimAckText(text: string, mode: LlmExecutionMode): string | null {
  if (!shouldEmitInterimAck(text, mode)) return null;

  const t = text.trim();
  for (const entry of KEYWORD_TEMPLATES) {
    if (entry.pattern.test(t)) {
      const candidate = entry.map[mode];
      if (candidate) return candidate;
    }
  }
  return DEFAULT_TEMPLATES[mode] || null;
}

function sanitizeInterimAckText(text: string): string {
  const firstSentence = text
    .replace(/^\[ts:[^\]]*\]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[。！？!?])/u)[0]
    ?.trim() ?? "";
  return firstSentence.slice(0, 36);
}

function looksLikeActualAnswer(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ANSWERISH_INTERIM_RE.test(t)) return true;
  if (/[:：]/u.test(t) && t.length > 18) return true;
  if (/[，,]/u.test(t) && t.length > 24) return true;
  return false;
}

export async function buildInterimAckTextWithLlm(opts: {
  text: string;
  mode: LlmExecutionMode;
  provider: ExternalChatProvider | null;
  timeoutMs?: number;
}): Promise<string | null> {
  const fallback = buildInterimAckText(opts.text, opts.mode);
  if (!shouldEmitInterimAck(opts.text, opts.mode)) return null;
  if (!opts.provider?.isEnabled()) return fallback;

  const sessionId = `interim-ack:${randomUUID()}`;
  const timeoutMs = opts.timeoutMs ?? INTERIM_ACK_TIMEOUT_MS;
  try {
    const generated = await Promise.race([
      opts.provider.streamCompletion(
        sessionId,
        {
          text:
            `User request:\n${opts.text}\n\n` +
            `Route mode: ${opts.mode}\n\n` +
            "Write the immediate acknowledgment only.",
        },
        () => {},
        undefined,
        {
          ephemeralTurn: true,
          systemPromptOverride: INTERIM_ACK_SYSTEM_PROMPT,
          modelOverride:
            process.env.INTERIM_ACK_MODEL?.trim() || process.env.FAST_MODEL?.trim() || undefined,
          maxThreadMessages: 2,
        },
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(""), timeoutMs),
      ),
    ]);
    const cleaned = sanitizeInterimAckText(generated);
    if (!cleaned || looksLikeActualAnswer(cleaned)) {
      return fallback;
    }
    return cleaned;
  } catch {
    return fallback;
  } finally {
    try {
      opts.provider.clearSession?.(sessionId);
    } catch {
      // ignore cleanup error
    }
  }
}

export function interimAckMessageId(traceId: string): string {
  return `interim-${traceId}`;
}

/**
 * 是否启用 LLM 生成 interim ack 文案。
 *
 * 默认关闭：走本地模板（`buildInterimAckText`，0ms）。
 * 仅当显式设置 `INTERIM_ACK_USE_LLM=1`，或配置了 `FAST_MODEL` / `INTERIM_ACK_MODEL` 时才启用 LLM 路径。
 *
 * 性能背景：LLM 路径每次会多消耗一次 kimi-k2.5 调用（~800-1000ms 首 token），
 * 而 sanitize + looksLikeActualAnswer 多数情况下会丢弃 LLM 输出回退到模板，
 * 净结果是把所有工具任务的首字延迟从 ~100ms 推到 ~1000ms。
 */
export function isInterimAckLlmEnabled(): boolean {
  if (process.env.INTERIM_ACK_USE_LLM === "1") return true;
  if (process.env.INTERIM_ACK_MODEL?.trim()) return true;
  if (process.env.FAST_MODEL?.trim()) return true;
  return false;
}
