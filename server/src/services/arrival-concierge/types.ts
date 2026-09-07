/**
 * 到站管家（接站 / 接机 / 到站打车）类型定义。
 *
 * 场景：用户乘飞机/高铁出行，Agent 通过票夹（travelTicketStore）得知行程，
 * 到站前动态跟踪航班/车次状态，在「快到了」时：
 *   - 主动通知接站人（短信 / 微信桥真实外发），或
 *   - 协助约车（提案 → 用户确认后走统一预订层 ride 域真实下单）
 */

/** 行程阶段（monitor 按 provider 快照推导）。 */
export type TripStage =
  | "scheduled"   // 未出发
  | "departed"    // 已出发（超过票面出发时间）
  | "approaching" // 快到了：预计到达 - now ≤ 45 分钟
  | "landed"      // 已落地 / 已到站
  | "settled";    // 到达后 2 小时，监控收尾

export const TRIP_STAGE_LABELS: Record<TripStage, string> = {
  scheduled: "未出发",
  departed: "已出发",
  approaching: "即将到达",
  landed: "已到达",
  settled: "行程结束",
};

/** 单次状态查询快照（provider 返回字段可缺省，monitor 容错合并）。 */
export interface TripStatusSnapshot {
  stage: TripStage;
  /** 票面到达时间（原始串，来自票夹） */
  scheduledArriveTime: string | null;
  /** 动态预计到达时间（延误/提前时与票面不同；ISO 或原样串） */
  estimatedArriveTime: string | null;
  /** 实际到达时间（落地/到站后） */
  actualArriveTime: string | null;
  /** 相对票面的延误分钟数（正=晚点，负=提前） */
  delayMinutes: number | null;
  /** 航站楼 / 到站台 */
  terminal: string | null;
  /** 登机口 / 车厢出口等补充 */
  gate: string | null;
  /** provider 状态描述（如「已起飞」「计划」「到达」） */
  statusText: string;
  /** 数据来源 provider key */
  provider: string;
  checkedAt: string;
}

export interface TripStatusQuery {
  type: "flight" | "train";
  /** 航班号 / 车次 */
  code: string;
  /** 出发日期 YYYY-MM-DD */
  date: string;
  from?: string;
  to?: string;
  scheduledDepartTime?: string;
  scheduledArriveTime?: string;
}

export type TripStatusResult =
  | {
      ok: true;
      statusText: string;
      estimatedArriveTime?: string | null;
      actualArriveTime?: string | null;
      delayMinutes?: number | null;
      terminal?: string | null;
      gate?: string | null;
      note?: string;
    }
  | { ok: false; error: string; retryable?: boolean };

/**
 * 航班/车次状态 Provider 接口。
 *
 * 约束与 BookingProvider 一致：不得抛异常；缺 API key 时 availability 返回
 * 不可用原因，monitor 自动降级到下一个 provider（最终兜底 manual-schedule）。
 */
export interface TripStatusProvider {
  readonly key: string;
  readonly label: string;
  readonly supportedTypes: ReadonlyArray<"flight" | "train">;
  availability(): { ok: boolean; reason?: string };
  query(q: TripStatusQuery): Promise<TripStatusResult>;
}

/** 接站人消息发送结果。 */
export interface PickupSendResult {
  ok: boolean;
  channel?: string;
  summary: string;
  error?: string;
}

/** 宽松解析时间串（ISO / "YYYY-MM-DD HH:mm" / "HH:mm"）；失败返回 null。 */
export function parseLooseTime(raw: string | null | undefined, base = new Date()): Date | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  let ts = Date.parse(t.replace(" ", "T"));
  if (Number.isFinite(ts)) return new Date(ts);
  // 只有 HH:mm：按 base 当天解释
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) {
    const d = new Date(base);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d;
  }
  return null;
}
