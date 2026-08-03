// Agent Brain Center — EmotionModulator（情感调制）
//
// 职责：让情绪状态参与推理置信度计算。
//   接入 LimbicCortex 的 EmotionVector，根据 VAD 三维度调整推理置信度。
//
// 核心原则：
//   1. EmotionState 可选：emotion=null 时不调制，返回原值
//   2. 不强制依赖 LimbicCortex：bootstrap 注入时若 LimbicCortex 不可用，
//      emotionModulator 仍可用（emotion=null 路径）
//   3. 最终置信度 clamp 到 [0, 1]
//
// 情绪影响规则：
//   - 高唤醒度（arousal > 0.7）→ +0.1（紧张时直觉更敏锐）
//   - 低唤醒度（arousal < 0.3）→ -0.05（放松时直觉迟钝）
//   - 正向情绪（valence > 0.5）→ +0.05（好心情直觉更乐观）
//   - 负向情绪（valence < -0.3）→ -0.1（坏心情直觉更悲观、更保守）
//   - 高 dominance（> 0.7）→ +0.05（自信时直觉更果断）
//
// 详见 task: 4 项仿人推理能力新增

// ============================================================
// 类型
// ============================================================

/**
 * 情绪状态（VAD 模型）。
 *
 * 与 brain/types.ts 的 EmotionVector 兼容但独立：
 *   - EmotionVector.arousal 是 0~1（LimbicCortex 实现）
 *   - EmotionState.arousal 标注为 -1~1（接口契约），但实际阈值逻辑对 0~1 也成立
 *
 * 转换由调用方（brain-center / create-app-services）负责。
 */
export interface EmotionState {
  /** 唤醒度（-1~1，实际实现常用 0~1） */
  arousal: number;
  /** 效价（-1 极负 ~ 1 极正） */
  valence: number;
  /** 支配度（-1~1，实际实现常用 0~1） */
  dominance: number;
}

// ============================================================
// 常量
// ============================================================

/** 高唤醒度加成（紧张时直觉更敏锐） */
const HIGH_AROUSAL_BONUS = 0.1;
/** 低唤醒度惩罚（放松时直觉迟钝） */
const LOW_AROUSAL_PENALTY = -0.05;
/** 正向情绪加成（好心情直觉更乐观） */
const POSITIVE_VALENCE_BONUS = 0.05;
/** 负向情绪惩罚（坏心情直觉更悲观、更保守） */
const NEGATIVE_VALENCE_PENALTY = -0.1;
/** 高支配度加成（自信时直觉更果断） */
const HIGH_DOMINANCE_BONUS = 0.05;

// 阈值
const HIGH_AROUSAL_THRESHOLD = 0.7;
const LOW_AROUSAL_THRESHOLD = 0.3;
const POSITIVE_VALENCE_THRESHOLD = 0.5;
const NEGATIVE_VALENCE_THRESHOLD = -0.3;
const HIGH_DOMINANCE_THRESHOLD = 0.7;

// ============================================================
// 工具函数
// ============================================================

/** 限制数值在 [min, max] 区间 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ============================================================
// EmotionModulator 主类
// ============================================================

/**
 * 情感调制器：根据情绪状态调整推理置信度。
 *
 * 不调 LLM。纯阈值判断 + 加减法。
 *
 * 用法：
 *   const modulator = new InferenceEmotionModulator();
 *   const adjusted = modulator.modulate(0.6, { arousal: 0.8, valence: 0.6, dominance: 0.5 });
 *   // adjusted = 0.6 + 0.1 (高唤醒) + 0.05 (正向) = 0.75
 */
export class InferenceEmotionModulator {
  /**
   * 根据情绪状态调整推理置信度。
   *
   * 调整规则：
   *   - arousal > 0.7 → +0.1
   *   - arousal < 0.3 → -0.05
   *   - valence > 0.5 → +0.05
   *   - valence < -0.3 → -0.1
   *   - dominance > 0.7 → +0.05
   *
   * 各项可叠加，最终 clamp 到 [0, 1]。
   * emotion=null 时不调制，返回原值。
   *
   * @param confidence 原始置信度
   * @param emotion 情绪状态（null 表示不调制）
   * @returns 调制后的置信度（0~1）
   */
  modulate(confidence: number, emotion: EmotionState | null): number {
    if (emotion === null) return confidence;

    let delta = 0;

    // 唤醒度
    if (emotion.arousal > HIGH_AROUSAL_THRESHOLD) {
      delta += HIGH_AROUSAL_BONUS;
    } else if (emotion.arousal < LOW_AROUSAL_THRESHOLD) {
      delta += LOW_AROUSAL_PENALTY;
    }

    // 效价
    if (emotion.valence > POSITIVE_VALENCE_THRESHOLD) {
      delta += POSITIVE_VALENCE_BONUS;
    } else if (emotion.valence < NEGATIVE_VALENCE_THRESHOLD) {
      delta += NEGATIVE_VALENCE_PENALTY;
    }

    // 支配度
    if (emotion.dominance > HIGH_DOMINANCE_THRESHOLD) {
      delta += HIGH_DOMINANCE_BONUS;
    }

    return clamp(confidence + delta, 0, 1);
  }

  /**
   * 获取情绪对推理的影响说明（debug 用）。
   *
   * 返回人类可读字符串，列出各项调制项及最终 delta。
   * emotion=null 时返回 "无情绪调制"。
   */
  explainModulation(emotion: EmotionState | null): string {
    if (emotion === null) return "无情绪调制（emotion=null）";

    const items: string[] = [];
    let delta = 0;

    if (emotion.arousal > HIGH_AROUSAL_THRESHOLD) {
      items.push(`高唤醒(arousal=${emotion.arousal.toFixed(2)})→+${HIGH_AROUSAL_BONUS}`);
      delta += HIGH_AROUSAL_BONUS;
    } else if (emotion.arousal < LOW_AROUSAL_THRESHOLD) {
      items.push(`低唤醒(arousal=${emotion.arousal.toFixed(2)})→${LOW_AROUSAL_PENALTY}`);
      delta += LOW_AROUSAL_PENALTY;
    }

    if (emotion.valence > POSITIVE_VALENCE_THRESHOLD) {
      items.push(`正向情绪(valence=${emotion.valence.toFixed(2)})→+${POSITIVE_VALENCE_BONUS}`);
      delta += POSITIVE_VALENCE_BONUS;
    } else if (emotion.valence < NEGATIVE_VALENCE_THRESHOLD) {
      items.push(`负向情绪(valence=${emotion.valence.toFixed(2)})→${NEGATIVE_VALENCE_PENALTY}`);
      delta += NEGATIVE_VALENCE_PENALTY;
    }

    if (emotion.dominance > HIGH_DOMINANCE_THRESHOLD) {
      items.push(`高支配(dominance=${emotion.dominance.toFixed(2)})→+${HIGH_DOMINANCE_BONUS}`);
      delta += HIGH_DOMINANCE_BONUS;
    }

    if (items.length === 0) {
      return `情绪无显著影响(arousal=${emotion.arousal.toFixed(2)},valence=${emotion.valence.toFixed(2)},dominance=${emotion.dominance.toFixed(2)})，delta=0`;
    }

    return `${items.join("; ")}；总 delta=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`;
  }
}
