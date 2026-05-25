import { randomUUID, timingSafeEqual } from "node:crypto";

import { ServerEventType } from "../protocol.js";
import type { DesktopVisualRunResult } from "./desktop-visual-agent-port.js";

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

export type DesktopBridgeCoordinatorOptions = {
  /** 向该 actor 的主聊天 WS 推送同步（手机端） */
  onSync?: (actorId: string, payload: DesktopBridgeSyncPayload) => void;
};

/**
 * 手机经服务端调度 → 已绑定 WebSocket 的电脑端执行纯视觉桌面任务。
 * 与 {@link WsConnectionRegistry} 分离，避免电脑桥接连接抢占手机聊天下行。
 *
 * 启用条件：{@link isBridgeFeatureEnabled}（`DESKTOP_BRIDGE_ENABLED=1` 或配置了 `DESKTOP_BRIDGE_TOKEN`）。
 * 无配对码模式：`session.init` 带 `desktopBridge:true` 且与手机相同的 **userId** 即自动绑定；
 * 若配置了 `DESKTOP_BRIDGE_TOKEN`，则须额外发送 `desktop.bridge.register` 校验 token。
 */
export class DesktopBridgeCoordinator {
  private readonly executors = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly lastTaskByActor = new Map<
    string,
    { ok: boolean; steps?: number; summary?: string; error?: string }
  >();
  private readonly lastSyncAt = new Map<string, string>();

  constructor(private readonly opts?: DesktopBridgeCoordinatorOptions) {}

  /** 是否开启「电脑桥接」能力（与是否已连接无关） */
  isBridgeFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (parseBooleanEnv(env.DESKTOP_BRIDGE_ENABLED)) return true;
    const t = env.DESKTOP_BRIDGE_TOKEN?.trim() ?? "";
    return t.length >= 8;
  }

  /** @deprecated 使用 {@link isBridgeFeatureEnabled} */
  isBridgeModeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return this.isBridgeFeatureEnabled(env);
  }

  /** 若服务端配置了 token，则电脑端须通过 register 提交相同 token */
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
        p.resolve({ ok: false, error: "桌面桥接连接已断开" });
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
        resolve({ ok: false, error: `电脑端执行超时（>${timeoutMs}ms）` });
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
        resolve({ ok: false, error: "向电脑端发送任务失败（连接异常）" });
      }
    });
  }

  completeFromSocket(socket: WsSendLike, jobId: string, payload: Record<string, unknown>): boolean {
    const p = this.pending.get(jobId);
    if (!p || p.socket !== socket) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    const ok = payload.ok === true;
    const steps = typeof payload.steps === "number" ? payload.steps : undefined;
    const summary = typeof payload.summary === "string" ? payload.summary : undefined;
    const error = typeof payload.error === "string" ? payload.error : undefined;
    const imageBase64 =
      typeof payload.imageBase64 === "string" ? payload.imageBase64 : undefined;
    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : undefined;
    const width = typeof payload.width === "number" ? payload.width : undefined;
    const height = typeof payload.height === "number" ? payload.height : undefined;
    const capturedAt = typeof payload.capturedAt === "string" ? payload.capturedAt : undefined;
    p.resolve({ ok, steps, summary, error, imageBase64, mimeType, width, height, capturedAt });
    return true;
  }
}
