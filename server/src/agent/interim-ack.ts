import { randomUUID } from "node:crypto";

import type { ExternalChatProvider } from "../external-model/types.js";
import type { LlmExecutionMode } from "./task-router.js";

// ==================== 常量 ====================

const MAX_INTERIM_MESSAGES = 3;
const MIN_INTERVAL_MS = 2000;
const INITIAL_TIMEOUT_MS = 4500;
const PROGRESS_TIMEOUT_MS = 1800;
const TOOL_PROGRESS_DELAY_MS = 1500;
const SIMPLE_TEXT_THRESHOLD = 30;

/** 初始垫词前的阅读延迟：模拟人看完消息再开口，800~1600ms 随机。 */
const INITIAL_READ_DELAY_MIN_MS = 800;
const INITIAL_READ_DELAY_MAX_MS = 1600;

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
      "You are in a text chat. The user just sent you a message. You read it and are about to work on it.\n\n" +
      "Write ONE natural message in the user's language that shows you've read and understood what they said.\n\n" +
      "Guidance:\n" +
      "- You are a real person chatting, not a service agent. Speak the way you'd text a friend.\n" +
      "- React to what they actually said — acknowledge the topic, show you get it, maybe ask a quick clarifying question if something is ambiguous.\n" +
      "- It's fine to be casual, use fillers, or express a brief reaction before getting to work.\n" +
      "- Do NOT give the actual answer or solution yet — just show you're on it.\n" +
      "- You're saying the FIRST sentence of your reply, not a separate acknowledgment.\n" +
      "- Treat what you say here as the opening of your real answer, not a placeholder.\n" +
      "- One or two sentences is natural; don't force brevity.\n" +
      "- Output ONLY the message.",
    progress:
      "You are in a text chat, working on something for the user. Send ONE message in the user's language so they know you're still on it.\n\n" +
      "Guidance:\n" +
      "- Sound like a person typing a quick update, not a status report.\n" +
      "- Indicate what you're doing or how it's going, briefly.\n" +
      "- Keep it short.\n" +
      "- Output ONLY the message.",
    toolDone:
      "You are in a text chat and just got a result you were waiting for. Send ONE natural reaction in the user's language.\n\n" +
      "Guidance:\n" +
      "- Sound like you just found something or finished something.\n" +
      "- Sometimes a minimal reaction is fine.\n" +
      "- Keep it short.\n" +
      "- Output ONLY the message.",
  },

  // 主动文本联系：开口词，告诉对方"我突然想起个事"
  proactive_text: {
    initial:
      "You are proactively reaching out to the user via text. You noticed something worth mentioning. Send ONE opening message in the user's language.\n\n" +
      "Guidance:\n" +
      "- Sound like a friend casually bringing something up, not an assistant reporting.\n" +
      "- Indicate why you're reaching out, without being verbose.\n" +
      "- Do not explain or justify the outreach.\n" +
      "- Keep it short.\n" +
      "- Output ONLY the message.",
    progress:
      "You are proactively doing something for the user via text and it's taking a moment. Send ONE message in the user's language so they know you're working on it.\n\n" +
      "Guidance:\n" +
      "- Sound like a person typing a quick update, not a status report.\n" +
      "- Indicate what you're doing, briefly.\n" +
      "- Keep it short.\n" +
      "- Output ONLY the message.",
    toolDone:
      "You are proactively working on something for the user via text and just got a result. Send ONE natural reaction in the user's language.\n\n" +
      "Guidance:\n" +
      "- Sound like you just found something or finished something.\n" +
      "- Sometimes a minimal reaction is fine.\n" +
      "- Keep it short.\n" +
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
  // 双模式下 fast 和 complex 都发垫词：
  // - fast：垫词 + 简单回复（真人节奏）
  // - complex：垫词先行，后台执行复杂任务，完成后分步推送
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
  const firstSentences = text
    .replace(/^\[ts:[^\]]*\]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[。！？!?])/u);
  // 允许取前两句话，给初始垫词更多空间表达（人说话不会只蹦一个词）
  const kept = firstSentences.slice(0, 2).join("").trim();
  return kept.slice(0, 72);
}

function looksLikeActualAnswer(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ANSWERISH_RE.test(t)) return true;
  if (/[:：]/u.test(t) && t.length > 36) return true;
  if (/[，,]/u.test(t) && t.length > 48) return true;
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

// ==================== 模板化垫词 ====================

/**
 * 模板化垫词：用预设话术 + 随机化生成垫词，避免每次都调 LLM。
 * 返回 null 表示该场景不适合模板化（如 userText 过长需要个性化），调用方应回退到 LLM 路径。
 */
const INITIAL_TEMPLATES_QUESTION = [
  "嗯,让我想想...",
  "这个问题有意思",
  "好问题,稍等哈",
  "嗯,这个问题我得想想",
];

const INITIAL_TEMPLATES_GENERAL = [
  "看到了,稍等",
  "嗯,稍等",
  "好的,我看下",
  "收到,稍等",
  "嗯,我处理一下",
  "稍等,我看看",
];

const TOOL_START_TEMPLATES = [
  "我查一下{toolName}...",
  "正在调用{toolName}",
  "稍等,我用{toolName}看看",
  "嗯,用{toolName}查一下",
  "正在用{toolName}处理",
  "让我看看{toolName}的结果",
];

const TOOL_END_TEMPLATES_OK = ["找到了", "搞定了", "嗯,有了", "好了,看到了", "行,查到了"];

const TOOL_END_TEMPLATES_FAIL = ["嗯,有点问题", "这个不太顺利", "嗯,没成功", "嗯,卡了一下"];

/** 模板化路径下，userText 超过此长度则放弃模板、回退 LLM 个性化 */
const TEMPLATE_USERTEXT_MAX_LEN = 200;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 把工具名 prettify 一下：search_web → "search web"，code.run → "code run" */
function prettifyToolName(toolName: string): string {
  return toolName.replace(/[_.]/g, " ").trim() || toolName;
}

/**
 * 用模板 + 随机化生成垫词，不走 LLM。
 * 返回 null 表示该场景不适合模板化，调用方应回退到 LLM 路径。
 */
export function generateTemplatedInterim(
  scene: "initial" | "tool_start" | "tool_end",
  context: { userText?: string; toolName?: string; ok?: boolean },
): string | null {
  switch (scene) {
    case "initial": {
      const userText = (context.userText ?? "").trim();
      // userText 过长 → 需要个性化，回退 LLM
      if (userText.length > TEMPLATE_USERTEXT_MAX_LEN) return null;
      const isQuestion = /[?？]/u.test(userText);
      const pool = isQuestion ? INITIAL_TEMPLATES_QUESTION : INITIAL_TEMPLATES_GENERAL;
      return pickRandom(pool);
    }
    case "tool_start": {
      const toolName = context.toolName?.trim();
      if (!toolName) return null;
      const pretty = prettifyToolName(toolName);
      return pickRandom(TOOL_START_TEMPLATES).replace(/\{toolName\}/g, pretty);
    }
    case "tool_end": {
      const ok = context.ok !== false;
      return pickRandom(ok ? TOOL_END_TEMPLATES_OK : TOOL_END_TEMPLATES_FAIL);
    }
    default:
      return null;
  }
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
  /** 已发送的垫词历史，用于机制层面去重（非 prompt 注入） */
  private sentHistory: string[] = [];

  constructor(private cfg: LivingInterimConfig) {
    this.channel = cfg.channel ?? "text_chat";
  }

  /**
   * 尝试发送初始确认。
   * 先等待一段随机阅读延迟（模拟人看完消息再开口），再让 LLM 生成自然垫词。
   * LLM 超时/失败时不发硬编码兜底，直接跳过（保持沉默比发模板更自然）。
   */
  async maybeEmitInitial(text: string): Promise<void> {
    if (!this.shouldEmitInitial(text)) {
      this.initialSkipped = true;
      return;
    }

    // 模拟人"看完消息再打字"的阅读延迟，避免回复来得太突兀
    const readDelay =
      INITIAL_READ_DELAY_MIN_MS +
      Math.random() * (INITIAL_READ_DELAY_MAX_MS - INITIAL_READ_DELAY_MIN_MS);
    await sleep(readDelay);

    // 延迟期间如果主回复已开始或 turn 已过期，跳过
    if (this.cfg.isMainReplyStarted() || this.cfg.isStale()) {
      return;
    }

    // 优先模板化生成（不走 LLM）；模板不适合或与历史重复时回退 LLM
    const templateAck = this.tryTemplateInterim("initial", { userText: text });
    if (templateAck) {
      this.trySend(templateAck);
      return;
    }
    const ackText = await this.generateAck({
      prompt: `The user just said:\n${text}\n\nReact naturally to what they said. Show you understood the topic.`,
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

    // 优先模板化生成（不走 LLM）；模板不适合或与历史重复时回退 LLM
    const templateAck = this.tryTemplateInterim("tool_start", { toolName });
    if (templateAck) {
      this.trySend(templateAck);
      return;
    }
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

    // 优先模板化生成（不走 LLM）；模板不适合或与历史重复时回退 LLM
    const templateAck = this.tryTemplateInterim("tool_end", { toolName, ok });
    if (templateAck) {
      this.trySend(templateAck);
      return;
    }
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
    const t = text.trim();
    if (!t || t.length < 4 || t.length > 2000) return false;
    if (NOISE_PREFIXES.test(t)) return false;

    // Fast 模式简单问题（<30 字）：不发垫词，直接让主回复回答
    // 垫词本身要调一次 LLM（~1-4s），对「现在几点」这类问题完全是额外延迟
    // 且垫词容易被当成最终回复（如「现在几点啊？我看看哈。」）
    if (mode === "fast" && t.length < SIMPLE_TEXT_THRESHOLD) {
      return false;
    }
    // Fast 模式中等长度问题（30-80 字）：60% 概率发垫词
    if (mode === "fast" && t.length < 80) {
      return Math.random() > 0.4;
    }
    // complex 模式：几乎总是发垫词（后台任务需要时间）
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
    this.sentHistory.push(text);
    this.messagesSent++;
    this.lastMessageAt = Date.now();
  }

  /**
   * 尝试用模板生成垫词；返回 null 表示模板不可用或与历史重复（应回退 LLM）。
   * 模板垫词同样要过 isDuplicateWithHistory 去重。
   */
  private tryTemplateInterim(
    scene: "initial" | "tool_start" | "tool_end",
    context: { userText?: string; toolName?: string; ok?: boolean },
  ): string | null {
    const tpl = generateTemplatedInterim(scene, context);
    if (!tpl) return null;
    if (this.isDuplicateWithHistory(tpl)) return null;
    return tpl;
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
      // 机制层面去重：与已发送的垫词相似度 > 0.5 → 丢弃，保持沉默
      if (this.isDuplicateWithHistory(cleaned)) {
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

  /**
   * 机制层面去重：检查新生成的垫词是否与已发送的某条垫词高度重叠。
   * 用字符 bigram Jaccard 相似度，> 0.5 视为重复，直接丢弃。
   * 不依赖 prompt 注入，纯程序保证。
   */
  private isDuplicateWithHistory(text: string): boolean {
    if (this.sentHistory.length === 0) return false;
    const newTokens = bigramSet(text);
    for (const prev of this.sentHistory) {
      const prevTokens = bigramSet(prev);
      const intersection = [...newTokens].filter((t) => prevTokens.has(t)).length;
      const union = new Set([...newTokens, ...prevTokens]).size;
      if (union === 0) continue;
      const jaccard = intersection / union;
      if (jaccard > 0.5) return true;
    }
    return false;
  }
}

/** 把文本切成字符 bigram 集合，用于相似度比较 */
function bigramSet(text: string): Set<string> {
  const clean = text.replace(/\s+/g, "").toLowerCase();
  if (clean.length < 2) return new Set([clean]);
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}
