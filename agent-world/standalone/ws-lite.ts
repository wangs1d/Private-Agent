import type { FastifyInstance } from "fastify";

import type { WsConnectionRegistry } from "../deps/services/ws-connection-registry.js";
import { AgentWorldClientEventType, AgentWorldServerEventType } from "../protocol-world.js";
import {
  worldDoudizhuWsTableSchema,
  worldGomokuWsTableSchema,
  worldPartitionAttachSchema,
  worldPartitionDetachSchema,
  worldSocialCommentPayloadSchema,
  worldSocialLikePayloadSchema,
  worldSocialPostDeletePayloadSchema,
  worldSocialPostPayloadSchema,
  worldSocialReportPayloadSchema,
  worldZhajinhuaWsTableSchema,
} from "../schemas.js";
import {
  canViewWorldPartition,
  WorldPartitionWsRegistry,
  type PartitionPairingLike,
} from "../services/world-partition-ws-registry.js";
import type { DoudizhuService } from "../services/doudizhu-service.js";
import type { GomokuService } from "../services/gomoku-service.js";
import type { SocialFeedService } from "../services/social-feed-service.js";
import type { WorldService } from "../services/world-service.js";
import type { ZhaJinHuaService } from "../services/zhajinhua-service.js";

/** 与主仓库 `server/src/protocol.ts` 对齐的最小子集，避免 standalone 依赖宿主。 */
const ClientSessionInit = "session.init";
const ServerErrorEvent = "error.event";

export type StandaloneWsDeps = {
  worldService: WorldService;
  doudizhuService: DoudizhuService;
  zhaJinHuaService: ZhaJinHuaService;
  gomokuService: GomokuService;
  socialFeedService: SocialFeedService;
  wsConnectionRegistry: WsConnectionRegistry;
  worldPartitionWsRegistry: WorldPartitionWsRegistry;
  /** standalone 无配对持久化时可传 `{ arePaired: () => false }`，仅允许订阅本人分区。 */
  partitionPairing: PartitionPairingLike;
};

/**
 * 仅处理：`session.init`（绑定会话 + WS 注册表）与斗地主/炸金花/互动动态的观战订阅事件。
 * 不含聊天、钱包、Agent 核心。
 */
export function registerStandaloneWorldWebSocket(app: FastifyInstance, deps: StandaloneWsDeps): void {
  const {
    worldService,
    doudizhuService,
    zhaJinHuaService,
    gomokuService,
    socialFeedService,
    wsConnectionRegistry,
    worldPartitionWsRegistry,
    partitionPairing,
  } = deps;

  const broadcastPartitionPresence = (partitionId: string): void => {
    const watcherSessionIds = worldPartitionWsRegistry.uniqueWatcherSessionIds(partitionId);
    worldPartitionWsRegistry.broadcastToPartition(
      partitionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldPresenceUpdate,
        payload: { partitionId, watcherSessionIds },
      }),
    );
  };

  app.get("/ws", { websocket: true }, (socket) => {
    let boundSessionId: string | undefined;

    socket.on("close", () => {
      const detached = worldPartitionWsRegistry.detachSocket(socket);
      if (detached) {
        broadcastPartitionPresence(detached.partitionId);
      }
      if (boundSessionId) {
        socialFeedService.unsubscribe(boundSessionId);
        wsConnectionRegistry.unregister(boundSessionId, socket);
        boundSessionId = undefined;
      }
    });

    socket.on("message", (raw: Buffer) => {
      let event: { type: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(raw.toString()) as { type: string; payload?: Record<string, unknown> };
      } catch {
        socket.send(
          JSON.stringify({
            type: ServerErrorEvent,
            payload: { code: "BAD_JSON", message: "无法解析事件 JSON" },
          }),
        );
        return;
      }

      if (event.type === ClientSessionInit) {
        const sessionId = String(event.payload?.sessionId ?? "");
        if (!sessionId) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_SESSION", message: "payload.sessionId 必填" },
            }),
          );
          return;
        }
        worldService.getOrCreate(sessionId);
        if (boundSessionId && boundSessionId !== sessionId) {
          wsConnectionRegistry.unregister(boundSessionId, socket);
        }
        boundSessionId = sessionId;
        wsConnectionRegistry.register(sessionId, socket);
        return;
      }

      if (!boundSessionId) {
        socket.send(
          JSON.stringify({
            type: ServerErrorEvent,
            payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
          }),
        );
        return;
      }

      const ensureWorldRegistered = (): boolean => {
        if (worldService.isAgentWorldRegistered(boundSessionId!)) return true;
        socket.send(
          JSON.stringify({
            type: ServerErrorEvent,
            payload: {
              code: "WORLD_REGISTRATION_REQUIRED",
              message: "请先完成 Agent World 注册",
            },
          }),
        );
        return false;
      };

      if (event.type === AgentWorldClientEventType.WorldPartitionAttach) {
        if (!ensureWorldRegistered()) return;
        const parsedPa = worldPartitionAttachSchema.safeParse(event.payload);
        if (!parsedPa.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "VALIDATION_ERROR", message: parsedPa.error.message },
            }),
          );
          return;
        }
        const { partitionId, traceId } = parsedPa.data;
        const state =
          partitionId === boundSessionId
            ? worldService.getOrCreate(partitionId)
            : worldService.getExisting(partitionId);
        if (!state) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: {
                code: "PARTITION_NOT_FOUND",
                message: "该房间不存在或尚无持久状态；共享房请先 world.room.create。",
                traceId,
              },
            }),
          );
          return;
        }
        if (!canViewWorldPartition(boundSessionId!, state.ownerSessionId, partitionPairing)) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: {
                code: "FORBIDDEN",
                message: "无权订阅该房间（standalone 默认仅本人房间）。",
                traceId,
              },
            }),
          );
          return;
        }
        worldPartitionWsRegistry.attach(partitionId, boundSessionId!, socket);
        socket.send(
          JSON.stringify({
            type: AgentWorldServerEventType.WorldPartitionSnapshot,
            payload: { partitionId, revision: state.revision, state, traceId },
          }),
        );
        broadcastPartitionPresence(partitionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldPartitionDetach) {
        const parsedPd = worldPartitionDetachSchema.safeParse(event.payload);
        if (!parsedPd.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "VALIDATION_ERROR", message: parsedPd.error.message },
            }),
          );
          return;
        }
        const currentPartition = worldPartitionWsRegistry.getPartitionForSocket(socket);
        const requested = parsedPd.data.partitionId;
        if (requested && currentPartition && requested !== currentPartition) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: {
                code: "VALIDATION_ERROR",
                message: "当前连接未订阅所请求的 partitionId",
                traceId: parsedPd.data.traceId,
              },
            }),
          );
          return;
        }
        const targetPid = requested ?? currentPartition;
        if (!targetPid || !currentPartition) {
          return;
        }
        worldPartitionWsRegistry.detachSocket(socket);
        broadcastPartitionPresence(targetPid);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldDoudizhuSubscribe) {
        if (!ensureWorldRegistered()) return;
        const parsed = worldDoudizhuWsTableSchema.safeParse(event.payload);
        if (!parsed.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_DOUZHU_EVENT", message: parsed.error.message },
            }),
          );
          return;
        }
        const r = doudizhuService.watchTable(parsed.data.tableId, boundSessionId);
        if (!r.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "DOUZHU_SUBSCRIBE_FAILED", message: r.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldDoudizhuSubscribeLobby) {
        if (!ensureWorldRegistered()) return;
        doudizhuService.watchLobby(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldDoudizhuUnsubscribeLobby) {
        if (!ensureWorldRegistered()) return;
        doudizhuService.unwatchLobby(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldDoudizhuUnsubscribe) {
        if (!ensureWorldRegistered()) return;
        const parsed = worldDoudizhuWsTableSchema.safeParse(event.payload);
        if (!parsed.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_DOUZHU_EVENT", message: parsed.error.message },
            }),
          );
          return;
        }
        doudizhuService.unwatchTable(parsed.data.tableId, boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldZhajinhuaSubscribe) {
        if (!ensureWorldRegistered()) return;
        const zjh = worldZhajinhuaWsTableSchema.safeParse(event.payload);
        if (!zjh.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_ZHAJINHUA_EVENT", message: zjh.error.message },
            }),
          );
          return;
        }
        const r = zhaJinHuaService.watchTable(zjh.data.tableId, boundSessionId);
        if (!r.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "ZHAJINHUA_SUBSCRIBE_FAILED", message: r.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldZhajinhuaSubscribeLobby) {
        if (!ensureWorldRegistered()) return;
        zhaJinHuaService.watchLobby(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldZhajinhuaUnsubscribeLobby) {
        if (!ensureWorldRegistered()) return;
        zhaJinHuaService.unwatchLobby(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldZhajinhuaUnsubscribe) {
        if (!ensureWorldRegistered()) return;
        const zjhU = worldZhajinhuaWsTableSchema.safeParse(event.payload);
        if (!zjhU.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_ZHAJINHUA_EVENT", message: zjhU.error.message },
            }),
          );
          return;
        }
        zhaJinHuaService.unwatchTable(zjhU.data.tableId, boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldGomokuSubscribe) {
        const parsed = worldGomokuWsTableSchema.safeParse(event.payload);
        if (!parsed.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_GOMOKU_EVENT", message: parsed.error.message },
            }),
          );
          return;
        }
        const r = gomokuService.watchTable(parsed.data.tableId, boundSessionId);
        if (!r.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "GOMOKU_SUBSCRIBE_FAILED", message: r.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldGomokuSubscribeLobby) {
        gomokuService.watchLobby(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldGomokuUnsubscribeLobby) {
        gomokuService.unwatchLobby(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldGomokuUnsubscribe) {
        const parsed = worldGomokuWsTableSchema.safeParse(event.payload);
        if (!parsed.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_GOMOKU_EVENT", message: parsed.error.message },
            }),
          );
          return;
        }
        gomokuService.unwatchTable(parsed.data.tableId, boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialSubscribe) {
        if (!ensureWorldRegistered()) return;
        socialFeedService.subscribe(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialUnsubscribe) {
        if (!ensureWorldRegistered()) return;
        socialFeedService.unsubscribe(boundSessionId);
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialPost) {
        if (!ensureWorldRegistered()) return;
        const socPost = worldSocialPostPayloadSchema.safeParse(event.payload);
        if (!socPost.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_SOCIAL_EVENT", message: socPost.error.message },
            }),
          );
          return;
        }
        const text = socPost.data.text ?? "";
        const mediaType = socPost.data.mediaType ?? "none";
        const mediaUrl = socPost.data.mediaUrl === undefined ? null : socPost.data.mediaUrl;
        const rSoc = socialFeedService.createPost(boundSessionId, text, mediaType, mediaUrl);
        if (!rSoc.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "SOCIAL_POST_FAILED", message: rSoc.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialComment) {
        if (!ensureWorldRegistered()) return;
        const socC = worldSocialCommentPayloadSchema.safeParse(event.payload);
        if (!socC.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_SOCIAL_EVENT", message: socC.error.message },
            }),
          );
          return;
        }
        const rC = socialFeedService.addComment(boundSessionId, socC.data.postId, socC.data.text);
        if (!rC.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "SOCIAL_COMMENT_FAILED", message: rC.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialLikeToggle) {
        if (!ensureWorldRegistered()) return;
        const socL = worldSocialLikePayloadSchema.safeParse(event.payload);
        if (!socL.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_SOCIAL_EVENT", message: socL.error.message },
            }),
          );
          return;
        }
        const rL = socialFeedService.toggleLike(boundSessionId, socL.data.postId);
        if (!rL.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "SOCIAL_LIKE_FAILED", message: rL.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialPostDelete) {
        if (!ensureWorldRegistered()) return;
        const socDel = worldSocialPostDeletePayloadSchema.safeParse(event.payload);
        if (!socDel.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_SOCIAL_EVENT", message: socDel.error.message },
            }),
          );
          return;
        }
        const rDel = socialFeedService.deletePost(boundSessionId, socDel.data.postId);
        if (!rDel.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "SOCIAL_DELETE_FAILED", message: rDel.reason },
            }),
          );
        }
        return;
      }

      if (event.type === AgentWorldClientEventType.WorldSocialReport) {
        if (!ensureWorldRegistered()) return;
        const socRep = worldSocialReportPayloadSchema.safeParse(event.payload);
        if (!socRep.success) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "INVALID_SOCIAL_EVENT", message: socRep.error.message },
            }),
          );
          return;
        }
        const rRep = socialFeedService.reportPost(boundSessionId, socRep.data.postId, socRep.data.reason);
        if (!rRep.ok) {
          socket.send(
            JSON.stringify({
              type: ServerErrorEvent,
              payload: { code: "SOCIAL_REPORT_FAILED", message: rRep.reason },
            }),
          );
        }
        return;
      }

      socket.send(
        JSON.stringify({
          type: ServerErrorEvent,
          payload: {
            code: "UNSUPPORTED_IN_STANDALONE",
            message:
              "本进程仅支持 session.init、world.partition.*、world.doudizhu.*、world.zhajinhua.*、world.social.*；聊天/钱包等请使用完整宿主。",
          },
        }),
      );
    });
  });
}
