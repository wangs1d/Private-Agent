import { randomUUID } from "node:crypto";

import type { ExternalChatProvider } from "../external-model/types.js";
import type { LlmExecutionMode } from "./task-router.js";

// ==================== 常量 ====================

const MAX_INTERIM_MESSAGES = 3;
const MIN_INTERVAL_MS = 2000;
const INITIAL_TIMEOUT_MS = 2500;
const PROGRESS_TIMEOUT_MS = 1800;
const TOOL_PROGRESS_DELAY_MS = 1500;
const SIMPLE_TEXT_THRESHOLD = 30;

const NOISE_PREFIXES = /^(你好|hi|hello|hey|谢谢|thanks|thank you|再见|bye)[!，,。？?\s]*$/i;
const ANSWERISH_RE =
  /是指|就是|本质|核心|区别|原理|作用|主要|通常|比如|例如|指的是|简单说|一句话|换句话说|意思是|可以理解为|it is|it means|in short|for example|the difference/i;

/**
 * Interim 消息通道类型。
 * 文本聊天传达动作，主动联系是开口词。
 */
export type InterimChannel = "text_chat" | "proactive_text";

/**
 * 三套 interim prompt（初始确认 / 进度更新 / 工具完成），按通道分发。
 *
 * 设计原则：只给指导，不给示例。不硬编码具体话术、语气词列表、禁止项，
 * 让模型根据上下文自行发挥。
 */
interface InterimPromptSet {
  initial: string;
  progress: string;
  toolDone: string;
}

const PROMPTS_BY_CHANNEL: Record<InterimChannel, InterimPromptSet> = {
  // 文本聊天：传达"我在做什么"
  text_chat: {
    initial:
      "You are in a text chat. The user just sent a message. Reply with ONE very short message in the user's language indicating you're picking it up.\n\n" +
      "Guidance:\n" +
      "- Sound like a person typing casually, not a service agent.\n" +
      "- Indicate you're starting on it, without being verbose.\n" +
      "- Do not answer or explain anything yet.\n" +
      "- Keep it very short.\n" +
      "- Output ONLY the message.",
    progress:
      "You are in a text chat, working on something for the user. Send ONE very short message in the user's language so they know you're still on it.\n\n" +
      "Guidance:\n" +
      "- Sound like a person typing a quick update, not a status report.\n" +
      "- Indicate what you're doing or how it's going, briefly.\n" +
      "- Keep it very short.\n" +
      "- Output ONLY the message.",
    toolDone:
      "You are in a text chat and just got a result you were waiting for. Send ONE very short natural reaction in the user's language.\n\n" +
      "Guidance:\n" +
      "- Sound like you just found something or finished something.\n" +
      "- Sometimes a minimal reaction is fine.\n" +
      "- Keep it very short.\n" +
      "- Output ONLY the message.",
  },

  // 主动文本联系：开口词，告诉对方"我突然想起个事"
  proactive_text: {
    initial:
      "You are proactively reaching out to the user via text. You noticed something worth mentioning. Send ONE very short opening message in the user's language.\n\n" +
      "Guidance:\n" +
      "- Sound like a friend casually bringing something up, not an assistant reporting.\n" +
      "- Indicate why you're reaching out, without being verbose.\n" +
      "- Do not explain or justify the outreach.\n" +
      "- Keep it very short.\n" +
      "- Output ONLY the message.",
    progress:
      "You are proactively doing something for the user via text and it's taking a moment. Send ONE very short message in the user's language so they know you're working on it.\n\n" +
      "Guidance:\n" +
      "- Sound like a person typing a quick update, not a status report.\n" +
      "- Indicate what you're doing, briefly.\n" +
      "- Keep it very short.\n" +
      "- Output ONLY the message.",
    toolDone:
      "You are proactively working on something for the user via text and just got a result. Send ONE very short natural reaction in the user's language.\n\n" +
      "Guidance:\n" +
      "- Sound like you just found something or finished something.\n" +
      "- Sometimes a minimal reaction is fine.\n" +
      "- Keep it very short.\n" +
      "- Output ONLY the message.",
  },
};

// ==================== 工具函数 ====================

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

export function interimAckMessageId(traceId: string, seq: number = 0): string {
  return seq === 0 ? `interim-${traceId}` : `interim-${traceId}-${seq}`;
}

function sanitizeInterimText(text: string): string {
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
  if (ANSWERISH_RE.test(t)) return true;
  if (/[:：]/u.test(t) && t.length > 18) return true;
  if (/[，,]/u.test(t) && t.length > 24) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 工具上下文提取 ====================

/**
 * 从工具 input 中提取关键上下文信息，供 LLM 生成有针对性的进度文案。
 */
function extractToolContext(toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  const pushStr = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) parts.push(v.trim().slice(0, 100));
  };

  switch (toolName) {
    case "search_web":
    case "web_search":
      pushStr(input.query ?? input.q ?? input.keyword);
      break;
    case "fetch_web":
      pushStr(input.url ?? input.link);
      break;
    case "code.run":
    case "code_run":
      pushStr(input.language ?? input.lang);
      pushStr(input.code ? String(input.code).slice(0, 80) : "");
      break;
    case "get_weather":
    case "weather":
      pushStr(input.location ?? input.city ?? input.place);
      break;
    case "voice.send_message":
    case "voice_send_message":
      pushStr(input.text);
      break;
    default:
      for (const v of Object.values(input)) {
        if (parts.length >= 3) break;
        pushStr(v);
      }
  }
  return parts.filter(Boolean).join(" | ");
}

// ==================== 活体 Interim 控制器 ====================

export interface LivingInterimConfig {
  sessionId: string;
  traceId: string;
  mode: LlmExecutionMode;
  enabled: boolean;
  provider: ExternalChatProvider | null;
  send: (text: string, seq: number) => void;
  isStale: () => boolean;
  isMainReplyStarted: () => boolean;
  /**
   * 消息通道类型。不同通道的垫词风格不同：
   *  - voice: 语音通话，填充静音
   *  - text_chat: 文本聊天，传达动作
   *  - proactive_text: 主动联系，开口词
   * 默认 text_chat。
   */
  channel?: InterimChannel;
}

/**
 * 活体 Interim 控制器
 *
 * 按通道选择指导原则，让 LLM 自行生成自然垫词：
 * - 有时一声就开始干活，有时跳过直接回复
 * - 干活久了会自言自语让对方知道还在
 * - 找到东西了会有情绪反应
 * - 不是每步都播报，有随机性
 */
export class LivingInterimController {
  private messagesSent = 0;
  private lastMessageAt = 0;
  private initialSkipped = false;
  private activeTools = new Map<string, number>();
  private readonly channel: InterimChannel;

  constructor(private cfg: LivingInterimConfig) {
    this.channel = cfg.channel ?? "text_chat";
  }

  /**
   * 尝试发送初始确认。
   * 按通道选择指导原则，让 LLM 自行生成自然垫词。
   * LLM 超时/失败时不发硬编码兜底，直接跳过（保持沉默比发模板更自然）。
   */
  async maybeEmitInitial(text: string): Promise<void> {
    if (!this.shouldEmitInitial(text)) {
      this.initialSkipped = true;
      return;
    }

    const ackText = await this.generateAck({
      prompt: `The user just said:\n${text}\n\nReact naturally.`,
      systemPrompt: PROMPTS_BY_CHANNEL[this.channel].initial,
      timeoutMs: INITIAL_TIMEOUT_MS,
    });
    this.trySend(ackText);
  }

  /**
   * 工具开始执行时触发。
   * 延迟 1.5s 后检查工具是否仍在运行，避免对快速工具发无意义进度。
   */
  async onToolStart(toolName: string, input: Record<string, unknown>): Promise<void> {
    if (this.initialSkipped) return;
    this.activeTools.set(toolName, Date.now());

    await sleep(TOOL_PROGRESS_DELAY_MS);

    if (!this.activeTools.has(toolName)) return;

    // 50% 概率不发进度——有时沉默反而更自然
    if (Math.random() < 0.5) return;

    const toolCtx = extractToolContext(toolName, input);
    const ackText = await this.generateAck({
      prompt:
        `You're currently doing this: ${toolName} (${toolCtx})\n` +
        `It's taking a moment.`,
      systemPrompt: PROMPTS_BY_CHANNEL[this.channel].progress,
      timeoutMs: PROGRESS_TIMEOUT_MS,
    });
    this.trySend(ackText);
  }

  /**
   * 工具执行结束时触发。
   * 60% 概率有反应，40% 概率沉默直接进入回复。
   */
  async onToolEnd(toolName: string, input: Record<string, unknown>, ok: boolean): Promise<void> {
    this.activeTools.delete(toolName);
    if (this.initialSkipped) return;

    // 40% 概率不发声——找到东西了不一定每次都要说
    if (Math.random() < 0.4) return;

    const toolCtx = extractToolContext(toolName, input);
    const ackText = await this.generateAck({
      prompt:
        `You just ${ok ? "got a result" : "hit a snag"} for: ${toolName} (${toolCtx})\n` +
        `React naturally.`,
      systemPrompt: PROMPTS_BY_CHANNEL[this.channel].toolDone,
      timeoutMs: PROGRESS_TIMEOUT_MS,
    });
    this.trySend(ackText);
  }

  // ==================== 内部方法 ====================

  private shouldEmitInitial(text: string): boolean {
    if (!this.cfg.enabled) return false;
    const { mode } = this.cfg;
    if (mode === "fast_chat") return false;
    const t = text.trim();
    if (!t || t.length < 4 || t.length > 2000) return false;
    if (NOISE_PREFIXES.test(t)) return false;

    // 简单任务：有时直接回复，不嗯嗯啊啊
    if (mode === "direct_llm" && t.length < SIMPLE_TEXT_THRESHOLD) {
      return Math.random() > 0.4;
    }
    if (mode === "master_only" && t.length < SIMPLE_TEXT_THRESHOLD) {
      return Math.random() > 0.2;
    }
    return true;
  }

  private canSend(): boolean {
    if (this.cfg.isStale()) return false;
    if (this.cfg.isMainReplyStarted()) return false;
    if (this.messagesSent >= MAX_INTERIM_MESSAGES) return false;
    if (this.messagesSent > 0) {
      const elapsed = Date.now() - this.lastMessageAt;
      if (elapsed < MIN_INTERVAL_MS) return false;
    }
    return true;
  }

  private trySend(text: string | null): void {
    if (!text) return;
    if (!this.canSend()) return;
    const seq = this.messagesSent;
    this.cfg.send(text, seq);
    this.messagesSent++;
    this.lastMessageAt = Date.now();
  }

  private async generateAck(opts: {
    prompt: string;
    systemPrompt: string;
    timeoutMs: number;
  }): Promise<string | null> {
    if (!this.cfg.provider?.isEnabled()) {
      return null;
    }

    const sessionId = `interim-ack:${randomUUID()}`;
    try {
      const generated = await Promise.race([
        this.cfg.provider.streamCompletion(
          sessionId,
          { text: opts.prompt },
          () => {},
          undefined,
          {
            ephemeralTurn: true,
            systemPromptOverride: opts.systemPrompt,
            maxThreadMessages: 2,
          },
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(""), opts.timeoutMs),
        ),
      ]);
      const cleaned = sanitizeInterimText(generated);
      if (!cleaned || looksLikeActualAnswer(cleaned)) {
        // LLM 返回空或像实际答案 → 保持沉默（不发硬编码兜底）
        return null;
      }
      return cleaned;
    } catch {
      // LLM 调用异常 → 保持沉默
      return null;
    } finally {
      try {
        this.cfg.provider.clearSession?.(sessionId);
      } catch {
        // ignore
      }
    }
  }
}
