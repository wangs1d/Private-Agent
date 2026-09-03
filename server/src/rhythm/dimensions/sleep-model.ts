import type { RhythmDimensionModel, RhythmObservation, SleepDimensionState } from "../types.js";
import { median } from "../time-utils.js";

const MAX_SAMPLES = 14;

export const EMPTY_SLEEP_STATE: SleepDimensionState = {
  samples: [],
  windowStartHour: null,
  windowEndHour: null,
  sampleCount: 0,
  trendMinutes: 0,
};

/**
 * 睡眠维度模型器。
 *
 * 输入观察：kind="sleep_sample"，value=入睡十进制小时，value2=醒来小时，
 * at=样本日（当天任意时刻）。同一 date 的样本去重（夜间重复分析不叠加）。
 * 状态：最近 14 个样本 + 中位数窗口 + 近 3 样本相对之前的趋势（分钟）。
 */
export class SleepDimensionModel implements RhythmDimensionModel<SleepDimensionState> {
  readonly dimension = "sleep" as const;

  ingest(
    prev: SleepDimensionState | null,
    observations: RhythmObservation[],
  ): SleepDimensionState {
    const byDate = new Map<string, { startHour: number; endHour: number }>();
    for (const sample of prev?.samples ?? []) {
      byDate.set(sample.date, { startHour: sample.startHour, endHour: sample.endHour });
    }
    for (const obs of observations) {
      if (obs.kind !== "sleep_sample" || !Number.isFinite(obs.value)) continue;
      const date = obs.at.slice(0, 10);
      if (!date) continue;
      // 新观察覆盖同日旧样本（数据源更新以最新为准）
      byDate.set(date, { startHour: obs.value, endHour: obs.value2 ?? obs.value });
    }
    const samples = [...byDate.entries()]
      .map(([date, s]) => ({ date, ...s }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_SAMPLES);

    const startHours = samples.map((s) => s.startHour);
    const endHours = samples.map((s) => s.endHour);

    // 跨午夜修正：入睡窗口常跨 0 点（23.5 与 0.9 实际相差 1.4h 而非 22.6h）。
    // 存在 ≥18 点样本且存在 <12 点样本时，把 <12 的样本 +24 后再取中位数/趋势。
    const crossesMidnight = startHours.some((h) => h >= 18) && startHours.some((h) => h < 12);
    const adj = (h: number): number => (crossesMidnight && h < 12 ? h + 24 : h);

    const windowStart = samples.length >= 3 ? median(startHours.map(adj)) % 24 : null;
    const windowEnd = samples.length >= 3 ? median(endHours.map(adj)) % 24 : null;

    const recent = startHours.slice(-3).map(adj);
    const prior = startHours.slice(0, Math.max(0, startHours.length - 3)).map(adj);
    let trendMinutes = prev?.trendMinutes ?? 0;
    if (recent.length >= 2 && prior.length >= 2) {
      trendMinutes = Math.round((median(recent) - median(prior)) * 60);
    }

    return {
      samples,
      windowStartHour: windowStart,
      windowEndHour: windowEnd,
      sampleCount: samples.length,
      trendMinutes,
    };
  }

  /** 7 个晚样本即满置信（出口 A 调整提醒的门槛） */
  confidence(state: SleepDimensionState): number {
    return Math.min(1, state.sampleCount / 7);
  }
}
