import type { FastifyInstance } from "fastify";

import { replyIfWorldHttpMutationsForbidden } from "../config/world-http-mutations.js";
import { replyIfWorldRegistrationRequired } from "../config/world-registration-gate.js";
import {
  worldZhajinhuaActBodySchema,
  worldZhajinhuaCreateBodySchema,
  worldZhajinhuaJoinBodySchema,
  worldZhajinhuaLeaveBodySchema,
  worldZhajinhuaListQuerySchema,
  worldZhajinhuaStartBodySchema,
  worldZhajinhuaTableQuerySchema,
} from "../schemas.js";
import type { HttpRouteDepsLike } from "../host-types.js";

/**
 * Agent World — 炸金花：3–6 名 Agent 以世界点数作底注，单轮弃牌/跟住后比牌。
 */
export function registerWorldZhajinhuaRoutes(app: FastifyInstance, deps: HttpRouteDepsLike): void {
  const { zhaJinHuaService, worldService } = deps;

  app.get("/world/zhajinhua/tables", async (request, reply) => {
    const parsed = worldZhajinhuaListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (parsed.data.sessionId) {
      if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
      worldService.visitZhaJinHua(parsed.data.sessionId);
    }
    return { ok: true, tables: zhaJinHuaService.listTables() };
  });

  app.post("/world/zhajinhua/tables", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldZhajinhuaCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, stake } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const r = zhaJinHuaService.createTable(sessionId, stake);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, table: r.table };
  });

  app.post("/world/zhajinhua/join", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldZhajinhuaJoinBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, tableId, role } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const r =
      role === "player"
        ? zhaJinHuaService.joinAsPlayer(tableId, sessionId)
        : zhaJinHuaService.joinSpectator(tableId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, table: r.table };
  });

  app.post("/world/zhajinhua/start", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldZhajinhuaStartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    const { tableId, sessionId, expectedRevision } = parsed.data;
    const r = zhaJinHuaService.startGame(tableId, sessionId, expectedRevision);
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
    return { ok: true, snapshot: r.snapshot };
  });

  app.post("/world/zhajinhua/act", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldZhajinhuaActBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, tableId, action } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const r = zhaJinHuaService.act(tableId, sessionId, action);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.post("/world/zhajinhua/leave", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldZhajinhuaLeaveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    const r = zhaJinHuaService.leave(parsed.data.tableId, parsed.data.sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true };
  });

  app.get<{ Params: { tableId: string } }>("/world/zhajinhua/table/:tableId", async (request, reply) => {
    const parsed = worldZhajinhuaTableQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    const r = zhaJinHuaService.getSnapshot(request.params.tableId, parsed.data.sessionId);
    if (!r.ok) {
      return reply.code(404).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });
}
