import { randomUUID } from "node:crypto";

import type { ExternalChatProvider } from "../external-model/types.js";
import type { LlmExecutionMode } from "./task-router.js";

// ==================== 常量 ====================

const MAX_INTERIM_MESSAGES = 999;
const INITIAL_TIMEOUT_MS = 4500;
const SIMPLE_TEXT_THRESHOLD = 30;

// ==================== 主动在场（presence）常量 ====================
/**
 * GPT Live 式"持续在场"：complex 后台任务执行期间，周期性给 LLM 开口机会，
 * 生成一句自然互动（追问/反馈/闲聊），像真人边做边聊。
 * 从对话一开始（承接垫词之后）就尽快进入在场状态，工具执行期间持续维持聊天。
 * 节奏自适应：开口了说明对话有活力，间隔回到基准保持紧凑；
 * LLM 沉默（没话说）才轻量退避，且退避温和，避免长时间冷场。
 * presence 不设垫词条数上限——只要 complex 任务没完成（主回复未开始）
 * 就持续在场，完成后主回复自然衔接交付。
 */
/** 承接垫词之后，多久给第一次在场开口机会（对话尽快进入"边聊边干"状态） */
const PRESENCE_FIRST_TICK_MS = 3000;
/** 开口后的基准间隔：对话活跃期保持紧凑的聊天节奏 */
const PRESENCE_BASE_INTERVAL_MS = 4000;
/** 退避封顶：长时间无输出时最大间隔，避免无限轰炸 */
const PRESENCE_MAX_INTERVAL_MS = 12000;
/** 每次沉默后的间隔递增系数（温和退避，快速再试避免冷场） */
const PRESENCE_BACKOFF_FACTOR = 1.25;
/** presence 单次 LLM 生成的超时（给自然表达空间） */
const PRESENCE_TIMEOUT_MS = 3000;

/**
 * 流式语义段落切分的最小句长：低于该长度的"句"不单独成段，
 * 会与后续内容合并，避免把碎片标点/单字切成独立消息。
 */
const MIN_SEGMENT_CHARS = 12;
/** 段落边界：中文/英文句子结束符。命中即视为一个完整语义段落。 */
const SEGMENT_BOUNDARY_RE = /[。！？!?；;\n]/;

const NOISE_PREFIXES = /^(你好|hi|hello|hey|谢谢|thanks|thank you|再见|bye)[!，,。？?\s]*$/i;
const ANSWERISH_RE =
  /是指|就是|本质|核心|区别|原理|作用|主要|通常|比如|例如|指的是|简单说|一句话|换句话说|意思是|可以理解为|it is|it means|in short|for example|the difference/i;

/**
 * Interim 消息通道类型。
 * 文本聊天传达动作，主动联系是开口词。
 */
export type InterimChannel = "text_chat" | "proactive_text";

/**
 * interim prompt 集合（初始承接 / 主动在场），按通道分发。
 *
 * 设计原则：只给指导，不给示例。不硬编码具体话术、语气词列表。
 * 文字风格统一为"熟悉朋友式聊天"：放得开、能开玩笑、口语化、围绕话题聊，
 * 严禁任务过程通报（不提"正在查/搜到了/马上好"这类流水账）。
 * 垫词只针对聊天本身，与工具调用过程完全无关。
 * 只有 proactive_text（主动联系）是例外，它保留"开口词"语义。
 */
interface InterimPromptSet {
  initial: string;
  /** 主动在场（presence）仅在 complex 模式触发；无此配置的通道回退到 text_chat */
  presence?: string;
}

const PROMPTS_BY_CHANNEL: Record<InterimChannel, InterimPromptSet> = {
  // 文本聊天：熟悉朋友式聊天，围绕话题交流而非通报任务
  text_chat: {
    initial:
      "你是用户在聊天软件里的老朋友，关系熟、放得开、偶尔开玩笑。用户刚给你发来一句话，你要开始帮他处理这件事。先自然回应一句，像朋友聊天那样。\n\n" +
      "要求：\n" +
      "- 语气口语化、放得开，像熟人聊天，不是客服、不是汇报工作。\n" +
      "- 接住他刚说的话：表示你 get 到了、有点反应、必要时抛一句反问。\n" +
      "- 这是一段话的开场，别把答案或方案说出来。\n" +
      "- 一到两句，别硬凑字数。\n" +
      "- 输出消息本身。",
    presence:
      "你是用户在聊天软件里的老朋友。对话已经进行一会儿了，你正在帮用户处理他刚提出的问题，你们已经聊过几句。中间有一小段空当，但你不让他察觉你在'干活'——就当正常聊天，自然地找话说。\n\n" +
      "要求：\n" +
      "- 必须始终围绕他刚才的问题聊：反问、表态、玩笑、延伸相关话题、分享感受，像朋友闲聊；任何一句话都要跟他的话题有关，绝不跳到无关的事，也绝不要重新打招呼或表现得像刚见面。\n" +
      "- 严禁复述任务过程（不说'在查/马上好/搜到了/稍等'这类），也绝口不提你在看什么文章/网页/资料，不暴露任何查询、读取动作或具体来源。\n" +
      "- 别急着给答案、别剧透。\n" +
      "- 放得开，能开玩笑，口语化。\n" +
      "- 别重复你已经问过或说过的内容（比如刚问过预算就不要再问一遍）。\n" +
      "- 没话说就沉默（什么都不输出）。\n" +
      "- 一句到两句，输出消息本身。",
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
 * 内容驱动的多步回复分段器
 *
 * 不再使用定时器、随机、模板。真正的"多步回复"由 LLM 输出内容本身驱动：
 * - 复杂任务执行时，LLM 流式输出完整回复，本控制器按自然语义段落切分，
 *   每完成一个完整段落就作为一条独立消息推送给用户（像真人一句一句发）。
 * - 步数 = LLM 输出的段落数，完全不固定，由回复内容长短决定。
 * - 每段文字都是 LLM 自主生成的完整内容，agent 个性决定措辞。
 */
export class LivingInterimController {
  private messagesSent = 0;
  private initialSkipped = false;
  private readonly channel: InterimChannel;
  /** 已发送的消息历史，用于机制层面去重（非 prompt 注入） */
  private sentHistory: string[] = [];
  /** 流式累积缓冲：尚未达到段落边界的半截文本 */
  private segmentBuffer = "";

  // ── 主动在场（presence）状态：complex 后台任务执行期间持续自然互动 ──
  private presenceTimer: NodeJS.Timeout | null = null;
  private presenceBusy = false;
  private presenceIntervalMs = PRESENCE_BASE_INTERVAL_MS;
  private presenceUserText = "";
  /** 用户当前问题原文：所有垫词共享，保证互动始终围绕他的话题 */
  private userText = "";

  constructor(private cfg: LivingInterimConfig) {
    this.channel = cfg.channel ?? "text_chat";
  }

  /**
   * complex 复杂任务开始前的即时承接（fast 先开口）。
   * 由 LLM 自主生成一句自然承接，LLM 超时/失败时保持沉默。
   */
  async maybeEmitInitial(text: string): Promise<void> {
    this.userText = text;
    if (!this.shouldEmitInitial(text)) {
      this.initialSkipped = true;
      return;
    }
    if (this.cfg.isMainReplyStarted() || this.cfg.isStale()) {
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
   * 主回复流式推送入口：累积 LLM 输出的 delta，按自然语义段落切分，
   * 每完成一个完整段落就推送给用户；未完成的半截文本留待下次。
   *
   * 这是"多步回复"的核心：步数完全由 LLM 输出内容决定，无定时器。
   */
  feedStreamDelta(delta: string): void {
    if (this.cfg.isStale()) return;
    if (this.cfg.isMainReplyStarted()) return;
    this.segmentBuffer += delta;
    this.flushCompleteSegments();
  }

  /**
   * 主回复结束时调用：把缓冲中剩余的半截文本作为最后一条消息推送。
   */
  flushRemaining(): void {
    if (this.cfg.isStale()) return;
    if (this.cfg.isMainReplyStarted()) return;
    const rest = this.segmentBuffer.trim();
    this.segmentBuffer = "";
    if (!rest) return;
    this.trySend(rest);
  }

  /**
   * 丢弃缓冲（例如主回复已接管、turn 过期），避免残留半截文本。
   */
  discardBuffer(): void {
    this.segmentBuffer = "";
  }

  /**
   * 按自然语义段落边界把缓冲切成多条完整消息。
   * 边界：中文/英文句子结束符；低于最小句长的碎片不单独成段，留待合并。
   */
  private flushCompleteSegments(): void {
    // 从缓冲末尾向前扫描，找到最后一个仍"未闭合"的位置
    let lastBreak = -1;
    for (let i = 0; i < this.segmentBuffer.length; i++) {
      if (SEGMENT_BOUNDARY_RE.test(this.segmentBuffer[i])) {
        lastBreak = i;
      }
    }
    if (lastBreak < 0) return; // 还没有任何完整段落

    const complete = this.segmentBuffer.slice(0, lastBreak + 1).trim();
    this.segmentBuffer = this.segmentBuffer.slice(lastBreak + 1);

    if (!complete) return;
    // 太短的碎片合并到下一段，避免把单个标点/短句切成独立消息
    if (complete.length < MIN_SEGMENT_CHARS) {
      this.segmentBuffer = complete + this.segmentBuffer;
      return;
    }
    this.trySend(complete);
  }

  // ==================== 主动在场（presence）机制 ====================

  /**
   * complex 后台任务执行期间启动"主动在场"：周期性给 LLM 开口机会，
   * 自主生成一句自然互动（追问/反馈/闲聊），像真人边做边聊，而非静默等待。
   *
   * 节奏自适应：首次在 PRESENCE_FIRST_TICK_MS 后即给开口机会（承接垫词已发出，
   * 对话尽快进入"边聊边干"状态）；后续由 tickPresence 维护——
   * 开口则回到基准间隔保持紧凑，沉默则温和退避。
   * 不设垫词条数上限——主回复开始（complex 完成）或 turn 过期后自动收敛。
   */
  startPresence(userText: string): void {
    if (!this.cfg.enabled) return;
    if (this.cfg.mode !== "complex") return;
    if (this.presenceTimer) return;
    this.presenceUserText = userText;
    this.presenceIntervalMs = PRESENCE_BASE_INTERVAL_MS;
    // 首次开口机会：比基准更早，让对话从一开始就有在场感
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.tickPresence();
    }, PRESENCE_FIRST_TICK_MS);
    this.presenceTimer.unref?.();
  }

  /** 停止主动在场 ticker（turn 结束无论成败都调用，防泄漏） */
  stopPresence(): void {
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private async tickPresence(): Promise<void> {
    if (this.presenceBusy) return;
    // 主回复已开始（complex 完成）或 turn 已过期：主动在场完成使命，直接收敛
    if (this.cfg.isMainReplyStarted() || this.cfg.isStale()) {
      this.stopPresence();
      return;
    }
    this.presenceBusy = true;
    let spoke = false;
    try {
      const alreadySaid = this.sentHistory.length
        ? this.sentHistory.slice(-2).join(" | ")
        : "";
      const ackText = await this.generateAck({
        prompt:
          `The user asked you this and you're still working on it for him:\n${this.presenceUserText}\n` +
          (alreadySaid ? `You've already said: ${alreadySaid}\n` : "") +
          `The conversation is already in progress — keep chatting with him naturally about this topic. Don't repeat questions or remarks you've already made.`,
        systemPrompt:
          PROMPTS_BY_CHANNEL[this.channel].presence ??
          PROMPTS_BY_CHANNEL.text_chat.presence!, // text_chat 必有 presence
        timeoutMs: PRESENCE_TIMEOUT_MS,
      });
      this.trySend(ackText);
      spoke = ackText !== null;
    } finally {
      this.presenceBusy = false;
      if (spoke) {
        // 开口了：对话有活力，重置回基准间隔保持紧凑
        this.presenceIntervalMs = PRESENCE_BASE_INTERVAL_MS;
      } else {
        // LLM 沉默（没话说）：退避放缓，避免硬聊
        this.presenceIntervalMs = Math.min(
          PRESENCE_MAX_INTERVAL_MS,
          this.presenceIntervalMs * PRESENCE_BACKOFF_FACTOR,
        );
      }
      if (this.presenceTimer) {
        clearInterval(this.presenceTimer);
        this.presenceTimer = setInterval(() => {
          void this.tickPresence();
        }, this.presenceIntervalMs);
        this.presenceTimer.unref?.();
      }
    }
  }

  // ==================== 内部方法 ====================

  private shouldEmitInitial(text: string): boolean {
    if (!this.cfg.enabled) return false;
    const { mode } = this.cfg;
    const t = text.trim();
    if (!t || t.length < 4 || t.length > 2000) return false;
    if (NOISE_PREFIXES.test(t)) return false;

    // Fast 模式简单问题（<30 字）：不发承接，直接让主回复回答
    if (mode === "fast" && t.length < SIMPLE_TEXT_THRESHOLD) {
      return false;
    }
    // Fast 模式中等长度问题（30-80 字）：发承接（真人先接话再答）
    if (mode === "fast" && t.length < 80) {
      return true;
    }
    // complex 模式：总是发承接（后台任务需要时间）
    return true;
  }

  private canSend(): boolean {
    if (this.cfg.isStale()) return false;
    if (this.cfg.isMainReplyStarted()) return false;
    return this.messagesSent < MAX_INTERIM_MESSAGES;
  }

  private trySend(text: string | null): void {
    if (!text) return;
    if (!this.canSend()) return;
    const seq = this.messagesSent;
    this.cfg.send(text, seq);
    this.sentHistory.push(text);
    this.messagesSent++;
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
