/**
 * 本地报价源：包装 PricingService（本地价格库 + POI 覆盖）。
 *
 * 这是「保底源」——永远可用、永远返回一条，保证比价列表非空。
 * flight/train 无价格库条目时按调用方 basePriceCny 兜底估算；
 * 两者都没有则返回空（由聚合器如实说明）。
 */

import { pricingService, type PricingContext } from "../../../skills/travel-planning/pricing-service.js";
import type { QuoteRequest, QuoteSource, QuoteSourceResult, TravelQuote } from "./quote-source.js";

function nightsBetween(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn.replace(" ", "T"));
  const b = Date.parse(checkOut.replace(" ", "T"));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

export class LocalQuoteSource implements QuoteSource {
  readonly id = "local";
  readonly label = "本地价格库";

  supports(): boolean {
    return true;
  }

  async fetch(req: QuoteRequest): Promise<QuoteSourceResult> {
    const now = Date.now();
    if (req.type === "hotel") {
      const city = req.city || req.to || "";
      const hotelName = req.hotelName || `${city || "目的地"}酒店`;
      if (!city && !req.hotelName) {
        return { ok: false, error: "缺少 city 或 hotelName（酒店查询目的地）" };
      }
      const ctx: PricingContext = {
        destination: city || hotelName,
        preferences: { hotelTier: req.tier ?? "mid" },
        startDate: req.checkInDate || undefined,
      };
      const quote = pricingService.quoteHotel(hotelName, ["酒店"], ctx);
      const nights = nightsBetween(req.checkInDate, req.checkOutDate);
      const item: TravelQuote = {
        source: this.id,
        sourceLabel: this.label,
        type: "hotel",
        name: hotelName,
        from: undefined,
        to: city || undefined,
        seat: req.tier === "budget" ? "经济型" : req.tier === "luxury" ? "高档" : "舒适型",
        checkInDate: req.checkInDate || undefined,
        amountCny: quote.finalPrice,
        nights,
        currency: "CNY",
        priceSource: quote.priceSource === "estimated" ? "estimated" : quote.priceSource === "list" ? "list" : "database",
        note: quote.note ?? "价格来自本地价格库，最终以平台实价为准",
        fetchedAt: now,
      };
      return { ok: true, quotes: [item] };
    }

    // flight / train：无实时报价库，按基准价估算（缺基准价则空，交由其他源/聚合器说明）
    if (req.basePriceCny == null || !Number.isFinite(req.basePriceCny) || req.basePriceCny <= 0) {
      return { ok: true, quotes: [], note: "本地价格库无机票/火车票实时报价" };
    }
    const label = req.type === "flight" ? "航班" : "车次";
    const item: TravelQuote = {
      source: this.id,
      sourceLabel: this.label,
      type: req.type,
      code: req.code,
      name: req.code ? `${label} ${req.code}` : label,
      from: req.from,
      to: req.to,
      departTime: req.departTime,
      seat: req.seat ?? (req.type === "flight" ? "经济舱" : "二等座"),
      amountCny: Math.round(req.basePriceCny),
      currency: "CNY",
      priceSource: "estimated",
      note: "按你提供的基准价估算（未接实时报价），支付前会再确认金额",
      fetchedAt: now,
    };
    return { ok: true, quotes: [item] };
  }
}
