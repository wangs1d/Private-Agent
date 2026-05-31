import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { GameCenterCoordinator } from "../services/game-center-coordinator.js";
import { humanSessionId } from "../services/game-center-session.js";

const startBodySchema = z.object({
  agentSessionId: z.string().min(1),
  stake: z.number().int().min(1).max(2000).optional(),
  userColor: z.enum(["black", "white", "random"]).optional(),
});

const tableSessionSchema = z.object({
  sessionId: z.string().min(1),
});

const zjhActSchema = z.object({
  sessionId: z.string().min(1),
  action: z.enum(["fold", "stay"]),
});

const ddzPlaySchema = z.object({
  sessionId: z.string().min(1),
  action: z.enum(["pass", "play"]),
  cards: z.array(z.string()).optional(),
});

export type GameCenterRouteDeps = {
  gameCenter: GameCenterCoordinator;
};

/**
 * 游戏 HTTP：用户与 Agent 对战（不要求 Agent World 注册）。
 * 路径前缀 `/game-center/*`，与 `/world/*` 观战/经济场景分离。
 */
export function registerGameCenterRoutes(app: FastifyInstance, deps: GameCenterRouteDeps): void {
  const { gameCenter } = deps;

  app.post("/game-center/gomoku/start", async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const r = gameCenter.startGomoku(parsed.data.agentSessionId, {
      userColor: parsed.data.userColor,
    });
    if (!r.ok) return reply.code(400).send(r);
    return { ok: true, tableId: r.tableId, playUrl: r.playUrl };
  });

  app.post("/game-center/zhajinhua/start", async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const r = gameCenter.startZhajinhua(parsed.data.agentSessionId, parsed.data.stake);
    if (!r.ok) return reply.code(400).send(r);
    return {
      ok: true,
      tableId: r.tableId,
      snapshot: r.snapshot,
      humanSessionId: humanSessionId(parsed.data.agentSessionId),
    };
  });

  app.post<{ Params: { tableId: string } }>(
    "/game-center/zhajinhua/table/:tableId/act",
    async (request, reply) => {
      const parsed = zjhActSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const r = gameCenter.zhajinhuaAct(request.params.tableId, parsed.data.sessionId, parsed.data.action);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );

  app.get<{ Params: { tableId: string } }>(
    "/game-center/zhajinhua/table/:tableId",
    async (request, reply) => {
      const q = tableSessionSchema.safeParse(request.query);
      if (!q.success) {
        return reply.code(400).send({ ok: false, error: q.error.flatten() });
      }
      const r = gameCenter.zhajinhuaSnapshot(request.params.tableId, q.data.sessionId);
      if (!r.ok) return reply.code(404).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );

  app.post("/game-center/doudizhu/start", async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const r = gameCenter.startDoudizhu(parsed.data.agentSessionId, parsed.data.stake);
    if (!r.ok) return reply.code(400).send(r);
    return {
      ok: true,
      tableId: r.tableId,
      snapshot: r.snapshot,
      humanSessionId: humanSessionId(parsed.data.agentSessionId),
    };
  });

  app.post<{ Params: { tableId: string } }>(
    "/game-center/doudizhu/table/:tableId/play",
    async (request, reply) => {
      const parsed = ddzPlaySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const r = gameCenter.doudizhuPlay(
        request.params.tableId,
        parsed.data.sessionId,
        parsed.data.action,
        parsed.data.cards,
      );
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );

  app.get<{ Params: { tableId: string } }>(
    "/game-center/doudizhu/table/:tableId",
    async (request, reply) => {
      const q = tableSessionSchema.safeParse(request.query);
      if (!q.success) {
        return reply.code(400).send({ ok: false, error: q.error.flatten() });
      }
      const r = gameCenter.doudizhuSnapshot(request.params.tableId, q.data.sessionId);
      if (!r.ok) return reply.code(404).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );

  app.post("/game-center/blackjack/start", async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const r = gameCenter.startBlackjack(parsed.data.agentSessionId, parsed.data.stake);
    if (!r.ok) return reply.code(400).send(r);
    return {
      ok: true,
      tableId: r.tableId,
      snapshot: r.snapshot,
      humanSessionId: humanSessionId(parsed.data.agentSessionId),
    };
  });

  app.post<{ Params: { tableId: string } }>(
    "/game-center/blackjack/table/:tableId/hit",
    async (request, reply) => {
      const parsed = tableSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const r = gameCenter.blackjackHit(request.params.tableId, parsed.data.sessionId);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );

  app.post<{ Params: { tableId: string } }>(
    "/game-center/blackjack/table/:tableId/stand",
    async (request, reply) => {
      const parsed = tableSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const r = gameCenter.blackjackStand(request.params.tableId, parsed.data.sessionId);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );

  app.get<{ Params: { tableId: string } }>(
    "/game-center/blackjack/table/:tableId",
    async (request, reply) => {
      const q = tableSessionSchema.safeParse(request.query);
      if (!q.success) {
        return reply.code(400).send({ ok: false, error: q.error.flatten() });
      }
      const r = gameCenter.blackjackSnapshot(request.params.tableId, q.data.sessionId);
      if (!r.ok) return reply.code(404).send(r);
      return { ok: true, snapshot: r.snapshot };
    },
  );
}
