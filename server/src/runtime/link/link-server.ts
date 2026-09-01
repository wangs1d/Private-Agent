import { WebSocketServer, type WebSocket } from "ws";

import type { RuntimeFacade, HandleUserMessageOptions } from "../runtime-facade.js";
import {
  createActiveTurnRegistry,
  parseLinkFrame,
  RUNTIME_LINK_METHODS,
  type ActiveTurnRegistry,
  type LinkFrame,
} from "./link-protocol.js";

/**
 * runtime 链路服务端：把 {@link RuntimeFacade} 经 WS 暴露给网关/外壳进程。
 *
 * 帧语义见 link-protocol.ts。流式回调（onAssistantDelta 等）以 ev 帧回推，
 * 最终结果以 res/err 帧收尾；abortTurn 独立成帧按 actor 中断进行中的 turn。
 * 客户端断开不中断 turn（结果丢弃）；重连后可发起新请求。
 */

export type RuntimeLinkServerOptions = {
  port: number;
  host?: string;
  token?: string | null;
  facade: RuntimeFacade;
  activeTurns?: ActiveTurnRegistry;
};

export type RuntimeLinkServer = {
  port: number;
  close(): Promise<void>;
};

/** 循环引用安全的 JSON 序列化（ev 帧参数兜底）。 */
function safeJsonReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (_key, value) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    if (typeof value === "function") return undefined;
    return value;
  };
}

function serialize(frame: LinkFrame): string {
  return JSON.stringify(frame, safeJsonReplacer());
}

/** 从链路参数重建 HandleUserMessageOptions（标量字段直传，回调改为 ev 帧回推）。 */
function buildTurnOptions(
  raw: Record<string, unknown> | undefined,
  emit: (cb: string, ...args: unknown[]) => void,
): HandleUserMessageOptions {
  const params = raw ?? {};
  const stringField = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === "string" ? v : undefined;
  };
  const opts: HandleUserMessageOptions = {
    chatUserMessageId: stringField("chatUserMessageId"),
    userId: stringField("userId"),
    clientIp: stringField("clientIp"),
    clientLocation: params.clientLocation as HandleUserMessageOptions["clientLocation"],
    visionFrames: params.visionFrames as HandleUserMessageOptions["visionFrames"],
    interruptedContext: stringField("interruptedContext"),
    agentAccessMode: params.agentAccessMode as HandleUserMessageOptions["agentAccessMode"],
    preferFullPipeline: typeof params.preferFullPipeline === "boolean" ? params.preferFullPipeline : undefined,
    sessionId: stringField("sessionId"),
    routeDecision: params.routeDecision as HandleUserMessageOptions["routeDecision"],
    onAssistantDelta: (delta) => emit("onAssistantDelta", delta),
    onExternalToolExecuteStart: (info) => emit("onExternalToolExecuteStart", info),
    onExternalToolExecuted: (info) => emit("onExternalToolExecuted", info),
    onToolLoopAfterBatch: (info) => emit("onToolLoopAfterBatch", info),
    onBackgroundAssistantDelta: (info) => emit("onBackgroundAssistantDelta", info),
    onBackgroundAssistantDone: (info) => emit("onBackgroundAssistantDone", info),
    onAgentPhaseStatus: (line) => emit("onAgentPhaseStatus", line),
    onPlanReady: (plan) => emit("onPlanReady", plan),
  };
  return opts;
}

export function startRuntimeLinkServer(options: RuntimeLinkServerOptions): Promise<RuntimeLinkServer> {
  const { port, host = "127.0.0.1", token, facade } = options;
  const activeTurns = options.activeTurns ?? createActiveTurnRegistry();
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host });

    wss.once("error", reject);
    wss.once("listening", () => {
      wss.removeListener("error", reject);
      wss.on("error", (err) => {
        console.error("[runtime-link] server error:", err.message);
      });
      console.log(`[runtime-link] listening on ws://${host}:${port}`);

      wss.on("connection", (socket, request) => {
        if (token) {
          const url = new URL(request.url ?? "/", "http://localhost");
          if (url.searchParams.get("token") !== token) {
            socket.close(4001, "unauthorized");
            return;
          }
        }
        socket.on("message", (data) => {
          void handleFrame(socket, data.toString());
        });
      });

      resolve({
        port,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });

    async function handleFrame(socket: WebSocket, raw: string): Promise<void> {
      const frame = parseLinkFrame(raw);
      if (!frame || frame.kind !== "req") return;

      const send = (payload: LinkFrame) => {
        if (socket.readyState !== socket.OPEN) return;
        try {
          socket.send(serialize(payload));
        } catch {
          /* 客户端断开：帧丢弃 */
        }
      };
      const emit = (id: string, cb: string, ...args: unknown[]) =>
        send({ kind: "ev", id, cb, args });

      try {
        switch (frame.method) {
          case RUNTIME_LINK_METHODS.Health: {
            send({ kind: "res", id: frame.id, ok: true, result: { ok: true, uptimeMs: Date.now() - startedAt } });
            return;
          }
          case RUNTIME_LINK_METHODS.HandleUserMessage: {
            const actorId = String(frame.params.actorId ?? "");
            const text = String(frame.params.text ?? "");
            if (!actorId) {
              send({ kind: "err", id: frame.id, ok: false, message: "actorId is required" });
              return;
            }
            const controller = new AbortController();
            activeTurns.track(actorId, controller);
            const opts = buildTurnOptions(frame.params.opts as Record<string, unknown> | undefined, (cb, ...args) =>
              emit(frame.id, cb, ...args),
            );
            opts.signal = controller.signal;
            const result = await facade.handleUserMessage(actorId, text, opts);
            send({ kind: "res", id: frame.id, ok: true, result });
            return;
          }
          case RUNTIME_LINK_METHODS.RouteTurn: {
            const sessionId = String(frame.params.sessionId ?? "");
            const text = String(frame.params.text ?? "");
            const recent = Array.isArray(frame.params.recentUserTurns)
              ? (frame.params.recentUserTurns as unknown[]).map(String)
              : [];
            const result = await facade.routeTurnForWs(sessionId, text, recent);
            send({ kind: "res", id: frame.id, ok: true, result });
            return;
          }
          case RUNTIME_LINK_METHODS.RunToolIfNeeded: {
            const actorId = String(frame.params.actorId ?? "");
            const reply = frame.params.reply as Parameters<RuntimeFacade["runToolIfNeeded"]>[1];
            const result = await facade.runToolIfNeeded(actorId, reply, frame.params.opts as never);
            send({ kind: "res", id: frame.id, ok: true, result });
            return;
          }
          case RUNTIME_LINK_METHODS.ResumeAutonomousTasks: {
            const restored = await facade.resumeAutonomousTasks();
            send({ kind: "res", id: frame.id, ok: true, result: { restored } });
            return;
          }
          case RUNTIME_LINK_METHODS.AbortTurn: {
            const actorId = String(frame.params.actorId ?? "");
            const aborted = activeTurns.abort(actorId);
            send({ kind: "res", id: frame.id, ok: true, result: { aborted } });
            return;
          }
          default:
            send({ kind: "err", id: frame.id, ok: false, message: `unknown method: ${frame.method}` });
        }
      } catch (err) {
        send({
          kind: "err",
          id: frame.id,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}
