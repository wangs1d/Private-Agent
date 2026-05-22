import type { FastifyInstance } from "fastify";

import { buildGomokuTableUrl } from "../config/world-game-url.js";
import type { HttpRouteDepsLike } from "../host-types.js";

/**
 * Agent World — 五子棋 API：用户与 Agent 双人对战（15x15，黑先白后）。
 * 用户 UI 在 `/play/gomoku/{tableId}`，不在 Agent World 观战 SPA。
 */
export function registerWorldGomokuRoutes(app: FastifyInstance, deps: HttpRouteDepsLike): void {
  const { gomokuService, worldService } = deps;

  app.get("/world/gomoku/tables", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const sessionId = String(query.sessionId ?? "");
    if (sessionId) {
      worldService.enterGomokuLobby(sessionId);
    }
    return { ok: true, tables: gomokuService.listTables() };
  });

  app.post("/world/gomoku/tables", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? "");
    const raw = String(body.userColor ?? body.humanColor ?? "random").trim().toLowerCase();
    const userColor =
      raw === "black" || raw === "white" || raw === "random"
        ? (raw as "black" | "white" | "random")
        : "random";
    const r = gomokuService.createTable(sessionId, { userColor });
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return {
      ok: true,
      table: r.table,
      playUrl: buildGomokuTableUrl(r.table.tableId),
    };
  });

  app.post("/world/gomoku/join", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? "");
    const tableId = String(body.tableId ?? "");
    const role = String(body.role ?? "player");
    if (!tableId) {
      return reply.code(400).send({ ok: false, reason: "缺少 tableId" });
    }
    const r =
      role === "player"
        ? gomokuService.joinAsPlayer(tableId, sessionId)
        : gomokuService.joinSpectator(tableId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return {
      ok: true,
      table: r.table,
      playUrl: buildGomokuTableUrl(tableId),
    };
  });

  app.post("/world/gomoku/play", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? "");
    const tableId = String(body.tableId ?? "");
    const row = Number(body.row ?? -1);
    const col = Number(body.col ?? -1);
    if (!tableId) {
      return reply.code(400).send({ ok: false, reason: "缺少 tableId" });
    }
    if (row < 0 || row >= 15 || col < 0 || col >= 15) {
      return reply.code(400).send({ ok: false, reason: "无效的落子位置" });
    }
    const r = gomokuService.play(tableId, sessionId, row, col);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.post("/world/gomoku/leave", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? "");
    const tableId = String(body.tableId ?? "");
    if (!tableId) {
      return reply.code(400).send({ ok: false, reason: "缺少 tableId" });
    }
    const r = gomokuService.leave(tableId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true };
  });

  app.get<{ Params: { tableId: string } }>('/world/gomoku/table/:tableId', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const sessionId = String(query.sessionId ?? "");
    const r = gomokuService.getSnapshot(request.params.tableId, sessionId);
    if (!r.ok) {
      return reply.code(404).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });
}
