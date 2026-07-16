import { randomUUID, timingSafeEqual } from "node:crypto";

import { ServerEventType } from "../protocol.js";
import type { DesktopVisualRunResult } from "./desktop-visual-port.js";

export type WsSendLike = {
  send(data: string): void;
  readyState?: number;
};

type PendingJob = {
  resolve: (r: DesktopVisualRunResult) => void;
  timer: NodeJS.Timeout;
  socket: WsSendLike;
};

export type DesktopBridgeSyncPayload = {
  bridgeOnline: boolean;
  updatedAt: string;
  lastTask: {
    ok: boolean;
    steps?: number;
    summary?: string;
    error?: string;
  } | null;
};

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type DesktopBridgeEvent = {
  actorId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: number | string;
};

export type DesktopBridgeEventListener = (
  actorId: string,
  event: DesktopBridgeEvent,
) => void;

export type DesktopBridgeCoordinatorOptions = {
  onSync?: (actorId: string, payload: DesktopBridgeSyncPayload) => void;
  onTaskResult?: (actorId: string, payload: DesktopBridgeSyncPayload) => void;
  /** 电脑端主动推送事件（desktop.event）到达时回调，供上层订阅转 LifeSignal 等。 */
  onEvent?: (actorId: string, event: DesktopBridgeEvent) => void;
};

export class DesktopBridgeCoordinator {
  private readonly executors = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly lastTaskByActor = new Map<
    string,
    { ok: boolean; steps?: number; summary?: string; error?: string }
  >();
  private readonly lastSyncAt = new Map<string, string>();

  constructor(private readonly opts?: DesktopBridgeCoordinatorOptions) {}

  isBridgeFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (parseBooleanEnv(env.DESKTOP_BRIDGE_ENABLED)) return true;
    const t = env.DESKTOP_BRIDGE_TOKEN?.trim() ?? "";
    return t.length >= 8;
  }

  isBridgeModeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return this.isBridgeFeatureEnabled(env);
  }

  requiresRegisterToken(env: NodeJS.ProcessEnv = process.env): boolean {
    const t = env.DESKTOP_BRIDGE_TOKEN?.trim() ?? "";
    return t.length >= 8;
  }

  private expectedToken(env: NodeJS.ProcessEnv = process.env): string {
    return env.DESKTOP_BRIDGE_TOKEN?.trim() ?? "";
  }

  verifyRegisterToken(token: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!this.requiresRegisterToken(env)) return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(this.expectedToken(env), "utf8");
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  getSyncPayload(actorId: string): DesktopBridgeSyncPayload {
    return {
      bridgeOnline: this.hasExecutor(actorId),
      updatedAt: this.lastSyncAt.get(actorId) ?? new Date().toISOString(),
      lastTask: this.lastTaskByActor.get(actorId) ?? null,
    };
  }

  recordTaskResult(actorId: string, result: DesktopVisualRunResult): void {
    this.lastTaskByActor.set(actorId, {
      ok: result.ok,
      steps: result.steps,
      summary: result.summary,
      error: result.error,
    });
    this.pushSync(actorId);
    this.opts?.onTaskResult?.(actorId, this.getSyncPayload(actorId));
  }

  private pushSync(actorId: string): void {
    const now = new Date().toISOString();
    this.lastSyncAt.set(actorId, now);
    const payload: DesktopBridgeSyncPayload = {
      bridgeOnline: this.hasExecutor(actorId),
      updatedAt: now,
      lastTask: this.lastTaskByActor.get(actorId) ?? null,
    };
    this.opts?.onSync?.(actorId, payload);
  }

  hasExecutor(actorId: string): boolean {
    const s = this.executors.get(actorId);
    if (!s) return false;
    const open = s.readyState === undefined || s.readyState === 1;
    return open;
  }

  bindExecutor(actorId: string, socket: WsSendLike): void {
    this.executors.set(actorId, socket);
    this.pushSync(actorId);
  }

  unbindIfSocket(socket: WsSendLike): void {
    const removed: string[] = [];
    for (const [id, s] of this.executors) {
      if (s === socket) {
        this.executors.delete(id);
        removed.push(id);
      }
    }
    for (const id of removed) {
      this.pushSync(id);
    }
  }

  cancelPendingForSocket(socket: WsSendLike): void {
    for (const [jobId, p] of this.pending) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        this.pending.delete(jobId);
        p.resolve({ ok: false, error: "desktop bridge disconnected" });
      }
    }
  }

  invoke(
    actorId: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopVisualRunResult | null> {
    const socket = this.executors.get(actorId);
    if (!socket) return Promise.resolve(null);
    const open = socket.readyState === undefined || socket.readyState === 1;
    if (!open) {
      this.executors.delete(actorId);
      this.pushSync(actorId);
      return Promise.resolve(null);
    }
    const jobId = randomUUID();
    return new Promise<DesktopVisualRunResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(jobId)) return;
        this.pending.delete(jobId);
        resolve({ ok: false, error: `desktop execution timeout > ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(jobId, { socket, timer, resolve });
      try {
        socket.send(
          JSON.stringify({
            type: ServerEventType.DesktopBridgeInvoke,
            payload: { jobId, ...payload },
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(jobId);
        resolve({ ok: false, error: "failed to send task to desktop bridge" });
      }
    });
  }

  completeFromSocket(socket: WsSendLike, jobId: string, payload: Record<string, unknown>): boolean {
    const p = this.pending.get(jobId);
    if (!p || p.socket !== socket) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    // 透传所有字段(除 jobId) — bridge coordinator 是传输层,不应过滤工具结果字段。
    // uia_query 的 elements/count/mode/selector、run_input 的 action/x/y、
    // run_shell 的 stdout/stderr/exitCode 等都需要原样传递给工具层和 LLM。
    const { jobId: _jobId, ...result } = payload;
    p.resolve(result as DesktopVisualRunResult);
    return true;
  }

  private readonly eventListeners = new Set<DesktopBridgeEventListener>();

  /**
   * 订阅 desktop.event 主动推送事件，返回取消订阅函数。
   * Task 4 用此接入 LifeSignal 转换；本任务仅做消息接收与转发，不转换。
   */
  subscribeEvents(listener: DesktopBridgeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * 接收来自已绑定 desktop bridge socket 的主动事件推送（desktop.event），
   * 校验 socket 归属后转发给订阅者。与 invoke 的 jobId 配对队列互不影响：
   * event 是单向推送，不进入 pending 队列，因此不会阻塞请求-响应通道。
   */
  handleEventFromSocket(
    socket: WsSendLike,
    actorId: string,
    event: DesktopBridgeEvent,
  ): boolean {
    const bound = this.executors.get(actorId);
    if (!bound || bound !== socket) return false;
    this.dispatchEvent(actorId, event);
    return true;
  }

  private dispatchEvent(actorId: string, event: DesktopBridgeEvent): void {
    this.opts?.onEvent?.(actorId, event);
    for (const listener of this.eventListeners) {
      try {
        listener(actorId, event);
      } catch {
        // 订阅者异常不应影响其他订阅者或 ws 通道
      }
    }
  }
}
