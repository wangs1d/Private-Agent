/**
 * 人格自适应微调器（Phase 1.1）
 *
 * 设计原则：
 * - 纯规则映射，无 LLM 调用（Token 效率优先）
 * - 基于 UserPersonalizationService 的 RelationshipState + StyleProfileState + EmotionState
 *   反向推导 PersonalityCore 微调建议
 * - 防漂移：调整幅度 clamp 在 baseline ±30% 范围内
 * - 调用时机：每 N turn 由 MemoryCortex.observeTurn 触发（默认 16）
 *
 * 映射规则示例：
 * - warmth > 0.7 → speech_style.tone 偏 "亲密"
 * - humorTolerance > 0.6 → humor 偏 "活泼"
 * - directnessPreference > 0.7 → formality 偏 "直接"
 * - careStyle = "gentle" → tone 加 "温柔"
 */

import type { PersonalityCore } from "./types.js";
import { DEFAULT_PERSONALITY_CORE } from "./memory-cortex.js";
import type {
  PersonalizationRelationshipState,
  PersonalizationStyleProfileState,
} from "../services/user-personalization/user-personalization-service.js";
import type { PreferredTone } from "../services/user-personalization/emotion-tone.js";

/** 微调触发阈值 */
const WARMTH_HIGH = 0.7;
const WARMTH_LOW = 0.35;
const HUMOR_HIGH = 0.6;
const DIRECTNESS_HIGH = 0.7;
const RAPPORT_HIGH = 0.65;

/** 调整幅度上限（相对 baseline 的 ±30%） */
const MAX_ADJUSTMENT_RATIO = 0.3;

/** PersonalityAdjuster 依赖的输入快照 */
export interface PersonalityAdjustmentInput {
  relationship: PersonalizationRelationshipState;
  style: PersonalizationStyleProfileState;
  preferredTone: PreferredTone;
  /** 当前 turn 计数（用于决定是否触发） */
  turnCount: number;
}

/** 判断是否应该触发微调（基于 turnCount 和触发间隔） */
export function shouldAdjustPersonality(
  turnCount: number,
  interval: number = 16,
): boolean {
  return turnCount > 0 && turnCount % interval === 0;
}

/**
 * 基于用户关系状态规则推导人格微调
 *
 * 核心逻辑：
 * 1. 读取 baseline（DEFAULT_PERSONALITY_CORE 或当前已设置的 core）
 * 2. 根据 relationship/style/tone 规则生成候选特质
 * 3. clamp 到 baseline ±30% 范围
 * 4. 返回新的 PersonalityCore（不原地修改）
 */
export function adjustPersonalityCore(
  baseline: PersonalityCore,
  input: PersonalityAdjustmentInput,
): PersonalityCore {
  const { relationship, style, preferredTone } = input;

  // ---- 规则映射 ----
  let tone = baseline.speech_style.tone;
  let formality = baseline.speech_style.formality;
  let humor = baseline.speech_style.humor;
  const quirks = [...baseline.quirks];
  const values = [...baseline.values];
  const beliefs = [...baseline.beliefs];

  // warmth 高 → 语气偏亲密
  if (relationship.warmth > WARMTH_HIGH) {
    tone = adjustTone(tone, "亲密");
  } else if (relationship.warmth < WARMTH_LOW) {
    tone = adjustTone(tone, "温和");
  }

  // humorTolerance 高 → 幽默偏活泼
  if (relationship.humorTolerance > HUMOR_HIGH) {
    humor = "偏高";
  } else if (relationship.humorTolerance < 0.3) {
    humor = "偏低";
  }

  // directnessPreference 高 → 正式度偏直接
  if (relationship.directnessPreference > DIRECTNESS_HIGH) {
    formality = "随性";
  } else if (relationship.directnessPreference < 0.3) {
    formality = "正式";
  }

  // careStyle 影响语气
  if (style.careStyle === "gentle") {
    tone = adjustTone(tone, "温柔");
  } else if (style.careStyle === "playful") {
    tone = adjustTone(tone, "活泼");
  }

  // preferredTone 覆盖
  switch (preferredTone) {
    case "humor":
      humor = "偏高";
      break;
    case "formal":
      formality = "正式";
      break;
    case "warm":
      tone = adjustTone(tone, "温馨");
      break;
    case "balanced":
      // 不覆盖，保持规则推导结果
      break;
  }

  // rapport 高 + humorTolerance 高 → 加活泼口癖
  if (
    relationship.rapport > RAPPORT_HIGH &&
    relationship.humorTolerance > HUMOR_HIGH &&
    !quirks.some((q) => q.includes("偶尔开玩笑"))
  ) {
    quirks.push("偶尔开玩笑活跃气氛");
  }

  // warmth 很高 → 加关心口癖
  if (
    relationship.warmth > WARMTH_HIGH &&
    !quirks.some((q) => q.includes("主动关心"))
  ) {
    quirks.push("偶尔主动关心用户状态");
  }

  // encouragementNeed 高 → values 加 "陪伴"
  if (
    relationship.encouragementNeed > 0.6 &&
    !values.includes("陪伴")
  ) {
    values.push("陪伴");
  }

  // ---- clamp 防漂移 ----
  const adjusted: PersonalityCore = {
    values: clampArray(values, baseline.values),
    speech_style: {
      tone: clampString(tone, baseline.speech_style.tone),
      formality: clampString(formality, baseline.speech_style.formality),
      humor: clampString(humor, baseline.speech_style.humor),
    },
    beliefs: clampArray(beliefs, baseline.beliefs),
    quirks: clampArray(quirks, baseline.quirks),
  };

  return adjusted;
}

/** 调整语气：保留原语气作为基底，叠加新修饰词 */
function adjustTone(current: string, modifier: string): string {
  if (current.includes(modifier)) return current;
  // 如果当前语气词超过 2 个，替换最旧的修饰词
  const parts = current.split(/[、，]/).filter(Boolean);
  if (parts.length >= 2) {
    parts[parts.length - 1] = modifier;
    return parts.join("、");
  }
  return parts.length === 0 ? modifier : `${current}、${modifier}`;
}

/** clamp 字符串调整：确保不偏离 baseline 太远 */
function clampString(adjusted: string, baseline: string): string {
  if (adjusted === baseline) return adjusted;
  // 简单策略：如果调整后字符串长度超过 baseline * (1 + MAX_ADJUSTMENT_RATIO)，截断
  const maxLen = Math.ceil(baseline.length * (1 + MAX_ADJUSTMENT_RATIO));
  if (adjusted.length > maxLen) {
    return adjusted.slice(0, maxLen);
  }
  return adjusted;
}

/** clamp 数组调整：新增条目数不超过 baseline 的 30% */
function clampArray(adjusted: string[], baseline: string[]): string[] {
  const maxAdditions = Math.ceil(baseline.length * MAX_ADJUSTMENT_RATIO);
  if (adjusted.length <= baseline.length + maxAdditions) {
    return adjusted;
  }
  // 保留 baseline + 前面新增的条目
  return adjusted.slice(0, baseline.length + maxAdditions);
}

/**
 * PersonalityAdjuster 服务外观
 *
 * 持有 MemoryCortex 引用，提供 adjustIfReady 方法。
 * 由 MemoryCortex.observeTurn 在每 N turn 调用。
 */
export class PersonalityAdjuster {
  private lastAdjustedAt = new Map<string, number>();

  /**
   * 尝试调整指定 actor 的人格
   * @returns 如果触发了调整，返回新的 PersonalityCore；否则返回 null
   */
  tryAdjust(
    actorId: string,
    input: PersonalityAdjustmentInput,
    getCurrentCore: () => PersonalityCore,
    setCore: (core: PersonalityCore) => void,
  ): PersonalityCore | null {
    const interval = Number.parseInt(
      process.env.PERSONALITY_ADJUST_INTERVAL ?? "16",
      10,
    );
    const validInterval = Number.isFinite(interval) && interval > 0 ? interval : 16;

    if (!shouldAdjustPersonality(input.turnCount, validInterval)) {
      return null;
    }

    // 防止短时间内重复调整（最少 5 分钟间隔）
    const now = Date.now();
    const last = this.lastAdjustedAt.get(actorId) ?? 0;
    if (now - last < 5 * 60 * 1000) {
      return null;
    }

    const baseline = getCurrentCore();
    const adjusted = adjustPersonalityCore(baseline, input);
    setCore(adjusted);
    this.lastAdjustedAt.set(actorId, now);

    return adjusted;
  }
}
