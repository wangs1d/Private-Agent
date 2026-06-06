import { resolveActorId } from "../agent/actor-id.js";
import type { MarketSignalService } from "../services/market-signal-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerMarketSignalTools(
  registry: ToolRegistry,
  marketSignalService: MarketSignalService,
): void {
  registry.register("market.signal.publish", async (input, context) => {
    const actorId = String(input.actorId ?? resolveActorId(context)).trim();
    const mode = String(input.mode ?? "anomaly").trim();
    const symbol = String(input.symbol ?? "").trim();
    if (!actorId || !symbol) {
      throw new Error("actorId and symbol are required");
    }

    if (mode === "position") {
      const signal = marketSignalService.publishPositionSnapshot({
        actorId,
        symbol,
        side: input.side === "short" ? "short" : "long",
        quantity: typeof input.quantity === "number" ? input.quantity : undefined,
        averageCost: typeof input.averageCost === "number" ? input.averageCost : undefined,
        currentPrice: typeof input.currentPrice === "number" ? input.currentPrice : undefined,
        unrealizedPnlPct:
          typeof input.unrealizedPnlPct === "number" ? input.unrealizedPnlPct : undefined,
        volatilityPct: typeof input.volatilityPct === "number" ? input.volatilityPct : undefined,
        thesis: input.thesis ? String(input.thesis) : undefined,
        tags: Array.isArray(input.tags) ? input.tags.map((item) => String(item)) : undefined,
        occurredAt: input.occurredAt ? String(input.occurredAt) : undefined,
      });
      return { ok: true, signalId: signal.id, kind: signal.kind };
    }

    const summary = String(input.summary ?? "").trim();
    const anomalyType = String(input.anomalyType ?? "price_move").trim();
    if (!summary) throw new Error("summary is required for anomaly mode");

    const signal = marketSignalService.publishAnomaly({
      actorId,
      symbol,
      anomalyType,
      summary,
      priceChangePct: typeof input.priceChangePct === "number" ? input.priceChangePct : undefined,
      volumeRatio: typeof input.volumeRatio === "number" ? input.volumeRatio : undefined,
      confidence: typeof input.confidence === "number" ? input.confidence : undefined,
      evidence: Array.isArray(input.evidence)
        ? input.evidence.map((item) => String(item))
        : undefined,
      tags: Array.isArray(input.tags) ? input.tags.map((item) => String(item)) : undefined,
      occurredAt: input.occurredAt ? String(input.occurredAt) : undefined,
    });
    return { ok: true, signalId: signal.id, kind: signal.kind };
  });
}
