/**
 * 用户习惯学习服务,移植自 photography_agent.habit。
 * 记录拍摄参数与批图调整偏差,总结偏好画像并提供个性化推荐。
 */
import type { UserHabit } from '../models.js';
import { nowIso } from '../models.js';

interface ShootingRecord {
  focalLength: number;
  compositionRule: string;
  sceneType: string;
}

interface BatchRecord {
  preset: Record<string, number>;
  manual: Record<string, number>;
  delta: Record<string, number>;
}

export interface RecommendResult {
  recommended: {
    recommendedFocalLength: number;
    recommendedComposition: string;
    recommendedScenePreset: string | null;
    recommendedBatchStyle: Record<string, number>;
  };
  confidence: number;
  basedOnRecords: number;
}

/** 频次统计,取前 N(频次相同按首次出现顺序稳定) */
function topN(values: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value]) => value);
}

export class HabitService {
  private readonly habits = new Map<string, UserHabit>();
  private readonly shootingHistory = new Map<string, ShootingRecord[]>();
  private readonly batchHistory = new Map<string, BatchRecord[]>();

  recordShooting(userId: string, focalLength: number, compositionRule: string, sceneType: string): { recorded: boolean; totalRecords: number } {
    const history = this.shootingHistory.get(userId) ?? [];
    history.push({ focalLength, compositionRule, sceneType });
    this.shootingHistory.set(userId, history);
    return { recorded: true, totalRecords: history.length };
  }

  /** 从拍摄历史总结偏好(焦段 top3 / 构图 top2 / 场景 top3) */
  learnShootingPreference(userId: string): UserHabit {
    const history = this.shootingHistory.get(userId) ?? [];
    const topFocal = topN(history.map((record) => String(record.focalLength)), 3).map(Number);
    const topComp = topN(history.map((record) => record.compositionRule), 2);
    const topScene = topN(history.map((record) => record.sceneType), 3);

    const existing = this.habits.get(userId);
    const habit: UserHabit = {
      userId,
      preferredFocalLengths: topFocal,
      preferredCompositionRules: topComp,
      preferredSceneTypes: topScene,
      batchStyleAvg: existing?.batchStyleAvg ?? {},
      updatedAt: nowIso(),
    };
    this.habits.set(userId, habit);
    return habit;
  }

  getHabit(userId: string): UserHabit | null {
    return this.habits.get(userId) ?? null;
  }

  /** 记录批图手动调整,计算 manual - preset 偏差 */
  recordBatchAdjustment(
    userId: string,
    presetAdjustments: Record<string, number>,
    manualAdjustments: Record<string, number>,
  ): { recorded: boolean; delta: Record<string, number>; totalRecords: number } {
    const delta: Record<string, number> = {};
    for (const [key, manualValue] of Object.entries(manualAdjustments)) {
      if (typeof manualValue !== 'number') {
        continue;
      }
      const presetValue = presetAdjustments[key] ?? 0;
      delta[key] = manualValue - presetValue;
    }
    const history = this.batchHistory.get(userId) ?? [];
    history.push({ preset: { ...presetAdjustments }, manual: { ...manualAdjustments }, delta });
    this.batchHistory.set(userId, history);
    return { recorded: true, delta, totalRecords: history.length };
  }

  /** 批图偏差均值 */
  learnBatchStyle(userId: string): { avgDelta: Record<string, number>; sampleCount: number } {
    const history = this.batchHistory.get(userId) ?? [];
    if (history.length === 0) {
      return { avgDelta: {}, sampleCount: 0 };
    }
    const sumBy: Record<string, { sum: number; count: number }> = {};
    for (const record of history) {
      for (const [key, value] of Object.entries(record.delta)) {
        sumBy[key] ??= { sum: 0, count: 0 };
        sumBy[key]!.sum += value;
        sumBy[key]!.count += 1;
      }
    }
    const avgDelta: Record<string, number> = {};
    for (const [key, { sum, count }] of Object.entries(sumBy)) {
      avgDelta[key] = sum / count;
    }
    return { avgDelta, sampleCount: history.length };
  }

  updateHabitBatchStyle(userId: string): UserHabit {
    const { avgDelta } = this.learnBatchStyle(userId);
    const existing = this.habits.get(userId);
    const habit: UserHabit = {
      userId,
      preferredFocalLengths: existing?.preferredFocalLengths ?? [],
      preferredCompositionRules: existing?.preferredCompositionRules ?? [],
      preferredSceneTypes: existing?.preferredSceneTypes ?? [],
      batchStyleAvg: avgDelta,
      updatedAt: nowIso(),
    };
    this.habits.set(userId, habit);
    return habit;
  }

  private defaultFocalByScene(sceneType?: string): number {
    if (!sceneType) {
      return 50;
    }
    if (sceneType.includes('portrait')) {
      return 85;
    }
    if (sceneType.includes('landscape')) {
      return 24;
    }
    if (sceneType.includes('street')) {
      return 35;
    }
    return 50;
  }

  /** 基于画像的个性化推荐 */
  recommend(userId: string, context: { sceneType?: string; shootingTarget?: string } = {}): RecommendResult {
    const habit = this.habits.get(userId);
    const recordsCount = this.shootingHistory.get(userId)?.length ?? 0;

    let recommendedFocalLength: number;
    if (habit && habit.preferredFocalLengths.length > 0) {
      recommendedFocalLength = habit.preferredFocalLengths[0]!;
    } else {
      let sceneForDefault = context.sceneType;
      if (!sceneForDefault && habit && habit.preferredSceneTypes.length > 0) {
        sceneForDefault = habit.preferredSceneTypes[0];
      }
      recommendedFocalLength = this.defaultFocalByScene(sceneForDefault);
    }

    const recommendedComposition =
      habit && habit.preferredCompositionRules.length > 0 ? habit.preferredCompositionRules[0]! : 'thirds';

    let recommendedScenePreset: string | null = null;
    if (context.sceneType) {
      recommendedScenePreset = context.sceneType;
    } else if (habit && habit.preferredSceneTypes.length > 0) {
      recommendedScenePreset = habit.preferredSceneTypes[0]!;
    }

    const recommendedBatchStyle = habit?.batchStyleAvg ?? {};

    const confidence = recordsCount <= 5 ? 0.3 : recordsCount <= 10 ? 0.6 : 0.9;

    return {
      recommended: {
        recommendedFocalLength,
        recommendedComposition,
        recommendedScenePreset,
        recommendedBatchStyle,
      },
      confidence,
      basedOnRecords: recordsCount,
    };
  }
}
