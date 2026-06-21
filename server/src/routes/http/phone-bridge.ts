import type { FastifyInstance } from "fastify";

import type { PhoneBridgeCoordinator } from "../../services/phone-bridge-coordinator.js";

export type PhoneBridgeHttpDeps = {
  phoneBridgeCoordinator: PhoneBridgeCoordinator;
};

export function registerPhoneBridgeRoutes(app: FastifyInstance, deps: PhoneBridgeHttpDeps): void {
  app.get<{ Querystring: { actorId?: string } }>("/phone-bridge", async (request) => {
    const actorId = (request.query.actorId ?? "").trim();
    const payload = deps.phoneBridgeCoordinator.getSyncPayload(actorId);
    return { ok: true, ...payload };
  });

  app.get<{ Querystring: { actorId?: string } }>("/phone-bridge/status", async (request) => {
    const actorId = (request.query.actorId ?? "").trim();
    const online = deps.phoneBridgeCoordinator.hasExecutor(actorId);
    return { ok: true, phoneBridgeOnline: online };
  });
}
