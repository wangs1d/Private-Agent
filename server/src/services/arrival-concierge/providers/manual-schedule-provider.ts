import type { TripStatusProvider, TripStatusQuery, TripStatusResult } from "../types.js";

/**
 * 票面兜底 Provider（永远可用）：没有外部 API key 时的最终降级。
 *
 * 返回票面的计划出发/到达时间作为基准，statusText 明确标注「票面时间」，
 * monitor 据此推导阶段；实时性由设备定位兜底（用户到达车站/机场附近
 * 地理围栏命中 → landed）。
 */
export class ManualScheduleProvider implements TripStatusProvider {
  readonly key = "manual-schedule";
  readonly label = "票面时间基准";
  readonly supportedTypes: ReadonlyArray<"flight" | "train"> = ["flight", "train"];

  availability(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  async query(q: TripStatusQuery): Promise<TripStatusResult> {
    if (!q.scheduledArriveTime) {
      return { ok: false, error: "票面缺少到达时间，无法建立监控基准" };
    }
    return {
      ok: true,
      statusText: "票面时间（未接实时动态）",
      estimatedArriveTime: q.scheduledArriveTime,
      actualArriveTime: null,
      delayMinutes: null,
      terminal: null,
      gate: null,
      note: "未配置航班/列车动态 API（VARIFLIGHT_APP_ID / JUHE_TRAIN_KEY），按票面时间监控；实时性由设备定位兜底",
    };
  }
}
