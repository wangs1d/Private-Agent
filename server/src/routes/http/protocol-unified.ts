import type { FastifyInstance } from "fastify";

import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../../services/compute-quota-service.js";

export type UnifiedProtocolRouteDeps = {
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
};

export function registerUnifiedProtocolRoutes(app: FastifyInstance, deps: UnifiedProtocolRouteDeps): void {
  app.get("/protocol/unified/quota", async (request, reply) => {
    const q = request.query as { userId?: string; sessionId?: string };
    const actorId = String(q.userId ?? "").trim() || String(q.sessionId ?? "").trim();
    if (!actorId) {
      return reply.status(400).send({ ok: false, reason: "userId_or_sessionId_required" });
    }
    return { ok: true, ...deps.computeQuotaService.getState(actorId) };
  });

  app.get("/protocol/unified/memory", async (request, reply) => {
    const q = request.query as { userId?: string; sessionId?: string };
    const userId = String(q.userId ?? "").trim();
    const sessionId = String(q.sessionId ?? "").trim();
    const actorId = userId || sessionId;
    if (!actorId) {
      return reply.status(400).send({ ok: false, reason: "userId_or_sessionId_required" });
    }
    const keysRaw = (request.query as { keys?: string }).keys;
    const keys =
      typeof keysRaw === "string" && keysRaw.length > 0
        ? keysRaw
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
        : undefined;
    const snap = deps.agentMemorySyncService.getSnapshot(actorId, keys);
    return { ok: true, revision: snap.revision, entries: snap.entries };
  });
}
