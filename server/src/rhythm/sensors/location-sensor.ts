import { haversineMeters } from "../../services/geo-utils.js";
import type { LocationHistoryService } from "../../services/location-history-service.js";
import type { RhythmObservation, RhythmSensor } from "../types.js";

/**
 * 位置传感器（位置方案 D）：把位置历史转成节律观察。
 *
 * 「用户在移动」是低接受度信号——通勤/外出时主动消息大概率被忽略。
 * 只产出移动观察（value=0）：静止不证明可打扰，不产出 value=1，
 * 避免 location 上报密度虚增 receptivity 画像（详见 receptivity-model 的
 * location_movement 分支）。
 *
 * 依赖位置历史（须开启 LOCATION_TRACKING_MODE=continuous），无数据时
 * collect 返回空数组，节律引擎零成本跳过。
 */

/** 相邻样本跳变超过该距离（米）视为一次移动 */
const MOVEMENT_JUMP_METERS = 120;
/** 两次移动观察的最小间隔（分钟）：一段通勤不重复记 */
const EMIT_GAP_MS = 20 * 60 * 1000;
/** 移动观察最长回看窗口：移动是短时信号，不回看超过 24h */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export class LocationSensor implements RhythmSensor {
  readonly id = "location";
  readonly dimensions = ["receptivity" as const];
  private readonly now: () => Date;

  constructor(
    private readonly history: Pick<LocationHistoryService, "query" | "movementStats">,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  collect(actorId: string, since: Date): RhythmObservation[] {
    const nowMs = this.now().getTime();
    const lookbackFrom = new Date(Math.max(since.getTime(), nowMs - MAX_LOOKBACK_MS));
    // 粗判：窗口内完全没有跳变就连样本都不用逐条看
    const stats = this.history.movementStats(actorId, nowMs - lookbackFrom.getTime(), MOVEMENT_JUMP_METERS);
    if (!stats.moving) return [];

    const samples = this.history.query(actorId, lookbackFrom, new Date(nowMs), 2000);
    const observations: RhythmObservation[] = [];
    let lastEmitAt = 0;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      const jumpMeters = haversineMeters(prev, cur);
      if (jumpMeters <= MOVEMENT_JUMP_METERS) continue;
      const at = Date.parse(cur.recordedAt);
      if (Number.isNaN(at)) continue;
      if (at - lastEmitAt < EMIT_GAP_MS) continue;
      lastEmitAt = at;
      observations.push({
        dimension: "receptivity",
        at: new Date(at).toISOString(),
        value: 0,
        kind: "location_movement",
        weight: 0.5,
        source: this.id,
        note: `位置跳变约 ${Math.round(jumpMeters)} 米（移动中）`,
      });
    }
    return observations;
  }
}
