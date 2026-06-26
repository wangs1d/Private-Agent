import type { FastifyInstance } from "fastify";

import {
  MorningBriefingService,
  type MorningBriefingDeps,
} from "../../services/morning-briefing-service.js";

export function registerMorningBriefingRoutes(
  app: FastifyInstance,
  deps?: MorningBriefingDeps,
): void {
  app.get("/api/morning-briefing", async (request, reply) => {
    const query = request.query as { sessionId?: string; format?: string };
    const { sessionId, format } = query;
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const service = new MorningBriefingService(deps);
    if (format === "narration") {
      const narration = await service.narrateBriefing(sessionId);
      return { ok: true, ...narration };
    }
    const briefing = await service.generateBriefing(sessionId);
    return { ok: true, briefing };
  });
}
