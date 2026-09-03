import type { RhythmConsumer, RhythmProfileUpdate } from "../types.js";

/** 出口 B 依赖的最小个性化服务接口（UserPersonalizationService 结构兼容） */
export type ReceptivityWriterPersonalization = {
  applyLearnedReceptivity(actorId: string, byHour: Record<string, number>): void;
};

/** 回填的最低置信度（≥6 次触达反馈） */
const MIN_CONFIDENCE = 0.5;

/**
 * 出口 B：把学到的按小时接受度回填 UserPersonalizationService 的
 * TimeRhythmState.receptiveHours —— ProactiveContactPolicyService 在主动
 * 联系决策里已经在读这个字段，回填后所有主动消息的时机立刻受益，
 * 无需任何新决策链路。
 */
export function createReceptiveHoursWriterConsumer(
  personalization: ReceptivityWriterPersonalization,
): RhythmConsumer {
  return (update: RhythmProfileUpdate) => {
    if (!update.changedDimensions.includes("receptivity")) return;
    if (update.confidences.receptivity < MIN_CONFIDENCE) return;
    const byHour: Record<string, number> = {};
    update.profile.dimensions.receptivity.byHour.forEach((score, hour) => {
      byHour[String(hour)] = score;
    });
    personalization.applyLearnedReceptivity(update.actorId, byHour);
  };
}
