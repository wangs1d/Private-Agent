import type { FastifyInstance } from "fastify";

import { messageBridgeInboundBodySchema } from "../../schemas/api.js";
import type { MessageBridgeService } from "../../services/message-bridge-service.js";

export function registerMessageBridgeRoutes(
  app: FastifyInstance,
  deps: { messageBridgeService: MessageBridgeService },
): void {
  app.post("/integrations/messages/inbound", async (request, reply) => {
    if (!deps.messageBridgeService.isEnabled()) {
      return reply.code(503).send({ ok: false, message: "message bridge disabled" });
    }
    try {
      deps.messageBridgeService.assertAuthorized(request);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(401).send({ ok: false, message });
    }
    const parsed = messageBridgeInboundBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = await deps.messageBridgeService.ingest(parsed.data);
    if (!result.ok) {
      return reply.code(422).send(result);
    }
    return result;
  });
}
