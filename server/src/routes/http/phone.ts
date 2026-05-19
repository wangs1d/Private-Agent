import type { FastifyInstance } from "fastify";
import { resolveActorId } from "../../agent/actor-id.js";
import { phoneMeQuerySchema } from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

export function registerPhoneRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { virtualPhoneService } = deps;

  app.get("/phone", async () => ({
    domain: "phone",
    mePath: "/phone/me",
    wsEventIncoming: "agent.phone.incoming",
    digits: 6,
  }));

  app.get("/phone/me", async (request, reply) => {
    const parsed = phoneMeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, userId } = parsed.data;
    const actorId = resolveActorId({ sessionId, userId });
    const virtualPhone = virtualPhoneService.getPhoneForActor(actorId) ?? null;
    return {
      ok: true,
      actorId,
      claimed: virtualPhone != null,
      virtualPhone,
      ttsConfigured: deps.ttsService.isEnabled(),
    };
  });
}
