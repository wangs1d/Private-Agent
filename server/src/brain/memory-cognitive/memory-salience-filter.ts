// Agent Brain Center — MemorySalienceFilter（情绪标记与显著性守门人）
//
// 职责：作为"什么值得被记住"的守门人，基于情绪向量与显著性评分过滤写入。
//   - 写入前评估 salienceScore，低显著性记忆直接拒绝或降级
//   - 情绪向量融合：综合 emotionValence + importance + 用户反馈 + 新颖度 → salienceScore (0-1)
//   - 显著性调制召回：当前情绪状态影响召回权重（仅调优先级，不删除记忆）
//
// 设计要点：
//   - 不调 LLM，纯规则加权计算
//   - 三档决策：reject（< 0.2）/ decay（0.2-0.4）/ accept（>= 0.4）
//   - 阈值可通过环境变量运行时配置

import type { MemoryItem, EmotionVector, SalienceDecision } from "../types.js";

/** 显著性评分加权系数（总和 = 1.0） */
const WEIGHT_EMOTION_VALENCE = 0.4;
const WEIGHT_IMPORTANCE = 0.3;
const WEIGHT_USER_FEEDBACK = 0.2;
const WEIGHT_NOVELTY = 0.1;

/** 默认阈值 */
const DEFAULT_REJECT_THRESHOLD = 0.2;
const DEFAULT_DECAY_THRESHOLD = 0.4;

/** 拒绝阈值环境变量名 */
const ENV_REJECT_THRESHOLD = "BRAIN_MEMORY_SALIENCE_REJECT_THRESHOLD";
/** 降级阈值环境变量名 */
const ENV_DECAY_THRESHOLD = "BRAIN_MEMORY_SALIENCE_DECAY_THRESHOLD";
/** 主开关环境变量名（缺省开启，BRAIN_MEMORY_SALIENCE_ENABLED=0 时关闭） */
const ENV_ENABLED = "BRAIN_MEMORY_SALIENCE_ENABLED";

/** 召回调制条目（情绪调制用） */
export interface RecallModulationItem {
  content: string;
  score?: number;
  emotionTags?: string[];
}

/** 将数值夹紧到 [0, 1]；非有限值归零 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** 四舍五入到 4 位小数，消除浮点噪声，保证决策与断言稳定 */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 从 unknown 中解析有限数值；非数值/字符串解析失败返回 null */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** importance 字符串映射到 0-1 权重；缺省视为 medium (0.5) */
function importanceToWeight(importance: MemoryItem["importance"]): number {
  switch (importance) {
    case "critical":
      return 1.0;
    case "high":
      return 0.8;
    case "medium":
      return 0.5;
    case "low":
      return 0.3;
    default:
      return 0.5;
  }
}

/** 归一化单个标签：去首尾空格 + 小写（对中文为 no-op，对英文标签更鲁棒） */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** 从 EmotionVector 构造标签集合（label + secondaryLabel） */
function buildEmotionTagSet(emotion: EmotionVector): Set<string> {
  const set = new Set<string>();
  if (emotion.label) set.add(normalizeTag(emotion.label));
  if (emotion.secondaryLabel) set.add(normalizeTag(emotion.secondaryLabel));
  return set;
}

/**
 * 计算 Jaccard 相似度（交集 / 并集）作为情绪匹配度。
 * - 任一集合为空 → 0（无匹配基础）
 */
function computeJaccard(itemTags: string[] | undefined, emotionTags: Set<string>): number {
  if (emotionTags.size === 0) return 0;
  const itemSet = new Set<string>();
  if (itemTags) {
    for (const t of itemTags) {
      if (typeof t === "string" && t.length > 0) itemSet.add(normalizeTag(t));
    }
  }
  if (itemSet.size === 0) return 0;
  let intersection = 0;
  for (const t of itemSet) {
    if (emotionTags.has(t)) intersection++;
  }
  const unionSize = new Set([...itemSet, ...emotionTags]).size;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

/**
 * 显著性守门人：基于情绪向量与显著性评分过滤记忆写入。
 *
 * 不调 LLM，纯规则加权计算 salienceScore：
 *   salienceScore = emotionValence权重 * 0.4
 *                 + importance权重   * 0.3
 *                 + userFeedback权重 * 0.2
 *                 + novelty权重      * 0.1
 *
 * 三档决策：
 *   - score < rejectThreshold(0.2)                    → accept=false（拒绝写入）
 *   - rejectThreshold <= score < decayThreshold(0.4)  → accept=true, degraded=true（降级为 decay）
 *   - score >= decayThreshold(0.4)                     → accept=true, degraded=false（正常写入）
 */
export class MemorySalienceFilter {
  /** 主开关是否开启（缺省开启，BRAIN_MEMORY_SALIENCE_ENABLED=0 时关闭） */
  private isEnabled(): boolean {
    const raw = process.env[ENV_ENABLED]?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") return false;
    return true;
  }

  /** 读取拒绝阈值（运行时可由环境变量 BRAIN_MEMORY_SALIENCE_REJECT_THRESHOLD 覆盖） */
  private getRejectThreshold(): number {
    const raw = process.env[ENV_REJECT_THRESHOLD];
    const v = raw != null ? Number(raw) : NaN;
    return Number.isFinite(v) ? v : DEFAULT_REJECT_THRESHOLD;
  }

  /** 读取降级阈值（运行时可由环境变量 BRAIN_MEMORY_SALIENCE_DECAY_THRESHOLD 覆盖） */
  private getDecayThreshold(): number {
    const raw = process.env[ENV_DECAY_THRESHOLD];
    const v = raw != null ? Number(raw) : NaN;
    return Number.isFinite(v) ? v : DEFAULT_DECAY_THRESHOLD;
  }

  /**
   * 评估单条记忆的显著性，返回写入决策。
   * 主入口，由 MemoryCortex.remember 在写入前调用。
   * 主开关关闭时返回默认接受决策（不做过滤，向后兼容）。
   */
  evaluateSalience(item: MemoryItem): SalienceDecision {
    // 降级开关：关闭时直接接受所有记忆（向后兼容）
    if (!this.isEnabled()) {
      return { accept: true, score: 1.0, reason: "salience_filter_disabled", degraded: false };
    }
    const metadata = item.metadata;

    // emotionValence: -1..1 归一化到 0..1，无值时 0.5（中性）
    const evRaw = toFiniteNumber(metadata?.emotionValence);
    const emotionValence = evRaw == null ? 0.5 : clamp01((evRaw + 1) / 2);

    // importance: 字符串映射到 0..1
    const importance = importanceToWeight(item.importance);

    // userFeedback: 0..1，无值时 0.5
    const ufRaw = toFiniteNumber(metadata?.userFeedbackScore);
    const userFeedback = ufRaw == null ? 0.5 : clamp01(ufRaw);

    // novelty: 0..1（1 表示全新内容），无值时 0.5
    const novRaw = toFiniteNumber(metadata?.novelty);
    const novelty = novRaw == null ? 0.5 : clamp01(novRaw);

    const rawScore =
      emotionValence * WEIGHT_EMOTION_VALENCE +
      importance * WEIGHT_IMPORTANCE +
      userFeedback * WEIGHT_USER_FEEDBACK +
      novelty * WEIGHT_NOVELTY;

    const score = round4(clamp01(rawScore));
    const rejectThreshold = this.getRejectThreshold();
    const decayThreshold = this.getDecayThreshold();

    if (score < rejectThreshold) {
      return { accept: false, score, reason: "salience_score_too_low", degraded: false };
    }
    if (score < decayThreshold) {
      return { accept: true, score, reason: "degraded_to_decay", degraded: true };
    }
    return { accept: true, score, reason: "normal_write", degraded: false };
  }

  /**
   * 情绪状态调制召回：根据当前情绪向量调整召回条目的 score。
   *
   * - emotionTags 与 currentEmotion 标签 overlap 高 → score 上浮（最高 +0.2）
   * - overlap 低 → score 下浮（最低 -0.1）
   * - score 夹紧到 [0, 1]
   * - currentEmotion 为 null 时原样返回（不调制、不删除任何记忆）
   *
   * 注意：仅调整召回优先级，不删除任何记忆节点。
   */
  modulateRecallByEmotion(
    items: RecallModulationItem[],
    currentEmotion: EmotionVector | null,
  ): RecallModulationItem[] {
    // 降级开关或无情绪向量 → 不调制，原样返回（同一引用）
    if (!this.isEnabled() || currentEmotion == null) {
      return items;
    }

    const emotionTagSet = buildEmotionTagSet(currentEmotion);

    return items.map((item) => {
      const matchDegree = computeJaccard(item.emotionTags, emotionTagSet);
      const baseScore = item.score == null ? 0.5 : item.score;
      // 匹配度高 → 上浮（最高 +0.2）；匹配度低 → 下浮（最低 -0.1）
      const adjusted = baseScore + 0.2 * matchDegree - 0.1 * (1 - matchDegree);
      return {
        content: item.content,
        emotionTags: item.emotionTags,
        score: round4(clamp01(adjusted)),
      };
    });
  }
}
