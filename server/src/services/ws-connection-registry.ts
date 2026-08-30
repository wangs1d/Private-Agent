/**
 * 每个 sessionId 保留全部活跃连接（电脑端 + 手机端互通：多设备同时在线 fan-out，
 * 任一设备可收；全部掉线才算离线。旧语义"后连覆盖"会导致另一端永远收不到）。
 */
export type WsLike = {
  send(data: string): void;
  readyState?: number;
};

export class WsConnectionRegistry {
  private readonly connections = new Map<string, Set<WsLike>>();

  /** 连接变化回调（PresenceService 在场感知接线；首连接 true / 末断开 false，fire-and-forget） */
  onConnectionChange?: (actorId: string, connected: boolean) => void;

  register(sessionId: string, socket: WsLike): void {
    let set = this.connections.get(sessionId);
    if (!set) {
      set = new Set();
      this.connections.set(sessionId, set);
    }
    set.add(socket);
    if (set.size === 1) {
      try {
        this.onConnectionChange?.(sessionId, true);
      } catch {
        /* 回调失败不影响连接登记 */
      }
    }
  }

  /**
   * 移除指定 socket（多设备下各 socket 独立登记，旧连接 close 只摘除自己，
   * 不会误删另一端的新连接）。末个连接移除后标记离线。
   */
  unregister(sessionId: string, socket: WsLike): void {
    const set = this.connections.get(sessionId);
    if (!set || !set.delete(socket)) return;
    if (set.size === 0) {
      this.connections.delete(sessionId);
      try {
        this.onConnectionChange?.(sessionId, false);
      } catch {
        /* 回调失败不影响连接清理 */
      }
    }
  }

  get(sessionId: string): WsLike | undefined {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0) return undefined;
    return [...set][set.size - 1];
  }

  isOnline(sessionId: string): boolean {
    const set = this.connections.get(sessionId);
    return !!set && set.size > 0;
  }

  /** 向该 actor 的全部在线设备投递（电脑端 + 手机端都收到），任一成功即算送达 */
  trySend(sessionId: string, data: string): boolean {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0) return false;
    let delivered = false;
    for (const socket of [...set]) {
      const open = socket.readyState === undefined || socket.readyState === 1;
      if (!open) {
        this.dropSocket(sessionId, socket);
        continue;
      }
      try {
        socket.send(data);
        delivered = true;
      } catch {
        this.dropSocket(sessionId, socket);
      }
    }
    return delivered;
  }

  /** 静默清理死连接（无 close 事件时 trySend 兜底），末个移除同样标记离线 */
  private dropSocket(sessionId: string, socket: WsLike): void {
    const set = this.connections.get(sessionId);
    if (!set?.delete(socket)) return;
    if (set.size === 0) {
      this.connections.delete(sessionId);
      try {
        this.onConnectionChange?.(sessionId, false);
      } catch {
        /* 回调失败不影响连接清理 */
      }
    }
  }
}
