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
    wsEventCallStatus: "agent.phone.call_status",
    digits: 6,
    features: ["agent_to_agent", "agent_to_user", "user_to_agent"],
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

  app.post("/phone/call-agent", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? "").trim();
    const userId = String(body.userId ?? "").trim();
    const toActorId = String(body.toActorId ?? "").trim();
    const userMessage = String(body.userMessage ?? body.message ?? "").trim();

    const fromUserId = userId || sessionId;
    if (!fromUserId) {
      return reply.code(400).send({ ok: false, error: "需要 sessionId 或 userId" });
    }
    if (!toActorId) {
      return reply.code(400).send({ ok: false, error: "缺少 toActorId（目标Agent ID）" });
    }

    const result = await virtualPhoneService.handleUserCallAgent({
      fromUserId,
      toActorId,
      userMessage: userMessage || undefined,
    });

    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error });
    }

    return {
      ok: true,
      callId: result.callId,
      status: "ringing",
      message: "已发起呼叫，请等待 Agent 接听",
    };
  });
}
