import type { ReceptivityDimensionState, RhythmDimensionModel, RhythmObservation } from "../types.js";

const EWMA_ALPHA = 0.25;

export const EMPTY_RECEPTIVITY_STATE: ReceptivityDimensionState = {
  byHour: new Array<number>(24).fill(0),
  byWeekday: new Array<number>(7).fill(0),
  attempts: 0,
};

/**
 * 触达接受度维度模型器。
 *
 * 数据不来自 collect 传感器，而是引擎在线 push（recordContactOutcome ←
 * UserPersonalizationService.observeContactOutcome 回调）。每次主动触达的
 * 结果更新对应小时/星期的接受度 EWMA：accepted/replied=1，dismissed/ignored=0，
 * snoozed=0.5（用户没拒绝但时机不对）。
 */
export class ReceptivityDimensionModel implements RhythmDimensionModel<ReceptivityDimensionState> {
  readonly dimension = "receptivity" as const;

  ingest(
    prev: ReceptivityDimensionState | null,
    observations: RhythmObservation[],
  ): ReceptivityDimensionState {
    const byHour = [...(prev?.byHour ?? EMPTY_RECEPTIVITY_STATE.byHour)];
    const byWeekday = [...(prev?.byWeekday ?? EMPTY_RECEPTIVITY_STATE.byWeekday)];
    let attempts = prev?.attempts ?? 0;

    for (const obs of observations) {
      if (obs.kind !== "contact_outcome" || !Number.isFinite(obs.value)) continue;
      const accepted = obs.value; // 0 / 0.5 / 1
      const at = new Date(obs.at);
      if (Number.isNaN(at.getTime())) continue;
      const hour = at.getHours();
      const weekday = at.getDay();
      byHour[hour] = (byHour[hour] ?? 0) * (1 - EWMA_ALPHA) + accepted * EWMA_ALPHA;
      byWeekday[weekday] = (byWeekday[weekday] ?? 0) * (1 - EWMA_ALPHA) + accepted * EWMA_ALPHA;
      attempts += 1;
    }

    return {
      byHour: byHour.map((x) => Math.round(x * 1000) / 1000),
      byWeekday: byWeekday.map((x) => Math.round(x * 1000) / 1000),
      attempts,
    };
  }

  /** ≥12 次触达反馈即满置信 */
  confidence(state: ReceptivityDimensionState): number {
    return Math.min(1, state.attempts / 12);
  }
}
