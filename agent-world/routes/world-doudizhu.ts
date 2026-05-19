import type { FastifyInstance } from "fastify";

import { replyIfWorldHttpMutationsForbidden } from "../config/world-http-mutations.js";
import { replyIfWorldRegistrationRequired } from "../config/world-registration-gate.js";
import {
  worldDoudizhuCreateBodySchema,
  worldDoudizhuJoinBodySchema,
  worldDoudizhuLeaveBodySchema,
  worldDoudizhuListQuerySchema,
  worldDoudizhuTableQuerySchema,
} from "../schemas.js";
import type { HttpRouteDepsLike } from "../host-types.js";

/**
 * Agent World — 斗地主：三 Agent 以世界点数下注，用户可旁观。
 */
export function registerWorldDoudizhuRoutes(app: FastifyInstance, deps: HttpRouteDepsLike): void {
  const { doudizhuService, worldService } = deps;

  app.get("/world/doudizhu/tables", async (request, reply) => {
    const parsed = worldDoudizhuListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (parsed.data.sessionId) {
      if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
      worldService.visitDoudizhu(parsed.data.sessionId);
    }
    return { ok: true, tables: doudizhuService.listTables() };
  });

  app.post("/world/doudizhu/tables", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldDoudizhuCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, stake } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const r = doudizhuService.createTable(sessionId, stake);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, table: r.table };
  });

  app.post("/world/doudizhu/join", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldDoudizhuJoinBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, tableId, role, expectedRevision } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const r =
      role === "player"
        ? doudizhuService.joinAsPlayer(tableId, sessionId, expectedRevision)
        : doudizhuService.joinSpectator(tableId, sessionId);
    if (!r.ok) {
      if (r.reason === "WORLD_REVISION_CONFLICT") {
        return reply.code(409).send({
          ok: false,
          reason: r.reason,
          message: "message" in r ? r.message : r.reason,
        });
      }
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, table: r.table };
  });

  app.post("/world/doudizhu/leave", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldDoudizhuLeaveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    const r = doudizhuService.leave(parsed.data.tableId, parsed.data.sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true };
  });

  app.get<{ Params: { tableId: string } }>("/world/doudizhu/table/:tableId", async (request, reply) => {
    const parsed = worldDoudizhuTableQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    const r = doudizhuService.getSnapshot(request.params.tableId, parsed.data.sessionId);
    if (!r.ok) {
      return reply.code(404).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });
}
