import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import type {
  RuntimeFacade,
  HandleUserMessageOptions,
  AgentReply,
  RouteDecision,
  ToolIfNeededOptions,
  ToolIfNeededResult,
} from "../runtime-facade.js";
import { parseLinkFrame, RUNTIME_LINK_METHODS } from "./link-protocol.js";

/**
 * runtime 链路客户端：在网关/外壳进程内实现 {@link RuntimeFacade}，
 * 经 WS 链路把 turn 调用转发到 runtime 进程。
 *
 * - 流式回调：调用方传入的 opts 回调按名字映射为链路 ev 帧；
 *   本端收到 ev 帧后回调对应函数。
 * - abort：调用方 opts.signal 触发 abort 时，发送 AbortTurn 帧，
 *   由 runtime 侧其中断对应 actor 的进行中 turn。
 * - 断线语义：连接断开时，未完成的请求以 LinkDisconnectedError 拒绝；
 *   后台自动重连（指数退避），恢复后新请求正常收发。
 */

export class LinkDisconnectedError extends Error {
  constructor() {
    super("runtime link disconnected");
    this.name = "LinkDisconnectedError";
  }
}

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onEvent?: (cb: string, args: unknown[]) => void;
};

export type WsRuntimeClientOptions = {
  url: string;
  token?: string | null;
  /** 首次连接超时（ms）；超时认为 runtime 未启动 */
  connectTimeoutMs?: number;
  onStatusChange?: (connected: boolean) => void;
};

export class WsRuntimeClient implements RuntimeFacade {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private connecting: Promise<WebSocket> | null = null;
  private readonly url: URL;
  private disposed = false;

  constructor(private readonly options: WsRuntimeClientOptions) {
    this.url = new URL(options.url);
    if (options.token) this.url.searchParams.set("token", options.token);
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** 建立连接（已连接时幂等返回）。 */
  async ensureConnected(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    if (this.disposed) throw new LinkDisconnectedError();

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new LinkDisconnectedError());
      }, this.options.connectTimeoutMs ?? 5000);

      socket.on("open", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.options.onStatusChange?.(true);
        resolve(socket);
      });
      socket.on("message", (data) => this.dispatch(data.toString()));
      const onDown = () => {
        clearTimeout(timeout);
        this.options.onStatusChange?.(false);
        this.failPending(new LinkDisconnectedError());
        if (this.socket === socket) this.socket = null;
        this.connecting = null;
        if (!this.disposed) void this.reconnectLater();
        reject(new LinkDisconnectedError());
      };
      socket.on("close", onDown);
      socket.on("error", onDown);
    });
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async reconnectLater(): Promise<void> {
    for (let attempt = 0; attempt < 20 && !this.disposed; attempt += 1) {
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000)));
      try {
        await this.ensureConnected();
        console.log("[runtime-link] reconnected to runtime");
        return;
      } catch {
        /* 继续退避重试 */
      }
    }
  }

  private dispatch(raw: string): void {
    const frame = parseLinkFrame(raw);
    if (!frame || frame.kind === "req") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.kind === "ev") {
      pending.onEvent?.(frame.cb, frame.args);
      return;
    }
    this.pending.delete(frame.id);
    if (frame.kind === "res") pending.resolve(frame.result);
    else pending.reject(new Error(frame.message));
  }

  private failPending(err: Error): void {
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    onEvent?: (cb: string, args: unknown[]) => void,
  ): Promise<T> {
    const socket = await this.ensureConnected();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        onEvent,
      });
      try {
        socket.send(JSON.stringify({ kind: "req", id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    const {
      onAssistantDelta,
      onExternalToolExecuteStart,
      onExternalToolExecuted,
      onToolLoopAfterBatch,
      onBackgroundAssistantDelta,
      onBackgroundAssistantDone,
      onAgentPhaseStatus,
      onPlanReady,
      signal,
      wireOpts,
    } = splitCallbacks(opts);
    const promise = this.call<AgentReply>(
      RUNTIME_LINK_METHODS.HandleUserMessage,
      { actorId, text, opts: wireOpts },
      (cb, args) => {
        const handler = CALLBACK_HANDLERS[cb];
        handler?.({ onAssistantDelta, onExternalToolExecuteStart, onExternalToolExecuted, onToolLoopAfterBatch, onBackgroundAssistantDelta, onBackgroundAssistantDone, onAgentPhaseStatus, onPlanReady }, args);
      },
    );
    if (signal) {
      const onAbort = () => {
        void this.call(RUNTIME_LINK_METHODS.AbortTurn, { actorId }).catch(() => {
          /* runtime 已断开时忽略 */
        });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return promise;
  }

  async runToolIfNeeded(
    actorId: string,
    reply: AgentReply,
    opts?: ToolIfNeededOptions,
  ): Promise<ToolIfNeededResult> {
    return this.call<ToolIfNeededResult>(RUNTIME_LINK_METHODS.RunToolIfNeeded, {
      actorId,
      reply,
      opts,
    });
  }

  async routeTurnForWs(sessionId: string, text: string, recentUserTurns: string[] = []): Promise<RouteDecision> {
    return this.call<RouteDecision>(RUNTIME_LINK_METHODS.RouteTurn, {
      sessionId,
      text,
      recentUserTurns,
    });
  }

  async resumeAutonomousTasks(): Promise<number> {
    const result = await this.call<{ restored: number }>(RUNTIME_LINK_METHODS.ResumeAutonomousTasks, {});
    return result.restored;
  }

  async health(): Promise<{ ok: boolean; uptimeMs: number }> {
    return this.call(RUNTIME_LINK_METHODS.Health, {});
  }

  dispose(): void {
    this.disposed = true;
    this.failPending(new LinkDisconnectedError());
    this.socket?.close();
    this.socket = null;
  }
}

type SplitCallbacks = {
  onAssistantDelta?: HandleUserMessageOptions["onAssistantDelta"];
  onExternalToolExecuteStart?: HandleUserMessageOptions["onExternalToolExecuteStart"];
  onExternalToolExecuted?: HandleUserMessageOptions["onExternalToolExecuted"];
  onToolLoopAfterBatch?: HandleUserMessageOptions["onToolLoopAfterBatch"];
  onBackgroundAssistantDelta?: HandleUserMessageOptions["onBackgroundAssistantDelta"];
  onBackgroundAssistantDone?: HandleUserMessageOptions["onBackgroundAssistantDone"];
  onAgentPhaseStatus?: HandleUserMessageOptions["onAgentPhaseStatus"];
  onPlanReady?: HandleUserMessageOptions["onPlanReady"];
  signal?: AbortSignal;
  wireOpts: Record<string, unknown>;
};

/** 拆分 opts：回调与 signal 留在本端，标量字段上链路。 */
function splitCallbacks(opts?: HandleUserMessageOptions): SplitCallbacks {
  if (!opts) return { wireOpts: {} };
  const {
    onAssistantDelta,
    onExternalToolExecuteStart,
    onExternalToolExecuted,
    onToolLoopAfterBatch,
    onBackgroundAssistantDelta,
    onBackgroundAssistantDone,
    onAgentPhaseStatus,
    onPlanReady,
    signal,
    ...wireOpts
  } = opts;
  return {
    onAssistantDelta,
    onExternalToolExecuteStart,
    onExternalToolExecuted,
    onToolLoopAfterBatch,
    onBackgroundAssistantDelta,
    onBackgroundAssistantDone,
    onAgentPhaseStatus,
    onPlanReady,
    signal,
    wireOpts: wireOpts as Record<string, unknown>,
  };
}

type CallbackBundle = Pick<
  SplitCallbacks,
  | "onAssistantDelta"
  | "onExternalToolExecuteStart"
  | "onExternalToolExecuted"
  | "onToolLoopAfterBatch"
  | "onBackgroundAssistantDelta"
  | "onBackgroundAssistantDone"
  | "onAgentPhaseStatus"
  | "onPlanReady"
>;

/** ev 帧 → 本端回调（按回调名分派，参数顺序与 HandleUserMessageOptions 一致）。 */
const CALLBACK_HANDLERS: Record<string, (cb: CallbackBundle, args: unknown[]) => void> = {
  onAssistantDelta: (cb, args) => cb.onAssistantDelta?.(String(args[0] ?? "")),
  onExternalToolExecuteStart: (cb, args) => cb.onExternalToolExecuteStart?.(args[0] as never),
  onExternalToolExecuted: (cb, args) => cb.onExternalToolExecuted?.(args[0] as never),
  onToolLoopAfterBatch: (cb, args) => cb.onToolLoopAfterBatch?.(args[0] as never),
  onBackgroundAssistantDelta: (cb, args) => cb.onBackgroundAssistantDelta?.(args[0] as never),
  onBackgroundAssistantDone: (cb, args) => cb.onBackgroundAssistantDone?.(args[0] as never),
  onAgentPhaseStatus: (cb, args) => cb.onAgentPhaseStatus?.(String(args[0] ?? "")),
  onPlanReady: (cb, args) => cb.onPlanReady?.(args[0] as never),
};
