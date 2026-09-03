import type { LifeSignalHubService } from "../../services/life-signal-hub-service.js";
import type { RhythmObservation, RhythmSensor } from "../types.js";

/**
 * 桌面活动传感器：从 LifeSignalHub 的 desktop 信号（focus_change /
 * window_open / presence 等）提取每小时活跃观察。
 * 喂给 focus（专注时段）与 overtime（每日最后活跃时刻 → 晚归位）两个维度。
 */
export class DesktopActivitySensor implements RhythmSensor {
  readonly id = "desktop-activity";
  readonly dimensions = ["focus" as const, "overtime" as const];

  constructor(private readonly signalHub: Pick<LifeSignalHubService, "recentSignals">) {}

  collect(actorId: string): RhythmObservation[] {
    const signals = this.signalHub.recentSignals(actorId, 100);
    const observations: RhythmObservation[] = [];
    for (const signal of signals) {
      if (signal.source !== "desktop" && !signal.kind.startsWith("desktop_")) continue;
      const at = new Date(signal.occurredAt);
      if (Number.isNaN(at.getTime())) continue;
      observations.push({
        dimension: "focus",
        at: at.toISOString(),
        value: at.getHours(),
        kind: "desktop_active",
        weight: 1,
        source: this.id,
      });
    }
    return observations;
  }
}
