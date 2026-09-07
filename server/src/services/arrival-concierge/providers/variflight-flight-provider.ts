import type { TripStatusProvider, TripStatusQuery, TripStatusResult } from "../types.js";
import { deepPickString, postJson } from "../provider-utils.js";

/**
 * 航旅纵横（VariFlight）航班动态 Provider（真实航班状态）。
 *
 * 配置（server/.env.local）：
 *   VARIFLIGHT_APP_ID / VARIFLIGHT_APP_SECRET —— https://www.variflight.com 开放平台申请
 *   VARIFLIGHT_API_BASE —— 默认 https://gateway.variflight.com（接口路径若有调整在此覆盖）
 *
 * 解析策略：VariFlight 各接口字段命名有差异，统一在响应树里按候选字段
 * 深度查找（实际到达/预计到达/延误/航站楼），拿不到的字段返回 null，
 * 不阻塞 stage 推导（monitor 会用票面时间兜底）。
 */
export class VariflightFlightProvider implements TripStatusProvider {
  readonly key = "variflight";
  readonly label = "航旅纵横航班动态";
  readonly supportedTypes: ReadonlyArray<"flight" | "train"> = ["flight"];

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly apiBase: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.appId = env.VARIFLIGHT_APP_ID?.trim() ?? "";
    this.appSecret = env.VARIFLIGHT_APP_SECRET?.trim() ?? "";
    this.apiBase = (env.VARIFLIGHT_API_BASE?.trim() || "https://gateway.variflight.com").replace(/\/+$/, "");
  }

  availability(): { ok: boolean; reason?: string } {
    if (this.appId && this.appSecret) return { ok: true };
    return { ok: false, reason: "未配置 VARIFLIGHT_APP_ID / VARIFLIGHT_APP_SECRET（航旅纵横开放平台申请）" };
  }

  async query(q: TripStatusQuery): Promise<TripStatusResult> {
    const avail = this.availability();
    if (!avail.ok) return { ok: false, error: avail.reason ?? "provider 不可用" };

    const resp = await postJson(`${this.apiBase}/api/v1/flight/status`, {
      app_id: this.appId,
      app_secret: this.appSecret,
      fnum: q.code,
      date: q.date,
    });
    if (!resp.ok) return { ok: false, error: `航旅纵横查询失败：${resp.error}`, retryable: true };
    const data = resp.data;

    const statusText = deepPickString(data, ["flightstatus", "status", "flightstate", "状态"]) ?? "未知";
    const actual = deepPickString(data, ["actualarrivetime", "actarrtime", "realarrivetime", "实际到达时间"]);
    const estimated = deepPickString(data, ["estimatedarrivetime", "estarrtime", "expectedarrivetime", "预计到达时间"]);
    const scheduled = deepPickString(data, ["scheduledarrivetime", "scharrtime", "planearrivetime", "计划到达时间"]);
    const terminal = deepPickString(data, ["arriveterminal", "arrivalterminal", "destterminal", "到达航站楼"]);
    const gate = deepPickString(data, ["arrivalgate", "destgate", "到达口"]);

    const delayMinutes = this.computeDelay(scheduled, estimated ?? actual);

    return {
      ok: true,
      statusText,
      actualArriveTime: actual ?? null,
      estimatedArriveTime: estimated ?? scheduled ?? null,
      delayMinutes,
      terminal: terminal ?? null,
      gate: gate ?? null,
      note: "数据来自航旅纵横，字段以对方接口为准",
    };
  }

  private computeDelay(scheduled: string | null, actualOrEstimated: string | null): number | null {
    if (!scheduled || !actualOrEstimated) return null;
    const a = Date.parse(scheduled.replace(" ", "T"));
    const b = Date.parse(actualOrEstimated.replace(" ", "T"));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 60_000);
  }
}
