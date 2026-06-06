import type { FastifyInstance } from "fastify";

import type { HttpRouteDeps } from "./types.js";

export function registerMarketSignalRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  app.post("/life/market/positions", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actorId = String(body.actorId ?? body.sessionId ?? "").trim();
      const symbol = String(body.symbol ?? "").trim();
      if (!actorId || !symbol) {
        return reply.code(400).send({ ok: false, error: "actorId and symbol are required" });
      }

      const signal = deps.marketSignalService?.publishPositionSnapshot({
        actorId,
        symbol,
        side: body.side === "short" ? "short" : "long",
        quantity: typeof body.quantity === "number" ? body.quantity : undefined,
        averageCost: typeof body.averageCost === "number" ? body.averageCost : undefined,
        currentPrice: typeof body.currentPrice === "number" ? body.currentPrice : undefined,
        unrealizedPnlPct:
          typeof body.unrealizedPnlPct === "number" ? body.unrealizedPnlPct : undefined,
        volatilityPct: typeof body.volatilityPct === "number" ? body.volatilityPct : undefined,
        thesis: body.thesis ? String(body.thesis) : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map((item) => String(item)) : undefined,
        occurredAt: body.occurredAt ? String(body.occurredAt) : undefined,
      });
      return reply.send({ ok: true, signalId: signal?.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  app.post("/life/market/anomalies", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actorId = String(body.actorId ?? body.sessionId ?? "").trim();
      const symbol = String(body.symbol ?? "").trim();
      const anomalyType = String(body.anomalyType ?? "").trim();
      const summary = String(body.summary ?? "").trim();
      if (!actorId || !symbol || !anomalyType || !summary) {
        return reply
          .code(400)
          .send({ ok: false, error: "actorId, symbol, anomalyType, and summary are required" });
      }

      const signal = deps.marketSignalService?.publishAnomaly({
        actorId,
        symbol,
        anomalyType,
        summary,
        priceChangePct: typeof body.priceChangePct === "number" ? body.priceChangePct : undefined,
        volumeRatio: typeof body.volumeRatio === "number" ? body.volumeRatio : undefined,
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        evidence: Array.isArray(body.evidence)
          ? body.evidence.map((item) => String(item))
          : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map((item) => String(item)) : undefined,
        occurredAt: body.occurredAt ? String(body.occurredAt) : undefined,
      });
      return reply.send({ ok: true, signalId: signal?.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ ok: false, error: message });
    }
  });
}
