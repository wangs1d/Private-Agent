import { randomUUID } from "node:crypto";

import type { ExternalChatProvider } from "../external-model/types.js";
import type { LlmExecutionMode } from "./task-router.js";

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

export async function buildInterimAckText(opts: {
  text: string;
  mode: LlmExecutionMode;
  provider: ExternalChatProvider | null;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!shouldEmitInterimAck(opts.text, opts.mode)) return null;
  if (!opts.provider?.isEnabled()) return null;

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
          maxThreadMessages: 2,
        },
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(""), timeoutMs),
      ),
    ]);
    const cleaned = sanitizeInterimAckText(generated);
    if (!cleaned || looksLikeActualAnswer(cleaned)) return null;
    return cleaned;
  } catch {
    return null;
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
