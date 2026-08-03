/**
 * 预测动作合成器（Phase 3.2）
 *
 * 设计原则：
 * - 接收 SequencePatternMiner 的模式 + 当前事件流
 * - 若当前事件匹配某模式前缀，合成 PredictedAction（复用 BrainStem 现有类型）
 * - 复用 BrainStem 现有的 predicted_action 信号发布路径
 * - 无新 LLM 调用（Token 效率优先）
 *
 * 匹配逻辑：
 * - 取最近 N 个信号的 kind 序列
 * - 检查是否是某 pattern.sequence 的前缀（长度 ≥ 1）
 * - 若匹配，预测 pattern.sequence 的下一个 kind
 * - 置信度 = pattern.confidence * 时间衰减因子
 */

import type { Pattern } from "../services/sequence-pattern-miner.js";
import type { LifeSignal } from "../services/life-signal-types.js";
import type { PredictedAction } from "./brain-stem.js";

/** 最近信号的最小数量（用于前缀匹配） */
const MIN_RECENT_SIGNALS = 1;

/** 置信度时间衰减：超过 1 小时的 pattern 置信度衰减 50% */
const DECAY_HALF_LIFE_MS = 60 * 60 * 1000;

/**
 * 预测动作合成器
 */
export class PredictiveActionSynthesizer {
  /**
   * 基于序列模式预测用户的下一步动作
   *
   * @param patterns 已挖掘的序列模式
   * @param recentSignals 最近 N 个信号（按时间排序，最新在末尾）
   * @returns 预测结果（或 null 如果无匹配）
   */
  predict(
    patterns: Pattern[],
    recentSignals: LifeSignal[],
  ): PredictedAction | null {
    if (patterns.length === 0 || recentSignals.length < MIN_RECENT_SIGNALS) {
      return null;
    }

    // 提取最近信号的 kind 序列
    const recentKinds = recentSignals.map((s) => s.kind);
    const lastSignalTime = recentSignals[recentSignals.length - 1]
      ? Date.parse(recentSignals[recentSignals.length - 1]!.occurredAt)
      : Date.now();

    let bestMatch: {
      pattern: Pattern;
      nextKind: string;
      confidence: number;
    } | null = null;

    for (const pattern of patterns) {
      // 检查 recentKinds 是否是 pattern.sequence 的前缀
      const match = this.matchPrefix(pattern.sequence, recentKinds);
      if (!match) continue;

      // 计算时间衰减后的置信度
      const patternAge = lastSignalTime - Date.parse(pattern.lastSeenAt.toISOString());
      const decayFactor = patternAge > 0 ? Math.pow(0.5, patternAge / DECAY_HALF_LIFE_MS) : 1;
      const adjustedConfidence = pattern.confidence * decayFactor;

      // 选择置信度最高的匹配
      if (!bestMatch || adjustedConfidence > bestMatch.confidence) {
        bestMatch = {
          pattern,
          nextKind: match.nextKind,
          confidence: adjustedConfidence,
        };
      }
    }

    if (!bestMatch || bestMatch.confidence < 0.3) {
      return null;
    }

    // 预测时间：当前时间 + pattern.avgIntervalMs（剩余间隔）
    const now = Date.now();
    const elapsedSinceLast = now - lastSignalTime;
    const remainingInterval = Math.max(
      0,
      bestMatch.pattern.avgIntervalMs - elapsedSinceLast,
    );
    const predictedTime = new Date(now + remainingInterval).toISOString();

    // 将 kind 映射为人类可读的 action 描述
    const action = this.kindToAction(bestMatch.nextKind);

    return {
      action,
      confidence: Math.min(0.95, bestMatch.confidence),
      predictedTime,
    };
  }

  /**
   * 检查 recentKinds 是否是 sequence 的前缀
   * @returns 匹配时返回 { nextKind: 序列中下一个未匹配的 kind }，否则 null
   */
  private matchPrefix(
    sequence: string[],
    recentKinds: string[],
  ): { nextKind: string } | null {
    if (sequence.length <= 1) return null; // 单元素序列无法预测"下一个"

    // recentKinds 长度必须 < sequence 长度（否则已完整匹配，无"下一个"）
    if (recentKinds.length >= sequence.length) return null;

    // 检查前缀匹配
    for (let i = 0; i < recentKinds.length; i++) {
      if (sequence[i] !== recentKinds[i]) return null;
    }

    // 返回下一个 kind
    const nextKind = sequence[recentKinds.length];
    return nextKind ? { nextKind } : null;
  }

  /**
   * 将信号 kind 映射为人类可读的 action 描述
   */
  private kindToAction(kind: string): string {
    const descriptions: Record<string, string> = {
      sustained_busy: "持续忙碌",
      late_night_active: "深夜活跃",
      desktop_app_focus: "聚焦桌面应用",
      task_completed: "任务完成",
      transaction_completed: "交易完成",
      mood_shift: "情绪变化",
      going_out: "外出",
      meeting: "会议",
      in_focus: "专注工作",
      sleeping: "即将休息",
      idle: "空闲",
    };
    return descriptions[kind] || kind;
  }
}
