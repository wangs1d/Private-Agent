import type { FastifyInstance } from "fastify";

import { replyIfWorldHttpMutationsForbidden } from "../config/world-http-mutations.js";
import type { MusicRoomService } from "../services/music-room-service.js";

/**
 * Agent World — 一起听音乐：HTTP 路由占位。
 * 创建/加入/离开/播放控制等写操作需 `ALLOW_WORLD_HTTP_MUTATIONS=1`；常态下由 Agent 经工具在进程内执行。
 * WebSocket 推送（`world.music.snapshot`）与 `world.music.*` 客户端事件见 `standalone/ws-lite.ts`。
 */
export function registerWorldMusicRoutes(app: FastifyInstance, musicRoomService: MusicRoomService): void {
  /** 获取占位歌单（无需注册）。 */
  app.get("/world/music/playlist", async () => {
    return { ok: true, playlist: musicRoomService.getPlaylist() };
  });

  app.post("/world/music/create", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const r = musicRoomService.createRoom(sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, room: r.room };
  });

  app.post<{ Params: { roomId: string } }>("/world/music/:roomId/join", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const r = musicRoomService.joinRoom(request.params.roomId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.post<{ Params: { roomId: string } }>("/world/music/:roomId/leave", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const r = musicRoomService.leaveRoom(request.params.roomId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true };
  });

  app.post<{ Params: { roomId: string } }>("/world/music/:roomId/play", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown; trackId?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const trackId = typeof body.trackId === "string" ? body.trackId : undefined;
    const r = musicRoomService.play(request.params.roomId, sessionId, trackId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.post<{ Params: { roomId: string } }>("/world/music/:roomId/pause", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const r = musicRoomService.pause(request.params.roomId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.post<{ Params: { roomId: string } }>("/world/music/:roomId/next", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const r = musicRoomService.next(request.params.roomId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.post<{ Params: { roomId: string } }>("/world/music/:roomId/seek", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const body = (request.body ?? {}) as { sessionId?: unknown; positionSec?: unknown };
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const positionSec = typeof body.positionSec === "number" ? body.positionSec : Number(body.positionSec);
    if (!Number.isFinite(positionSec)) {
      return reply.code(400).send({ ok: false, reason: "positionSec 必须为数字" });
    }
    const r = musicRoomService.seek(request.params.roomId, sessionId, positionSec);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });

  app.get<{ Params: { roomId: string } }>("/world/music/:roomId/state", async (request, reply) => {
    const sessionId = String((request.query as { sessionId?: unknown })?.sessionId ?? "");
    if (!sessionId) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填" });
    }
    const r = musicRoomService.getSnapshot(request.params.roomId, sessionId);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, snapshot: r.snapshot };
  });
}
