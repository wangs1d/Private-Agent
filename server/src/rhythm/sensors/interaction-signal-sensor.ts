import type { LifeSignalHubService } from "../../services/life-signal-hub-service.js";
import type { RhythmObservation, RhythmSensor } from "../types.js";

/**
 * 交互信号传感器：把 LifeSignalHub 的全部信号视为"用户在场"的弱观察
 * （对话推断 / 日程 / 智能家居等），低权重喂给 focus 维度，补足没有桌面
 * 桥接时的活跃时段画像。
 */
export class InteractionSignalSensor implements RhythmSensor {
  readonly id = "interaction-signal";
  readonly dimensions = ["focus" as const];

  constructor(private readonly signalHub: Pick<LifeSignalHubService, "recentSignals">) {}

  collect(actorId: string): RhythmObservation[] {
    const signals = this.signalHub.recentSignals(actorId, 100);
    const observations: RhythmObservation[] = [];
    for (const signal of signals) {
      if (signal.source === "desktop" || signal.kind.startsWith("desktop_")) continue;
      const at = new Date(signal.occurredAt);
      if (Number.isNaN(at.getTime())) continue;
      observations.push({
        dimension: "focus",
        at: at.toISOString(),
        value: at.getHours(),
        kind: "interaction",
        weight: 0.3,
        source: this.id,
      });
    }
    return observations;
  }
}
