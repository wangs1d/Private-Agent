import type { FastifyInstance } from "fastify";

import type { AipService } from "../aip/aip-service.js";
import {
  ClientEventType,
  ServerEventType,
  type EventEnvelope,
  type WalletAction,
} from "../protocol.js";
import type { AgentCore } from "../services/agent-core.js";
import type { AuditService } from "../services/audit-service.js";
import type { SessionService } from "../services/session-service.js";
import type { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import type { AgentPairingService } from "../services/agent-pairing-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import { createExternalChatProviderFromEnv } from "../external-model/resolve-provider.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type {
  IncomingPhoneUserAction,
  VirtualPhoneIncomingCoordinator,
} from "../services/virtual-phone-incoming-coordinator.js";
import {
  handleAgentEmbodimentInteractEvent,
} from "./handlers/agent-embodiment-interact.js";
import {
  handleChatAgentProcessingUiEvent,
  handleChatUserMessageEvent,
  messageBatchProcessor,
} from "./handlers/chat-user-message.js";
import { handleAgentEmbodimentStateEvent } from "./handlers/agent-embodiment-state.js";
import { getEmbodimentAutonomy } from "../services/embodiment-autonomy-service.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import {
  AgentWorldClientEventType,
  AgentWorldServerEventType,
  UNIFIED_LAYER_MANIFEST,
  UNIFIED_PROTOCOL_VERSION,
  UnifiedClientEventType,
  UnifiedServerEventType,
  allowWorldHttpMutations,
  canViewWorldPartition,
  resolveUnifiedMemoryActorId,
  type GomokuService,
  type SocialFeedService,
  type WorldPartitionWsRegistry,
  type WorldService,
  worldGomokuWsTableSchema,
  worldPartitionAttachSchema,
  worldPartitionDetachSchema,
  worldSocialCommentPayloadSchema,
  worldSocialLikePayloadSchema,
  worldSocialPostDeletePayloadSchema,
  worldSocialPostPayloadSchema,
  worldSocialReportPayloadSchema,
  unifiedCapabilitiesClientSchema,
  unifiedGovernanceProbeSchema,
  unifiedHumanDirectiveSchema,
  unifiedMemoryGetSchema,
  unifiedMemoryPatchSchema,
  unifiedQuotaAdjustSchema,
} from "@private-ai-agent/agent-world";
import { UnifiedErrorCode } from "../protocol-unified-errors.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import { aipDispatchWsSchema, walletRequestSchema } from "../schemas/api.js";

type SocketWithHeartbeat = {
  send(data: string): void;
  close(code?: number, data?: string): void;
  ping?(data?: Buffer, mask?: boolean, cb?: (err?: Error) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;
  readyState?: number;
  isAlive?: boolean;
};

const WS_READY_STATE_OPEN = 1;
const WS_HEARTBEAT_INTERVAL_MS = 25_000;
const WS_HEARTBEAT_GRACE_MS = 10_000;

function safeSocketSend(socket: SocketWithHeartbeat, data: string): boolean {
  const open = socket.readyState === undefined || socket.readyState === WS_READY_STATE_OPEN;
  if (!open) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    try {
      socket.close(1011, "send_failed");
    } catch {
      // Ignore close failures on broken sockets.
    }
    return false;
  }
}

/**
 * 从Fastify请求中获取客户端IP地址
 */
function getClientIp(request: any): string | undefined {
  // 首先检查x-forwarded-for头（代理服务器设置）
  const forwardedFor = request.headers?.["x-forwarded-for"];
  if (forwardedFor) {
    // x-forwarded-for可能包含多个IP，取第一个
    const ips = forwardedFor.split(",");
    return ips[0]?.trim();
  }
  
  // 检查x-real-ip头
  const realIp = request.headers?.["x-real-ip"];
  if (realIp) {
    return realIp.trim();
  }
  
  // 最后使用socket.remoteAddress
  return request.socket?.remoteAddress;
}

export type WsRouteDeps = {
  sessionService: SessionService;
  realFundsWallet: RealFundsWalletService;
  worldService: WorldService;
  auditService: AuditService;
  wsConnectionRegistry: WsConnectionRegistry;
  agentPairingService: AgentPairingService;
  aipService: AipService;
  worldPartitionWsRegistry: WorldPartitionWsRegistry;
  agentCore: AgentCore;
  gomokuService: GomokuService;
  socialFeedService: SocialFeedService;
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
  unifiedIdempotencyService: UnifiedIdempotencyService;
  desktopBridgeCoordinator: DesktopBridgeCoordinator;
  virtualPhoneService: VirtualPhoneService;
  virtualPhoneIncomingCoordinator: VirtualPhoneIncomingCoordinator;
  userPersonalizationService: UserPersonalizationService;
};

export function registerWebSocketRoute(app: FastifyInstance, deps: WsRouteDeps): void {
  const {
    sessionService,
    realFundsWallet,
    worldService,
    auditService,
    wsConnectionRegistry,
    agentPairingService,
    aipService,
    worldPartitionWsRegistry,
    agentCore,
    gomokuService,
    socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    desktopBridgeCoordinator,
    virtualPhoneService,
    virtualPhoneIncomingCoordinator,
    userPersonalizationService,
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

  app.get(
    "/ws",
    { websocket: true },
    (socket, request) => {
      const ws = socket as SocketWithHeartbeat;
      let boundActorId: string | undefined;
      let initAsDesktopBridge = false;
      const clientIp = getClientIp(request);
      ws.isAlive = true;
      let heartbeatMissedAt = 0;
      const heartbeatTimer = setInterval(() => {
        const open = ws.readyState === undefined || ws.readyState === WS_READY_STATE_OPEN;
        if (!open) return;
        if (ws.isAlive === false) {
          const overdue = Date.now() - heartbeatMissedAt;
          if (heartbeatMissedAt > 0 && overdue >= WS_HEARTBEAT_GRACE_MS) {
            app.log.warn(
              { actorId: boundActorId, clientIp },
              "WebSocket heartbeat timeout, closing stale connection",
            );
            try {
              ws.close(1001, "heartbeat_timeout");
            } catch {
              // Ignore close failures on stale sockets.
            }
          }
          return;
        }
        ws.isAlive = false;
        heartbeatMissedAt = Date.now();
        try {
          ws.ping?.();
        } catch {
          try {
            ws.close(1001, "heartbeat_ping_failed");
          } catch {
            // Ignore close failures on broken sockets.
          }
        }
      }, WS_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      ws.on("pong", () => {
        ws.isAlive = true;
        heartbeatMissedAt = 0;
      });

      ws.on("error", (err) => {
        app.log.warn({ err, actorId: boundActorId, clientIp }, "WebSocket transport error");
      });

      ws.on("close", () => {
        clearInterval(heartbeatTimer);
        const detached = worldPartitionWsRegistry.detachSocket(socket);
        if (detached) {
          broadcastPartitionPresence(detached.partitionId);
        }
        desktopBridgeCoordinator.unbindIfSocket(socket);
        desktopBridgeCoordinator.cancelPendingForSocket(socket);
        if (boundActorId) {
          messageBatchProcessor.setClientProcessingUiActive(boundActorId, false);
          socialFeedService.unsubscribe(boundActorId);
          wsConnectionRegistry.unregister(boundActorId, socket);
          getEmbodimentAutonomy()?.unregisterSession(boundActorId);
          boundActorId = undefined;
        }
      });

      ws.on("message", async (raw: Buffer) => {
        ws.isAlive = true;
        heartbeatMissedAt = 0;
        const sendUnifiedError = (code: string, message: string, traceId?: string): void => {
          safeSocketSend(
            ws,
            JSON.stringify({
              type: ServerEventType.ErrorEvent,
              payload: { code, message, traceId },
            }),
          );
        };

        let event: EventEnvelope;
        try {
          event = JSON.parse(raw.toString()) as EventEnvelope;
        } catch {
          safeSocketSend(
            ws,
            JSON.stringify({
              type: ServerEventType.ErrorEvent,
              payload: { code: "BAD_JSON", message: "无法解析事件 JSON" },
            }),
          );
          return;
        }

        if (event.type === "ws.keepalive") {
          safeSocketSend(
            ws,
            JSON.stringify({
              type: "ws.keepalive_ack",
              payload: {
                ok: true,
                serverTime: new Date().toISOString(),
                sessionId: boundActorId,
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.VirtualPhoneUserCall) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const callPl = event.payload as Record<string, unknown>;
          const toActorId = String(callPl.toActorId ?? "").trim();
          const userMessage = String(callPl.userMessage ?? callPl.message ?? "").trim();
          if (!toActorId) {
            sendUnifiedError("BAD_PHONE_CALL", "缺少 toActorId（目标Agent ID）");
            return;
          }
          const callResult = await virtualPhoneService.handleUserCallAgent({
            fromUserId: boundActorId,
            toActorId,
            userMessage: userMessage || undefined,
          });
          if (!callResult.ok) {
            sendUnifiedError("PHONE_CALL_FAILED", callResult.error ?? "呼叫失败");
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.VirtualPhoneCallStatus,
              payload: {
                ok: true,
                callId: callResult.callId,
                status: "ringing",
                toActorId,
                message: "正在呼叫 Agent，请稍候…",
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.VirtualPhoneCallMyAgent) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const callPl = event.payload as Record<string, unknown>;
          const userMessage = String(callPl.userMessage ?? callPl.message ?? "").trim();
          const callResult = await virtualPhoneService.handleUserCallAgent({
            fromUserId: boundActorId,
            toActorId: boundActorId,
            userMessage: userMessage || undefined,
          });
          if (!callResult.ok) {
            sendUnifiedError("PHONE_CALL_FAILED", callResult.error ?? "呼叫失败");
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.VirtualPhoneCallStatus,
              payload: {
                ok: true,
                callId: callResult.callId,
                status: "ringing",
                toActorId: boundActorId,
                message: "正在呼叫你的 Agent…",
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.VirtualPhoneIncomingResponse) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const callPl = event.payload as Record<string, unknown>;
          const callId = String(callPl.callId ?? "").trim();
          const actionRaw = String(callPl.action ?? "").trim().toLowerCase();
          const allowed: IncomingPhoneUserAction[] = [
            "accept",
            "decline",
            "agent_takeover",
          ];
          if (!callId) {
            sendUnifiedError("BAD_PHONE_CALL", "缺少 callId");
            return;
          }
          if (!allowed.includes(actionRaw as IncomingPhoneUserAction)) {
            sendUnifiedError(
              "BAD_PHONE_CALL",
              "action 须为 accept | decline | agent_takeover",
            );
            return;
          }
          const action = actionRaw as IncomingPhoneUserAction;
          const result = await virtualPhoneIncomingCoordinator.handleUserResponse(
            boundActorId,
            callId,
            action,
          );
          if (!result.ok) {
            sendUnifiedError("PHONE_CALL_FAILED", result.error ?? "处理来电失败");
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.VirtualPhoneCallStatus,
              payload: {
                ok: true,
                callId,
                status: action === "accept" ? "answered_by_user" : "delegation_started",
                action,
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.CompanionContactFeedback) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const pl = event.payload as Record<string, unknown>;
          const sessionId = String(pl.sessionId ?? boundActorId).trim() || boundActorId;
          if (sessionId !== boundActorId) {
            sendUnifiedError("FORBIDDEN", "sessionId 与当前连接不一致");
            return;
          }
          const channel = String(pl.channel ?? "").trim();
          const responded = pl.responded === true;
          const feedbackRaw = pl.feedback == null ? "" : String(pl.feedback).trim();
          const quietHours = pl.quietHours === true;
          const responseTimeMs =
            typeof pl.responseTimeMs === "number" && Number.isFinite(pl.responseTimeMs)
              ? Math.max(0, Math.floor(pl.responseTimeMs))
              : undefined;
          if (!["websocket", "voice", "phone_call"].includes(channel)) {
            sendUnifiedError("BAD_CONTACT_FEEDBACK", "channel 必须是 websocket、voice 或 phone_call");
            return;
          }
          if (feedbackRaw && !["positive", "negative", "neutral"].includes(feedbackRaw)) {
            sendUnifiedError("BAD_CONTACT_FEEDBACK", "feedback 必须是 positive、negative 或 neutral");
            return;
          }
          userPersonalizationService.observeContactOutcome(boundActorId, {
            channel: channel as "websocket" | "voice" | "phone_call",
            responded,
            responseTimeMs,
            feedback: feedbackRaw
              ? (feedbackRaw as "positive" | "negative" | "neutral")
              : undefined,
            quietHours,
          });
          socket.send(
            JSON.stringify({
              type: "companion.contact_feedback_ack",
              payload: {
                ok: true,
                understanding: userPersonalizationService.getUnderstandingSnapshot(boundActorId),
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.SessionInit) {
          const payload = event.payload as Record<string, unknown>;
          const sessionIdRaw = String(payload.sessionId ?? "").trim();
          const userIdRaw = payload.userId != null ? String(payload.userId).trim() : "";
          const actorId = userIdRaw || sessionIdRaw;
          if (!actorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_SESSION_INIT", message: "需要 userId 或 sessionId" },
              }),
            );
            return;
          }
          const isDesktopBridgeChannel = payload.desktopBridge === true;
          if (isDesktopBridgeChannel) {
            if (!userIdRaw) {
              socket.send(
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "DESKTOP_BRIDGE_USER_ID_REQUIRED",
                    message: "与手机同一账号控制电脑时，session.init 须提供与手机相同的 userId（不可仅用 sessionId）",
                  },
                }),
              );
              return;
            }
            if (!desktopBridgeCoordinator.isBridgeFeatureEnabled()) {
              socket.send(
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "DESKTOP_BRIDGE_DISABLED",
                    message: "服务端未开启电脑桥接（设置 DESKTOP_BRIDGE_ENABLED=1 或 DESKTOP_BRIDGE_TOKEN）",
                  },
                }),
              );
              return;
            }
          }
          const deviceId = String(payload.deviceId ?? "");
          const userAlias = payload.userAlias ? String(payload.userAlias) : undefined;
          sessionService.upsert({ sessionId: actorId, deviceId, userAlias });
          realFundsWallet.bootstrap(actorId);
          worldService.getOrCreate(actorId);
          if (boundActorId && boundActorId !== actorId) {
            messageBatchProcessor.setClientProcessingUiActive(boundActorId, false);
          }
          desktopBridgeCoordinator.unbindIfSocket(socket);
          if (boundActorId && boundActorId !== actorId) {
            wsConnectionRegistry.unregister(boundActorId, socket);
          }
          boundActorId = actorId;
          initAsDesktopBridge = isDesktopBridgeChannel;
          if (!isDesktopBridgeChannel) {
            wsConnectionRegistry.register(actorId, socket);
            getEmbodimentAutonomy()?.registerSession(actorId);
          } else if (!desktopBridgeCoordinator.requiresRegisterToken()) {
            desktopBridgeCoordinator.bindExecutor(actorId, socket);
            socket.send(
              JSON.stringify({
                type: ServerEventType.DesktopBridgeRegisterAck,
                payload: { ok: true, actorId, mode: "userId" },
              }),
            );
          }
          await auditService.record({
            type: ClientEventType.SessionInit,
            sessionId: actorId,
            deviceId,
            userAlias: userAlias ?? "",
            userId: userIdRaw || undefined,
          });
          return;
        }

        if (event.type === ClientEventType.DesktopBridgeRegister) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!initAsDesktopBridge) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "DESKTOP_BRIDGE_INIT_REQUIRED",
                  message: "session.init 须设置 desktopBridge: true 方可绑定桌面执行器",
                },
              }),
            );
            return;
          }
          if (!desktopBridgeCoordinator.requiresRegisterToken()) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.DesktopBridgeRegisterAck,
                payload: { ok: true, actorId: boundActorId, mode: "userId", note: "当前为无口令模式，已在 session.init 自动绑定" },
              }),
            );
            return;
          }
          const token = String((event.payload as Record<string, unknown>).token ?? "").trim();
          if (!desktopBridgeCoordinator.verifyRegisterToken(token)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "DESKTOP_BRIDGE_TOKEN_REJECTED",
                  message: "桥接 token 与服务器 DESKTOP_BRIDGE_TOKEN 不一致",
                },
              }),
            );
            return;
          }
          desktopBridgeCoordinator.bindExecutor(boundActorId, socket);
          socket.send(
            JSON.stringify({
              type: ServerEventType.DesktopBridgeRegisterAck,
              payload: { ok: true, actorId: boundActorId, mode: "token" },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.DesktopBridgeResult) {
          const pl = event.payload as Record<string, unknown>;
          const jobId = String(pl.jobId ?? "").trim();
          if (!jobId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_DESKTOP_BRIDGE_RESULT", message: "缺少 jobId" },
              }),
            );
            return;
          }
          const ok = desktopBridgeCoordinator.completeFromSocket(socket, jobId, pl);
          if (!ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "DESKTOP_BRIDGE_JOB_UNKNOWN", message: "jobId 与当前连接不匹配或已结束" },
              }),
            );
          }
          return;
        }

        if (event.type === ClientEventType.ChatUserMessage) {
          await handleChatUserMessageEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              sendUnifiedError,
            },
            event.payload,
            { agentCore, auditService },
          );
          return;
        }

        if (event.type === ClientEventType.ChatAgentProcessingUi) {
          handleChatAgentProcessingUiEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              sendUnifiedError,
            },
            event.payload,
          );
          return;
        }

        if (event.type === ClientEventType.ChatClearHistory) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const provider = createExternalChatProviderFromEnv();
          if (provider?.clearSession) {
            const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
            const chatSessionId = resolvePrimaryChatSessionId(boundActorId, masterOn);
            provider.clearSession(chatSessionId);
          }
          return;
        }

        if (event.type === ClientEventType.AgentEmbodimentInteract) {
          await handleAgentEmbodimentInteractEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              sendUnifiedError,
            },
            event.payload,
            { agentCore, auditService },
          );
          return;
        }

        if (event.type === ClientEventType.AgentEmbodimentState) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (initAsDesktopBridge) return;
          handleAgentEmbodimentStateEvent(boundActorId, event.payload);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldPartitionAttach) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const parsedPa = worldPartitionAttachSchema.safeParse(event.payload);
          if (!parsedPa.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedPa.error.message },
              }),
            );
            return;
          }
          const { partitionId, traceId } = parsedPa.data;
          const state =
            partitionId === boundActorId
              ? worldService.getOrCreate(partitionId)
              : worldService.getExisting(partitionId);
          if (!state) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "PARTITION_NOT_FOUND",
                  message: "该房间不存在或尚无持久状态；共享房请先创建 world.room.create。",
                  traceId,
                },
              }),
            );
            return;
          }
          if (!canViewWorldPartition(boundActorId, state.ownerSessionId, agentPairingService)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "FORBIDDEN",
                  message: "无权订阅该房间（须为房间拥有者或与拥有者同一配对码）。",
                  traceId,
                },
              }),
            );
            return;
          }
          worldPartitionWsRegistry.attach(partitionId, boundActorId, socket);
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
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const parsedPd = worldPartitionDetachSchema.safeParse(event.payload);
          if (!parsedPd.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
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
                type: ServerEventType.ErrorEvent,
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

        if (event.type === AgentWorldClientEventType.WorldGomokuSubscribe) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const gomokuParsed = worldGomokuWsTableSchema.safeParse(event.payload);
          if (!gomokuParsed.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_GOMOKU_EVENT", message: gomokuParsed.error.message },
              }),
            );
            return;
          }
          const gomokuR = gomokuService.watchTable(gomokuParsed.data.tableId, boundActorId);
          if (!gomokuR.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "GOMOKU_SUBSCRIBE_FAILED", message: gomokuR.reason },
              }),
            );
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldGomokuSubscribeLobby) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          gomokuService.watchLobby(boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldGomokuUnsubscribeLobby) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          gomokuService.unwatchLobby(boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldGomokuUnsubscribe) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const gomokuUnsub = worldGomokuWsTableSchema.safeParse(event.payload);
          if (!gomokuUnsub.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_GOMOKU_EVENT", message: gomokuUnsub.error.message },
              }),
            );
            return;
          }
          gomokuService.unwatchTable(gomokuUnsub.data.tableId, boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialSubscribe) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          socialFeedService.subscribe(boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialUnsubscribe) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          socialFeedService.unsubscribe(boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialPost) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socPost = worldSocialPostPayloadSchema.safeParse(event.payload);
          if (!socPost.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socPost.error.message },
              }),
            );
            return;
          }
          const text = socPost.data.text ?? "";
          const mediaType = socPost.data.mediaType ?? "none";
          const mediaUrl = socPost.data.mediaUrl === undefined ? null : socPost.data.mediaUrl;
          const rSoc = socialFeedService.createPost(boundActorId, text, mediaType, mediaUrl);
          if (!rSoc.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_POST_FAILED", message: rSoc.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialComment) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socC = worldSocialCommentPayloadSchema.safeParse(event.payload);
          if (!socC.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socC.error.message },
              }),
            );
            return;
          }
          const rC = socialFeedService.addComment(boundActorId, socC.data.postId, socC.data.text);
          if (!rC.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_COMMENT_FAILED", message: rC.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialLikeToggle) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socL = worldSocialLikePayloadSchema.safeParse(event.payload);
          if (!socL.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socL.error.message },
              }),
            );
            return;
          }
          const rL = socialFeedService.toggleLike(boundActorId, socL.data.postId);
          if (!rL.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_LIKE_FAILED", message: rL.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialPostDelete) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socDel = worldSocialPostDeletePayloadSchema.safeParse(event.payload);
          if (!socDel.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socDel.error.message },
              }),
            );
            return;
          }
          const rDel = socialFeedService.deletePost(boundActorId, socDel.data.postId);
          if (!rDel.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_DELETE_FAILED", message: rDel.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialReport) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socRep = worldSocialReportPayloadSchema.safeParse(event.payload);
          if (!socRep.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socRep.error.message },
              }),
            );
            return;
          }
          const rRep = socialFeedService.reportPost(boundActorId, socRep.data.postId, socRep.data.reason);
          if (!rRep.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_REPORT_FAILED", message: rRep.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === ClientEventType.AipDispatch) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const parsedAip = aipDispatchWsSchema.safeParse(event.payload);
          if (!parsedAip.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedAip.error.message },
              }),
            );
            return;
          }
          const rAip = aipService.dispatch({
            fromSessionId: boundActorId,
            toSessionId: parsedAip.data.toSessionId,
            rawEnvelope: parsedAip.data.envelope,
            chatUserMessageId: parsedAip.data.chatUserMessageId,
          });
          if (!rAip.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "AIP_DISPATCH_FAILED", message: rAip.message },
              }),
            );
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.ToolResult,
              payload: {
                toolName: "aip.dispatch",
                ok: true,
                result: {
                  messageId: rAip.record.messageId,
                  pushedToPeer: rAip.pushedToPeer,
                  aip: rAip.record.aip,
                },
                traceId: "",
              },
            }),
          );
          return;
        }

        if (event.type === UnifiedClientEventType.Capabilities) {
          const parsedCap = unifiedCapabilitiesClientSchema.safeParse(event.payload);
          if (!parsedCap.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedCap.error.message },
              }),
            );
            return;
          }
          socket.send(
            JSON.stringify({
              type: UnifiedServerEventType.Capabilities,
              payload: {
                ok: true,
                unifiedProtocol: UNIFIED_PROTOCOL_VERSION,
                layers: UNIFIED_LAYER_MANIFEST,
                traceId: parsedCap.data.traceId,
              },
            }),
          );
          return;
        }

        if (event.type === UnifiedClientEventType.QuotaAdjust) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedQ = unifiedQuotaAdjustSchema.safeParse(event.payload);
          if (!parsedQ.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedQ.error.message);
            return;
          }
          const quotaActor = resolveUnifiedMemoryActorId(parsedQ.data);
          if (quotaActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedQ.data.traceId,
            );
            return;
          }
          const cached = unifiedIdempotencyService.get(
            quotaActor,
            UnifiedClientEventType.QuotaAdjust,
            parsedQ.data.requestId,
          );
          if (cached) {
            socket.send(
              JSON.stringify({
                type: UnifiedServerEventType.QuotaState,
                payload: { ...cached, deduped: true },
              }),
            );
            return;
          }
          const adj = computeQuotaService.adjust(quotaActor, parsedQ.data.op, parsedQ.data.units);
          const st = computeQuotaService.getState(quotaActor);
          const payload = {
            ok: adj.ok,
            op: parsedQ.data.op,
            units: parsedQ.data.units,
            reason: adj.ok ? undefined : adj.reason,
            code: adj.ok ? undefined : UnifiedErrorCode.BadRequest,
            ...st,
            traceId: parsedQ.data.traceId,
          };
          unifiedIdempotencyService.set(
            quotaActor,
            UnifiedClientEventType.QuotaAdjust,
            parsedQ.data.requestId,
            payload,
          );
          socket.send(JSON.stringify({ type: UnifiedServerEventType.QuotaState, payload }));
          return;
        }

        if (event.type === UnifiedClientEventType.MemoryPatch) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedMp = unifiedMemoryPatchSchema.safeParse(event.payload);
          if (!parsedMp.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedMp.error.message);
            return;
          }
          const memPatchActor = resolveUnifiedMemoryActorId(parsedMp.data);
          if (memPatchActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedMp.data.traceId,
            );
            return;
          }
          const cached = unifiedIdempotencyService.get(
            memPatchActor,
            UnifiedClientEventType.MemoryPatch,
            parsedMp.data.requestId,
          );
          if (cached) {
            socket.send(
              JSON.stringify({
                type: UnifiedServerEventType.MemorySnapshot,
                payload: { ...cached, deduped: true },
              }),
            );
            return;
          }
          const patchResult = await agentMemorySyncService.applyPatch(
            memPatchActor,
            parsedMp.data.basisRevision,
            parsedMp.data.patches,
          );
          if (!patchResult.ok) {
            const failedPayload = {
              ok: false,
              code: UnifiedErrorCode.BadRequest,
              reason: patchResult.reason,
              currentRevision: patchResult.currentRevision,
              traceId: parsedMp.data.traceId,
            };
            unifiedIdempotencyService.set(
              memPatchActor,
              UnifiedClientEventType.MemoryPatch,
              parsedMp.data.requestId,
              failedPayload,
            );
            socket.send(
              JSON.stringify({ type: UnifiedServerEventType.MemorySnapshot, payload: failedPayload }),
            );
            return;
          }
          const snap = agentMemorySyncService.getSnapshot(memPatchActor);
          const payload = {
            ok: true,
            revision: patchResult.revision,
            entries: snap.entries,
            traceId: parsedMp.data.traceId,
          };
          unifiedIdempotencyService.set(
            memPatchActor,
            UnifiedClientEventType.MemoryPatch,
            parsedMp.data.requestId,
            payload,
          );
          socket.send(JSON.stringify({ type: UnifiedServerEventType.MemorySnapshot, payload }));
          return;
        }

        if (event.type === UnifiedClientEventType.MemoryGet) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedMg = unifiedMemoryGetSchema.safeParse(event.payload);
          if (!parsedMg.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedMg.error.message);
            return;
          }
          const memGetActor = resolveUnifiedMemoryActorId(parsedMg.data);
          if (memGetActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedMg.data.traceId,
            );
            return;
          }
          const snapG = agentMemorySyncService.getSnapshot(memGetActor, parsedMg.data.keys);
          socket.send(
            JSON.stringify({
              type: UnifiedServerEventType.MemorySnapshot,
              payload: {
                ok: true,
                revision: snapG.revision,
                entries: snapG.entries,
                traceId: parsedMg.data.traceId,
              },
            }),
          );
          return;
        }

        if (event.type === UnifiedClientEventType.HumanDirective) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedHd = unifiedHumanDirectiveSchema.safeParse(event.payload);
          if (!parsedHd.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedHd.error.message);
            return;
          }
          const hdActor = resolveUnifiedMemoryActorId(parsedHd.data);
          if (hdActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedHd.data.traceId,
            );
            return;
          }
          const cached = unifiedIdempotencyService.get(
            hdActor,
            UnifiedClientEventType.HumanDirective,
            parsedHd.data.requestId,
          );
          if (cached) {
            socket.send(
              JSON.stringify({
                type: UnifiedServerEventType.HumanDirectiveAck,
                payload: { ...cached, deduped: true },
              }),
            );
            return;
          }
          if (parsedHd.data.scope === "partition" && !parsedHd.data.partitionId?.trim()) {
            sendUnifiedError(
              UnifiedErrorCode.ValidationError,
              "scope=partition 时必须提供 partitionId",
              parsedHd.data.traceId,
            );
            return;
          }
          const receivedAt = new Date().toISOString();
          await auditService.record({
            type: UnifiedClientEventType.HumanDirective,
            sessionId: hdActor,
            scope: parsedHd.data.scope,
            partitionId: parsedHd.data.partitionId,
            priority: parsedHd.data.priority ?? "normal",
            text: parsedHd.data.text,
            traceId: parsedHd.data.traceId,
          });
          const payload = {
            ok: true,
            scope: parsedHd.data.scope,
            partitionId: parsedHd.data.partitionId,
            receivedAt,
            traceId: parsedHd.data.traceId,
          };
          unifiedIdempotencyService.set(
            hdActor,
            UnifiedClientEventType.HumanDirective,
            parsedHd.data.requestId,
            payload,
          );
          socket.send(JSON.stringify({ type: UnifiedServerEventType.HumanDirectiveAck, payload }));
          return;
        }

        if (event.type === UnifiedClientEventType.GovernanceProbe) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedGp = unifiedGovernanceProbeSchema.safeParse(event.payload);
          if (!parsedGp.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedGp.error.message);
            return;
          }
          const gpActor = resolveUnifiedMemoryActorId(parsedGp.data);
          if (gpActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedGp.data.traceId,
            );
            return;
          }
          const action = parsedGp.data.action;
          const allowed =
            action !== "world.http.mutation" || allowWorldHttpMutations();
          socket.send(
            JSON.stringify({
              type: UnifiedServerEventType.GovernanceAck,
              payload: {
                ok: true,
                allowed,
                action,
                rulesApplied: ["world.http.mutation<=ALLOW_WORLD_HTTP_MUTATIONS"],
                traceId: parsedGp.data.traceId,
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.WalletSimulateRequest) {
          const parsed = walletRequestSchema.safeParse(event.payload);
          if (!parsed.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_WALLET_EVENT", message: parsed.error.message },
              }),
            );
            return;
          }
          const data = parsed.data;
          const result = realFundsWallet.simulate(
            data.sessionId,
            data.action as WalletAction,
            data.amount,
          );
          await auditService.record({
            type: ClientEventType.WalletSimulateRequest,
            sessionId: data.sessionId,
            action: data.action,
            amount: data.amount,
            requestId: data.requestId,
          });
          socket.send(
            JSON.stringify({
              type: ServerEventType.WalletSimulateResult,
              payload: {
                requestId: data.requestId,
                action: data.action,
                amount: data.amount,
                ok: result.ok,
                ledgerKind: "real_funds",
                ledger: result.ledger,
                auditId: `audit-${Date.now()}`,
                reason: result.reason,
              },
            }),
          );
          return;
        }

        socket.send(
          JSON.stringify({
            type: ServerEventType.ErrorEvent,
            payload: { code: "UNKNOWN_EVENT", message: `未知事件: ${event.type}` },
          }),
        );
      });
    },
  );
}
