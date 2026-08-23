/**
 * 记忆隐式反馈检测器（Memory Implicit Feedback Detector）
 *
 * 背景：现有反馈闭环（MemoryFeedbackStore）只吃显式反馈（用户说"不对"/API 标注），
 * 而对话里大量有效的相关性信号被浪费了：
 *   - 用户重复问同一件事 → 上一轮召回的记忆没帮上忙（负反馈）
 *   - 用户纠正 agent → 记忆方向错了（负反馈）
 *   - 用户认同/延续话题 → 召回的记忆方向对（正反馈）
 *   - 用户突然完全换话题 → 召回的记忆可能不相关（微弱负反馈）
 *
 * 本模块每轮从对话形态中检测这些隐式信号，产出 MemoryFeedbackInput 兼容的
 * 结构，交给 MemoryCortex.recordMemoryFeedback 回灌（KV 持久化 + humanLike 节点
 * userFeedbackScore 更新），让"没说出口的评价"也能参与下一轮召回排序。
 *
 * 纯规则（不调 LLM，零延迟），信号强度分档：
 *   positive: 认同/话题延续 → +25% 上限的乘数
 *   negative: 纠正/重复提问 → 乘数衰减（下限 0.05）
 *   weak_negative: 无关转折 → 轻微降权
 */

export interface RecalledMemoryLite {
  content: string;
  score?: number;
}

export interface ImplicitFeedbackSignal {
  /** 反馈针对的记忆内容（semantic fingerprint 由 feedback store 计算） */
  memoryContent: string;
  signal: "positive" | "negative" | "weak_negative";
  /** 信号来源（诊断用） */
  reason: string;
}

export interface ImplicitFeedbackInput {
  actorId: string;
  /** 本轮用户输入 */
  userText: string;
  /** 上一轮用户输入（无则跳过重复提问检测） */
  prevUserText?: string;
  /** 上一轮 assistant 回复（话题延续检测用） */
  prevAssistantText?: string;
  /** 本轮实际注入 prompt 的召回记忆（反馈作用对象） */
  recalledMemories: RecalledMemoryLite[];
}

/** 纠正信号（强负反馈） */
const CORRECTION_RE =
  /(不是这样|不是这个|你错了|说错了|理解错|搞错了|我说的是|别(?:这样|这么)|不对|重新|搞什么)/;

/** 认同信号（正反馈） */
const AFFIRMATION_RE = /^(对|是的|没错|好的|嗯+|对对对|就是这样|说得对|正确|ok|okay|great|nice)[。！!~\s]*$/i;

/** 重复提问引导词 */
const REPEAT_RE = /(又|再|还|重复|same|again|还是)/;

/** 换话题转折词（弱负反馈：上轮召回可能不相关） */
const TOPIC_SWITCH_RE = /^(对了|话说回来|换个话题|另外|说个别的|by the way|btw)/i;

/** 2-gram 重合度（0-1）：两段文本的字符级相似度快算 */
function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const clean = s.replace(/[\s，。！？、,.!?~]/g, "").toLowerCase();
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
}

/** 词重合度：query 词在另一段文本中的命中率 */
function wordHitRate(query: string, text: string): number {
  const words = query.match(/[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9+#.-]{1,}/gi) ?? [];
  if (words.length === 0 || !text) return 0;
  const lower = text.toLowerCase();
  let hit = 0;
  for (const w of words) {
    if (lower.includes(w.toLowerCase())) hit++;
  }
  return hit / words.length;
}

/**
 * 检测一轮对话中的隐式记忆反馈信号。
 *
 * 优先级（一条记忆只吃一个最强信号，避免双重惩罚/奖励）：
 *   correction(negative) > repeat-ask(negative) > affirmation(positive)
 *   > topic-continuation(positive) > topic-switch(weak_negative)
 */
export function detectImplicitFeedback(input: ImplicitFeedbackInput): ImplicitFeedbackSignal[] {
  const userText = (input.userText ?? "").trim();
  if (!userText || input.recalledMemories.length === 0) return [];

  const memories = input.recalledMemories.slice(0, 5); // 只对注入 prompt 的前 5 条反馈
  const signals: ImplicitFeedbackSignal[] = [];
  const consumed = new Set<number>(); // 每条记忆只绑定一个信号

  // 1. 纠正 → 对上一轮召回记忆强负反馈
  if (CORRECTION_RE.test(userText)) {
    for (let i = 0; i < memories.length; i++) {
      signals.push({
        memoryContent: memories[i].content,
        signal: "negative",
        reason: "user_correction",
      });
      consumed.add(i);
    }
  }

  // 2. 重复提问 → 上轮记忆没帮上忙（负反馈）
  if (input.prevUserText && signals.length === 0) {
    const sim = bigramSimilarity(userText, input.prevUserText);
    if (sim >= 0.55 && REPEAT_RE.test(userText)) {
      for (let i = 0; i < memories.length; i++) {
        signals.push({
          memoryContent: memories[i].content,
          signal: "negative",
          reason: "repeat_ask_no_help",
        });
        consumed.add(i);
      }
    }
  }

  // 3. 认同 → 上轮召回记忆正反馈（通常是短回复，命中 AFFIRMATION 全文匹配）
  if (signals.length === 0 && AFFIRMATION_RE.test(userText)) {
    for (let i = 0; i < memories.length; i++) {
      signals.push({
        memoryContent: memories[i].content,
        signal: "positive",
        reason: "affirmation",
      });
      consumed.add(i);
    }
  }

  // 4. 话题延续 → 本轮 query 词大量出现在上轮 assistant 回复里，说明召回方向正确
  if (signals.length === 0 && input.prevAssistantText) {
    const hit = wordHitRate(userText, input.prevAssistantText);
    if (hit >= 0.4) {
      for (let i = 0; i < memories.length; i++) {
        if (consumed.has(i)) continue;
        signals.push({
          memoryContent: memories[i].content,
          signal: "positive",
          reason: "topic_continuation",
        });
      }
    }
  }

  // 5. 明显换话题 → 上轮召回的记忆大概率不相关（弱负反馈，仅作用于与当前 query 无关的记忆）
  if (signals.length === 0 && TOPIC_SWITCH_RE.test(userText)) {
    for (let i = 0; i < memories.length; i++) {
      const related = wordHitRate(userText, memories[i].content) > 0.15;
      if (related) continue; // 与新话题仍有词面关联的记忆不动
      signals.push({
        memoryContent: memories[i].content,
        signal: "weak_negative",
        reason: "topic_switch",
      });
    }
  }

  return signals;
}

/**
 * 门面：维护 actor 的上一轮对话状态，把检测出的信号翻译成
 * MemoryCortex.recordMemoryFeedback 的入参形态。
 */
export class MemoryImplicitFeedbackDetector {
  /** actorId → 上一轮 { userText, assistantText, recalledMemories } */
  private readonly lastTurn = new Map<
    string,
    { userText: string; assistantText: string; recalledMemories: RecalledMemoryLite[] }
  >();

  private readonly enabled: boolean;

  constructor() {
    const raw = process.env.MEMORY_IMPLICIT_FEEDBACK_ENABLED;
    this.enabled = raw === undefined ? true : !(raw === "0" || raw.toLowerCase() === "false");
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 每轮 cognize 后调用：
   * 1) 用上一轮状态检测本轮用户输入中的隐式反馈；
   * 2) 返回可回灌的反馈列表（调用方喂给 recordMemoryFeedback）；
   * 3) 更新内部"上一轮"状态为本轮（供下一轮检测）。
   */
  detectAndAdvance(
    actorId: string,
    turn: {
      userText: string;
      assistantText: string;
      recalledMemories: RecalledMemoryLite[];
    },
  ): ImplicitFeedbackSignal[] {
    if (!this.enabled) return [];
    const prev = this.lastTurn.get(actorId);
    let signals: ImplicitFeedbackSignal[] = [];
    if (prev) {
      signals = detectImplicitFeedback({
        actorId,
        userText: turn.userText,
        prevUserText: prev.userText,
        prevAssistantText: prev.assistantText,
        recalledMemories: prev.recalledMemories, // 反馈作用于"上一轮注入的记忆"
      });
    }
    // 记录本轮状态（记忆内容截断防爆内存）
    this.lastTurn.set(actorId, {
      userText: turn.userText.slice(0, 500),
      assistantText: turn.assistantText.slice(0, 500),
      recalledMemories: turn.recalledMemories.slice(0, 5).map((m) => ({
        content: m.content.slice(0, 300),
        score: m.score,
      })),
    });
    return signals;
  }

  /** 清理某 actor 的轮状态（会话结束时） */
  forget(actorId: string): void {
    this.lastTurn.delete(actorId);
  }
}
