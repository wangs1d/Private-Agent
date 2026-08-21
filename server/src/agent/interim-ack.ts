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
 * 设计原则：只描述任务边界与结构约束，不硬编码语气、风格、语气词。
 * 语气/人格统一由 SOUL.md / USER.md / MEMORY.md few-shot 在会话上下文中注入，
 * 这里不再重复风格指令，避免多处指令互相打架。
 * 垫词只针对聊天本身，与工具调用过程完全无关；
 * 只有 proactive_text（主动联系）保留"开口词"语义。
 */
interface InterimPromptSet {
  initial: string;
  /** 主动在场（presence）仅在 complex 模式触发；无此配置的通道回退到 text_chat */
  presence?: string;
}

const PROMPTS_BY_CHANNEL: Record<InterimChannel, InterimPromptSet> = {
  text_chat: {
    initial:
      "用户刚给你发来一句话，你要开始处理这件事。先回应一句，作为一段对话的开场。\n\n" +
      "规则：\n" +
      "- 接住他刚说的话：表示你 get 到了、必要时抛一句反问；不要把答案或方案直接说出来。\n" +
      "- 一到两句，输出消息本身。",
    presence:
      "你正在帮用户处理他刚提出的问题，对话已经进行了几句。中间有一小段空当，自然地继续围绕他的话题聊。\n\n" +
      "规则：\n" +
      "- 始终围绕用户的问题聊：反问、表态、延伸相关话题、分享感受。不跳到无关的事，不重新打招呼。\n" +
      "- 严禁复述任务过程或进度，不暴露查询、读取动作或具体来源。\n" +
      "- 别急着给答案、别剧透。\n" +
      "- 不重复已经问过或说过的内容。\n" +
      "- 没话说就保持沉默（什么都不输出）。\n" +
      "- 一句到两句，输出消息本身。",
  },

  proactive_text: {
    initial:
      "You are proactively reaching out to the user via text. You noticed something worth mentioning. Send ONE opening message in the user's language.\n\n" +
      "Rules:\n" +
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
 * 活体 Interim 控制器：
 * - 垫词（maybeEmitInitial）：在主回复生成/执行前，以一句自然承接开头，
 *   由独立 LLM 生成，简洁、不说答案。
 * - 主动在场（presence ticker）：仅 complex 模式启用，工具执行长耗时阶段
 *   周期性给 LLM 开口机会，生成围绕当前话题的自然闲聊（追问/反馈/延伸），
 *   像真人"边做边聊"，不通报任务过程、不剧透答案。
 *
 * 主回复流式分段由 StreamSegmenter 统一负责，本控制器不再做内容驱动分段，
 * 仅通过 accumulateMainReplyText 跟踪主回复已输出文本，防止 presence
 * 闲聊与主回复或已发垫词重复。
 */
export class LivingInterimController {
  private messagesSent = 0;
  private initialSkipped = false;
  private readonly channel: InterimChannel;
  /** 已发送的消息历史，用于机制层面去重（非 prompt 注入） */
  private sentHistory: string[] = [];
  /** 主回复已流式输出的文本，避免 presence 闲聊与主回复重复 */
  private mainReplyText: string = "";
  /** tool loop 阶段的工具结果一句话摘要（有则注入 presence 上下文避免凭空瞎说） */
  private toolResultsSummary: string = "";

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
   * 主回复流式文本由 StreamSegmenter 统一分段推送。
   * 这里仅累积主回复已输出的正文，用于 presence 去重，
   * 避免主动在场的闲聊与主回复说过的话重复。
   */
  accumulateMainReplyText(fullText: string): void {
    this.mainReplyText = fullText;
  }

  /**
   * 复杂任务工具执行阶段，把已拿到的工具结果一句话摘要注入，
   * 让 presence 闲聊贴近事实进度（"快好了，看到价格了"之类），
   * 避免与主回复最终结论矛盾。不传则保持沉默。
   */
  setToolResultsSummary(summary: string): void {
    this.toolResultsSummary = summary;
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
      const mainReplyHead = this.mainReplyText
        ? this.mainReplyText.slice(0, 200)
        : "";
      const toolSummary = this.toolResultsSummary.trim();
      const ackText = await this.generateAck({
        prompt:
          `The user asked you this and you're still working on it for him:\n${this.presenceUserText}\n` +
          (alreadySaid ? `You've already said in filler: ${alreadySaid}\n` : "") +
          (mainReplyHead ? `Main reply already begun showing in chat: ${mainReplyHead}\nDo NOT repeat or contradict it.\n` : "") +
          (toolSummary ? `Recent findings from real tool results (hint only, do NOT reveal sources): ${toolSummary}\n` : "") +
          `The conversation is already in progress — keep chatting with him naturally about this topic. Don't repeat questions or remarks you've already made, and don't give away the final answer.`,
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
   * 机制层面去重：检查新生成的垫词是否与已发送垫词或主回复正文高度重叠。
   * 用字符 bigram Jaccard 相似度，> 0.5 视为重复，直接丢弃。
   * 不依赖 prompt 注入，纯程序保证。
   */
  private isDuplicateWithHistory(text: string): boolean {
    const candidates: string[] = [...this.sentHistory];
    if (this.mainReplyText) candidates.push(this.mainReplyText);
    if (candidates.length === 0) return false;
    const newTokens = bigramSet(text);
    for (const prev of candidates) {
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
