import type { TripStatusProvider, TripStatusQuery, TripStatusResult } from "../types.js";
import { deepPickString, getJson } from "../provider-utils.js";

/**
 * 聚合数据「车次时刻表」列车 Provider。
 *
 * 说明（真实性边界，必须如实向用户转述）：国内没有面向个人的高铁实时
 * 晚点开放 API，本 provider 拉的是聚合数据的车次时刻表（真实铁路时刻，
 * 静态数据）——用于核对票面到达时间与时刻表是否一致、给到站阶段一个
 * 可靠基准；实时晚点检测由「设备定位 + 地理围栏」兜底（用户手机到达
 * 车站附近即视为 landed）。
 *
 * 配置（server/.env.local）：
 *   JUHE_TRAIN_KEY —— https://www.juhe.cn/docs/api/id/40 申请
 *   JUHE_TRAIN_API_BASE —— 默认 https://apis.juhe.cn
 */
export class JuheTrainProvider implements TripStatusProvider {
  readonly key = "juhe-train";
  readonly label = "聚合数据车次时刻表";
  readonly supportedTypes: ReadonlyArray<"flight" | "train"> = ["train"];

  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.JUHE_TRAIN_KEY?.trim() ?? "";
    this.apiBase = (env.JUHE_TRAIN_API_BASE?.trim() || "https://apis.juhe.cn").replace(/\/+$/, "");
  }

  availability(): { ok: boolean; reason?: string } {
    if (this.key) return { ok: true };
    return { ok: false, reason: "未配置 JUHE_TRAIN_KEY（聚合数据车次时刻表）" };
  }

  async query(q: TripStatusQuery): Promise<TripStatusResult> {
    const avail = this.availability();
    if (!avail.ok) return { ok: false, error: avail.reason ?? "provider 不可用" };

    const date = (q.date ?? "").replace(/-/g, "");
    const url = `${this.apiBase}/sptk/query?key=${encodeURIComponent(this.apiKey)}&date=${encodeURIComponent(date)}&train_code=${encodeURIComponent(q.code)}`;
    const resp = await getJson(url);
    if (!resp.ok) return { ok: false, error: `聚合数据查询失败：${resp.error}`, retryable: true };

    const data = resp.data;
    // 聚合数据错误码非 200：返回 errorcode/reason
    const errCode = deepPickString(data, ["errorcode", "resultcode"]);
    if (errCode && errCode !== "0" && errCode !== "200") {
      const reason = deepPickString(data, ["reason", "错误信息"]) ?? "接口返回错误";
      return { ok: false, error: `聚合数据错误（code=${errCode}）：${reason}`, retryable: true };
    }

    // 终点站到达时刻：优先匹配 to 站名，否则取列表最后一站
    const arrivalTime = this.extractArrival(data, q.to);
    if (!arrivalTime) {
      return { ok: false, error: "时刻表中未找到到达时刻", retryable: true };
    }

    let delayMinutes: number | null = null;
    if (q.scheduledArriveTime) {
      const sched = Date.parse(q.scheduledArriveTime.replace(" ", "T"));
      const ref = Date.parse(`${q.date}T${arrivalTime}:00`);
      if (Number.isFinite(sched) && Number.isFinite(ref)) {
        delayMinutes = Math.round((ref - sched) / 60_000);
      }
    }

    return {
      ok: true,
      statusText: "时刻表（非实时）",
      estimatedArriveTime: `${q.date} ${arrivalTime}`,
      actualArriveTime: null,
      delayMinutes,
      terminal: deepPickString(data, ["arrive_station", "endstation", "终到站"]),
      gate: null,
      note: "来自聚合数据车次时刻表（真实铁路时刻，非实时晚点数据）",
    };
  }

  /** 在 result.list 车站序列里找终点站到达时刻。 */
  private extractArrival(data: unknown, toStation?: string): string | null {
    if (data == null || typeof data !== "object") return null;
    const root = data as Record<string, unknown>;
    const result = (root.result ?? root) as Record<string, unknown>;
    const list = Array.isArray(result.list) ? result.list : null;
    if (!list || list.length === 0) return null;

    const stationName = (item: unknown): string =>
      String((item as Record<string, unknown>)?.station_name ?? (item as Record<string, unknown>)?.station ?? "");
    const arrivalOf = (item: unknown): string | null => {
      const rec = item as Record<string, unknown>;
      const v = rec?.arrival_time ?? rec?.arrive_time ?? rec?.arrivaltime;
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };

    if (toStation) {
      const hit = list.find((item) => stationName(item).includes(toStation));
      if (hit) {
        const t = arrivalOf(hit);
        if (t) return t;
      }
    }
    // 兜底：最后一站的到达时刻（终点站）
    return arrivalOf(list[list.length - 1]);
  }
}
