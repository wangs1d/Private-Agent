import type { RhythmObservation, RhythmSensor } from "../types.js";

/** 睡眠样本来源（AwarenessCortex 的最小接口，bootstrap 注入；测试可桩替） */
export type SleepSampleSource = {
  getRecentSleepWindowSamples(
    actorId: string,
    limit?: number,
  ): Array<{ date: string; startHour: number; endHour: number }>;
};

/**
 * 睡眠传感器：从 AwarenessCortex 的学习样本拉取入睡/醒来窗口。
 * AwarenessCortex 依据桌面无活动 + 夜间时段判定 sleeping 会话（≥30min 计样本）。
 */
export class SleepWindowSensor implements RhythmSensor {
  readonly id = "sleep-window";
  readonly dimensions = ["sleep" as const];
  /** 睡眠样本链自检：源已绑定且 runtime 在跑时每轮应有观察；零观察=断供（2026-10-05 事故教训） */
  readonly expectsObservations = true;

  private source: SleepSampleSource | null = null;

  /** bootstrap 在 AwarenessCortex 实例化后注入（brain 关闭时保持 null，无观察产出） */
  bindSource(source: SleepSampleSource | null): void {
    this.source = source;
  }

  collect(actorId: string): RhythmObservation[] {
    if (!this.source) return [];
    const samples = this.source.getRecentSleepWindowSamples(actorId, 14);
    return samples.map((sample) => ({
      dimension: "sleep" as const,
      // 样本只有日期（AwarenessCortex 按 dayKey 记录），取正午避免时区偏移串日
      at: `${sample.date}T12:00:00`,
      value: sample.startHour,
      value2: sample.endHour,
      kind: "sleep_sample",
      source: this.id,
    }));
  }
}
