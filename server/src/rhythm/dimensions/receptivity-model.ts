import type { ReceptivityDimensionState, RhythmDimensionModel, RhythmObservation } from "../types.js";

const EWMA_ALPHA = 0.25;
/** 位置移动观察的（更低）更新步长：不是真实触达反馈，只作弱负信号 */
const MOVEMENT_ALPHA = 0.15;

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
 *
 * 位置扩展（方案 D）：location 传感器产出的 kind="location_movement" 观察
 * （value=0 移动中）以更低步长把对应时段的接受度拉向 0——通勤/外出时
 * 主动消息大概率被忽略。只消费移动负信号：静止（value=1）不贡献，
 * 避免高频位置上报虚增接受度；attempts 也只计真实触达反馈（置信度口径不变）。
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
      if (!Number.isFinite(obs.value)) continue;
      const at = new Date(obs.at);
      if (Number.isNaN(at.getTime())) continue;
      const hour = at.getHours();
      const weekday = at.getDay();

      if (obs.kind === "location_movement") {
        if (obs.value >= 0.5) continue; // 静止不贡献（位置传感器实际只产 value=0）
        byHour[hour] = (byHour[hour] ?? 0) * (1 - MOVEMENT_ALPHA);
        byWeekday[weekday] = (byWeekday[weekday] ?? 0) * (1 - MOVEMENT_ALPHA);
        continue;
      }

      if (obs.kind !== "contact_outcome") continue;
      const accepted = obs.value; // 0 / 0.5 / 1
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
