import type { FastifyInstance } from "fastify";

import {
  getUserPreferences,
  markMorningBriefingDelivered,
  resetMorningBriefingDeliveryIfNeeded,
} from "./user-preferences.js";

export function registerBriefingDeliveryRoutes(app: FastifyInstance): void {
  app.get("/api/briefing-delivery", async (request, reply) => {
    const query = request.query as { sessionId?: string };
    const sessionId = query.sessionId?.trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const prefs = resetMorningBriefingDeliveryIfNeeded(sessionId);
    return {
      ok: true,
      deliveredAt: prefs.morningBriefing.deliveredAt,
      deliveredChannel: prefs.morningBriefing.deliveredChannel,
    };
  });

  app.post("/api/briefing-delivery", async (request, reply) => {
    const body = request.body as {
      sessionId?: string;
      channel?: "desktop" | "mobile" | "scheduled";
    };
    const sessionId = body.sessionId?.trim();
    const channel = body.channel;
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    if (!channel || !["desktop", "mobile", "scheduled"].includes(channel)) {
      return reply.code(400).send({ ok: false, error: "valid channel required" });
    }
    const prefs = markMorningBriefingDelivered(sessionId, channel);
    return {
      ok: true,
      deliveredAt: prefs.morningBriefing.deliveredAt,
      deliveredChannel: prefs.morningBriefing.deliveredChannel,
    };
  });
}
