/**
 * 位置协调器：服务端「按需」向客户端请求实时位置。
 *
 * 与 DesktopBridgeCoordinator 的 invoke/pending/complete 模式一致：
 *  - Agent 需要位置时（如 weather.get_local 工具执行）调用 `requestLocation`，
 *    服务端通过 WS 下发 `agent.location_request`（携带 jobId），等待客户端回包。
 *  - 客户端收到后拉取 GPS 并回传 `client.location_report`，
 *    服务端 resolve 挂起的 Promise 并写入 actor 级缓存。
 *  - 天气面板等客户端主动上报（无 jobId）时只写缓存，供后续 prompt/工具复用。
 *
 * 不主动请求：普通聊天消息不再附带位置，位置只在 Agent 真正需要时才产生一次 GPS 开销。
 */
import { randomUUID } from "node:crypto";

import { ServerEventType } from "../protocol.js";
import { parseClientLocation, type ClientLocationWire } from "../types/client-location.js";

export type WsSendLike = {
  send(data: string): void;
  readyState?: number;
};

type PendingRequest = {
  resolve: (loc: ClientLocationWire | null) => void;
  timer: NodeJS.Timeout;
  socket: WsSendLike;
};

type CachedLocation = {
  payload: ClientLocationWire;
  at: number;
};

export class LocationCoordinator {
  private readonly sockets = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cache = new Map<string, CachedLocation>();

  /** 缓存新鲜度：此窗口内的位置直接复用，不重复请求客户端。 */
  private readonly cacheTtlMs: number;
  /** 请求客户端回包的最大等待时间，超时返回 null（工具可回退到 city 参数）。 */
  private readonly requestTimeoutMs: number;

  constructor(opts?: { cacheTtlMs?: number; requestTimeoutMs?: number }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 6_000;
  }

  hasSocket(actorId: string): boolean {
    const s = this.sockets.get(actorId);
    if (!s) return false;
    return s.readyState === undefined || s.readyState === 1;
  }

  bindSocket(actorId: string, socket: WsSendLike): void {
    this.sockets.set(actorId, socket);
  }

  unbindSocket(socket: WsSendLike): void {
    const removed: string[] = [];
    for (const [actorId, s] of this.sockets) {
      if (s === socket) {
        this.sockets.delete(actorId);
        removed.push(actorId);
      }
    }
    // 该连接挂起的请求全部按失败处理，避免 Promise 悬空。
    for (const [jobId, p] of this.pending) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        this.pending.delete(jobId);
        p.resolve(null);
      }
    }
  }

  /** 读缓存（不考虑新鲜度），供 prompt 注入等只读场景。 */
  getCached(actorId: string): ClientLocationWire | null {
    const hit = this.cache.get(actorId);
    if (!hit) return null;
    return hit.payload;
  }

  /** 读新鲜缓存：窗口期内返回，否则返回 null。 */
  getFreshCached(actorId: string): ClientLocationWire | null {
    const hit = this.cache.get(actorId);
    if (!hit) return null;
    if (Date.now() - hit.at > this.cacheTtlMs) return null;
    return hit.payload;
  }

  /**
   * 按需请求实时位置。优先复用新鲜缓存；缓存过期或缺失时向客户端下发
   * `agent.location_request` 并等待回包，超时返回 null。
   */
  requestLocation(actorId: string, reason?: string): Promise<ClientLocationWire | null> {
    const fresh = this.getFreshCached(actorId);
    if (fresh) return Promise.resolve(fresh);

    const socket = this.sockets.get(actorId);
    if (!socket || !this.hasSocket(actorId)) return Promise.resolve(null);

    const jobId = randomUUID();
    return new Promise<ClientLocationWire | null>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(jobId)) return;
        this.pending.delete(jobId);
        resolve(null);
      }, this.requestTimeoutMs);
      this.pending.set(jobId, { socket, timer, resolve });
      try {
        socket.send(
          JSON.stringify({
            type: ServerEventType.LocationRequest,
            payload: { jobId, ...(reason ? { reason } : {}) },
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(jobId);
        resolve(null);
      }
    });
  }

  /**
   * 处理客户端 `client.location_report`：
   *  - 携带 jobId：resolve 对应挂起请求（须校验 socket 归属）
   *  - 无 jobId：仅写缓存（天气面板等主动上报）
   * 返回 true 表示已消费。
   */
  completeFromSocket(
    socket: WsSendLike,
    actorId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const loc = parseClientLocation(payload);
    if (loc) {
      this.cache.set(actorId, { payload: loc, at: Date.now() });
    }
    const jobId = String(payload.jobId ?? "").trim();
    if (!jobId) return true; // 纯上报：已写缓存
    const p = this.pending.get(jobId);
    if (!p || p.socket !== socket) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    p.resolve(loc ?? null);
    return true;
  }
}
