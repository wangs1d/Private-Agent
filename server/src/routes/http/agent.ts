import type { FastifyInstance } from "fastify";

import {
  agentAipStateQuerySchema,
  agentInboxQuerySchema,
  agentPairBodySchema,
  agentPairStatusQuerySchema,
  agentUnpairBodySchema,
} from "../../schemas/api.js";
import { relayRequiresPairEnv } from "../../services/agent-pairing-service.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * Agent 协作子域：中继收件箱、配对、中继策略配置。
 */
export function registerAgentCollaborationRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { agentRelayService, agentPairingService, aipService } = deps;

  /** AIP：结盟、开放冲突、提议等；状态持久化至 `data/aip-state.json`（`AIP_STATE_FILE` 可覆盖），投递写入审计日志。 */
  app.get("/agent/aip/state", async (request, reply) => {
    const parsed = agentAipStateQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId } = parsed.data;
    return {
      ok: true,
      sessionId,
      aipVersion: "0.1",
      alliances: aipService.listAlliancesForSession(sessionId),
      openConflicts: aipService.listOpenConflictsForSession(sessionId),
    };
  });

  app.get("/agent/inbox", async (request, reply) => {
    const parsed = agentInboxQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, limit } = parsed.data;
    const messages = agentRelayService.listInbox(sessionId, limit ?? 50);
    return { ok: true, sessionId, messages };
  });

  app.get("/agent/relay/config", async () => ({
    ok: true,
    requirePair: relayRequiresPairEnv(),
  }));

  app.post("/agent/pair", async (request, reply) => {
    const parsed = agentPairBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, code } = parsed.data;
    try {
      const normalized = agentPairingService.join(sessionId, code);
      await agentPairingService.persist();
      return { ok: true, sessionId, code: normalized };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.post("/agent/unpair", async (request, reply) => {
    const parsed = agentUnpairBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    agentPairingService.leave(parsed.data.sessionId);
    await agentPairingService.persist();
    return { ok: true, sessionId: parsed.data.sessionId };
  });

  app.get("/agent/pair/status", async (request, reply) => {
    const parsed = agentPairStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId } = parsed.data;
    const code = agentPairingService.getCode(sessionId);
    return { ok: true, sessionId, joined: code !== undefined, code: code ?? null };
  });
}
