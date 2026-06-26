import type { FastifyInstance } from "fastify";
import type { MoodInferenceService } from "../../services/mood-inference-service.js";

export type MoodInferenceRouteDeps = {
  moodInferenceService: MoodInferenceService;
};

export function registerMoodInferenceRoutes(
  app: FastifyInstance,
  deps: MoodInferenceRouteDeps,
): void {
  app.get("/api/mood-inferences", async (request, reply) => {
    const query = request.query as { sessionId?: string; limit?: string };
    const sessionId = String(query.sessionId ?? "").trim();
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });
    const limit = Math.max(1, Math.min(200, Number(query.limit ?? "30") || 30));
    return reply.send({
      ok: true,
      inferences: deps.moodInferenceService.listForSession(sessionId, limit),
    });
  });

  app.get("/api/mood-inferences/daily", async (request, reply) => {
    const query = request.query as { sessionId?: string; days?: string };
    const sessionId = String(query.sessionId ?? "").trim();
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });
    const days = Math.max(1, Math.min(30, Number(query.days ?? "7") || 7));
    return reply.send({
      ok: true,
      aggregates: deps.moodInferenceService.dailyAggregates(sessionId, days),
    });
  });

  app.get("/api/mood-inferences/today", async (request, reply) => {
    const sessionId = String((request.query as { sessionId?: string }).sessionId ?? "").trim();
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId required" });
    return reply.send({
      ok: true,
      mood: deps.moodInferenceService.todayMood(sessionId),
    });
  });
}
