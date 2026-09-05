/**
 * 模拟网约车 Provider（BOOKING_MODE=mock 默认注册）。
 *
 * 用途：安全地打通 quote → book（两阶段确认）→ status → cancel 全链路，
 * 以及测试/演示。所有结果带 simulated=true 与「模拟」字样，必须如实转告
 * 用户——不会产生真实订单与扣费。
 *
 * 报价策略：pickup/dropoff 字符串确定性伪距离（3-30km）× 分档费率，
 * 明确标注为模拟估价。
 */

import { randomBytes } from "node:crypto";

import type {
  BookingDraft,
  BookingOption,
  BookingProvider,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingProviderBookPayload,
  BookingProviderStatusPayload,
  BookingSearchQuery,
} from "../booking-provider.js";

/** 字符串 → [3, 30) 的确定性伪距离（km）。 */
function pseudoDistanceKm(a: string, b: string): number {
  let hash = 5381;
  const s = `${a}|${b}`;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  const unit = Math.abs(hash) % 2700; // 0..2699
  return 3 + unit / 100;
}

function roundCny(v: number): number {
  return Math.round(v);
}

interface SimulatedRideOrder {
  providerOrderId: string;
  createdAt: number;
  cancelled: boolean;
}

export class SimulatedRideProvider implements BookingProvider {
  readonly key = "simulated";
  readonly domain = "ride" as const;
  readonly label = "模拟网约车（沙盒）";

  private readonly orders = new Map<string, SimulatedRideOrder>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  availability(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  private readTrip(query: BookingSearchQuery): { pickup: string; dropoff: string } | null {
    const pickup = typeof query.params.pickup === "string" ? query.params.pickup.trim() : "";
    const dropoff = typeof query.params.dropoff === "string" ? query.params.dropoff.trim() : "";
    if (!dropoff) return null;
    return { pickup: pickup || "当前位置", dropoff };
  }

  async search(
    query: BookingSearchQuery,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const trip = this.readTrip(query);
    if (!trip) {
      return { ok: false, error: "缺少 dropoff（目的地）", retryable: true };
    }
    const km = pseudoDistanceKm(trip.pickup, trip.dropoff);
    const etaBase = 3 + (Math.round(km) % 6);
    const tiers: Array<{ id: string; title: string; base: number; perKm: number }> = [
      { id: "eco", title: "经济型", base: 12, perKm: 1.9 },
      { id: "comfort", title: "舒适型", base: 15, perKm: 2.5 },
      { id: "business", title: "商务型", base: 22, perKm: 3.4 },
    ];
    const options: BookingOption[] = tiers.map((t) => ({
      id: t.id,
      provider: this.key,
      title: `${t.title}（模拟估价 ¥${roundCny(t.base + t.perKm * km)}）`,
      description: `${t.title} · ${km.toFixed(1)}km · 约 ${Math.max(8, Math.round(km * 2.5))} 分钟`,
      amountCny: roundCny(t.base + t.perKm * km),
      currency: "CNY",
      etaMinutes: etaBase,
      durationMinutes: Math.max(8, Math.round(km * 2.5)),
      simulated: true,
      extra: { carType: t.id, distanceKm: Number(km.toFixed(1)), simulatedNote: "模拟报价，非真实平台价格" },
    }));
    return {
      ok: true,
      options,
      note: "模拟模式（BOOKING_MODE=mock）：报价为确定性模拟数据，不会真实下单或扣费",
    };
  }

  async book(
    draft: BookingDraft,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    const providerOrderId = `SIM-RIDE-${randomBytes(4).toString("hex").toUpperCase()}`;
    this.orders.set(providerOrderId, {
      providerOrderId,
      createdAt: this.now(),
      cancelled: false,
    });
    return {
      ok: true,
      providerOrderId,
      status: "confirmed",
      message: "模拟下单成功（沙盒）",
      tracking: {
        simulated: true,
        driver: "张师傅（模拟）",
        plate: "京A·88888（模拟）",
        etaMinutes: 4,
      },
    };
  }

  async getStatus(
    ref: BookingProviderRef,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    const order = this.orders.get(ref.providerOrderId);
    if (!order) return { ok: false, error: "模拟订单不存在" };
    if (order.cancelled) return { ok: true, status: "cancelled", message: "已取消（模拟）" };
    // 模拟生命周期：0-60s 已接单 → 60s-10min 行程中 → 之后已完成
    const elapsedMs = this.now() - order.createdAt;
    if (elapsedMs < 60_000) {
      return {
        ok: true,
        status: "confirmed",
        message: "司机已接单（模拟）",
        tracking: { driver: "张师傅（模拟）", plate: "京A·88888（模拟）", etaMinutes: 4 },
      };
    }
    if (elapsedMs < 600_000) {
      return {
        ok: true,
        status: "in_progress",
        message: "行程进行中（模拟）",
        tracking: { driver: "张师傅（模拟）", plate: "京A·88888（模拟）", remainingMinutes: 6 },
      };
    }
    return { ok: true, status: "completed", message: "行程已完成（模拟）" };
  }

  async cancel(
    ref: BookingProviderRef,
    _reason: string | undefined,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    const order = this.orders.get(ref.providerOrderId);
    if (!order) return { ok: false, error: "模拟订单不存在" };
    if (order.cancelled) return { ok: false, error: "订单已是取消状态" };
    order.cancelled = true;
    return { ok: true, message: "已取消（模拟），无费用" };
  }
}
