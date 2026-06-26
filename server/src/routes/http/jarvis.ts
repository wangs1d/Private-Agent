/**
 * Jarvis Harness HTTP 路由
 *  - GET  /api/jarvis/recent           查最近的 trigger / decision 摘要
 *  - GET  /api/jarvis/memory/:actorId  查指定 actor 的记忆快照（episodic / reflection / rule）
 *  - POST /api/jarvis/feedback         客户端上行反馈
 */

import type { FastifyInstance } from "fastify";
import type { JarvisHarness } from "../../services/jarvis/index.js";
import type { JarvisFeedback } from "../../services/jarvis/index.js";

export type JarvisRouteDeps = {
  jarvisHarness: JarvisHarness;
};

export function registerJarvisRoutes(app: FastifyInstance, deps: JarvisRouteDeps): void {
  const { jarvisHarness } = deps;

  app.get("/api/jarvis/recent", async (req, reply) => {
    const query = req.query as { actorId?: string; limit?: string };
    if (!query.actorId) {
      return reply.code(400).send({ error: "actorId required" });
    }
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    return {
      triggers: jarvisHarness.recentTriggersFor(query.actorId, limit),
      decisions: jarvisHarness.recentDecisionsFor(query.actorId, limit),
    };
  });

  app.get("/api/jarvis/memory/:actorId", async (req, reply) => {
    const params = req.params as { actorId: string };
    if (!params.actorId) {
      return reply.code(400).send({ error: "actorId required" });
    }
    return jarvisHarness.memory.snapshot(params.actorId);
  });

  app.post("/api/jarvis/feedback", async (req, reply) => {
    const body = req.body as Partial<JarvisFeedback>;
    if (
      !body ||
      typeof body.actorId !== "string" ||
      typeof body.triggerId !== "string" ||
      typeof body.decisionId !== "string" ||
      typeof body.kind !== "string"
    ) {
      return reply.code(400).send({ error: "invalid feedback payload" });
    }
    const allowed: JarvisFeedback["kind"][] = [
      "delivered",
      "seen",
      "responded",
      "ignored",
      "negative",
      "positive",
      "post_mood",
    ];
    if (!allowed.includes(body.kind)) {
      return reply.code(400).send({ error: `invalid kind: ${body.kind}` });
    }
    await jarvisHarness.recordFeedback({
      kind: body.kind,
      actorId: body.actorId,
      triggerId: body.triggerId,
      decisionId: body.decisionId,
      responseTimeMs:
        typeof body.responseTimeMs === "number" ? body.responseTimeMs : undefined,
      sentimentAfter:
        typeof body.sentimentAfter === "number" ? body.sentimentAfter : undefined,
      metadata: body.metadata,
      occurredAt: new Date().toISOString(),
    });
    return { ok: true };
  });
}
