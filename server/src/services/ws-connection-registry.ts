/**
 * 每个 sessionId 保留全部活跃连接（电脑端 + 手机端互通：多设备同时在线 fan-out，
 * 任一设备可收；全部掉线才算离线。旧语义"后连覆盖"会导致另一端永远收不到）。
 *
 * 设备类别（2026-09-18）：客户端在 session.init 自报 platform，归一为 desktop | mobile
 * 后随连接登记。critical 升级链据此做设备分级触达：
 *   - 两端都在线 → 全端 fan-out（现状不变）
 *   - 仅一端在线 → WS 事件仍 fan-out（另一端不在线收不到是自然语义）
 *   - 全部离线   → 升级链跳过"假装弹窗"，直达 手机推送 → 短信 → 微信 的离线必达通道
 */
export type DeviceClass = "desktop" | "mobile";

export type WsLike = {
  send(data: string): void;
  readyState?: number;
};

/** session.init 自报的 platform/deviceClass 归一：手机系 → mobile，其余（含缺省）→ desktop。
 * 缺省归 desktop 是向后兼容：旧客户端（未带 platform）语义不变。 */
export function normalizeDeviceClass(raw: unknown): DeviceClass {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["mobile", "android", "ios", "phone"].includes(s)) return "mobile";
  return "desktop";
}

interface SocketEntry {
  socket: WsLike;
  deviceClass: DeviceClass;
}

export class WsConnectionRegistry {
  private readonly connections = new Map<string, Set<SocketEntry>>();

  /** 连接变化回调（PresenceService 在场感知接线；首连接 true / 末断开 false，fire-and-forget） */
  onConnectionChange?: (actorId: string, connected: boolean) => void;

  register(sessionId: string, socket: WsLike, meta?: { deviceClass?: DeviceClass }): void {
    let set = this.connections.get(sessionId);
    if (!set) {
      set = new Set();
      this.connections.set(sessionId, set);
    }
    set.add({ socket, deviceClass: meta?.deviceClass ?? "desktop" });
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
    if (!set) return;
    const entry = [...set].find((e) => e.socket === socket);
    if (!entry || !set.delete(entry)) return;
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
    return [...set][set.size - 1].socket;
  }

  isOnline(sessionId: string): boolean {
    const set = this.connections.get(sessionId);
    return !!set && set.size > 0;
  }

  /** 该 actor 是否有指定类别的在线设备（升级链设备分级路由用） */
  hasDeviceClass(sessionId: string, deviceClass: DeviceClass): boolean {
    const set = this.connections.get(sessionId);
    if (!set) return false;
    for (const entry of set) {
      const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
      if (open && entry.deviceClass === deviceClass) return true;
    }
    return false;
  }

  /** 在线设备类别清单（诊断/状态接口用） */
  getOnlineDeviceClasses(sessionId: string): DeviceClass[] {
    const set = this.connections.get(sessionId);
    if (!set) return [];
    const classes = new Set<DeviceClass>();
    for (const entry of set) {
      const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
      if (open) classes.add(entry.deviceClass);
    }
    return [...classes];
  }

  /** 向该 actor 的全部在线设备投递（电脑端 + 手机端都收到），任一成功即算送达 */
  trySend(sessionId: string, data: string): boolean {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0) return false;
    let delivered = false;
    for (const entry of [...set]) {
      delivered = this.trySendEntry(sessionId, entry, data) || delivered;
    }
    return delivered;
  }

  /** 仅向指定类别的在线设备投递（升级链按设备分级触达用），任一成功即算送达 */
  trySendToDeviceClasses(sessionId: string, data: string, deviceClasses: DeviceClass[]): boolean {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0 || deviceClasses.length === 0) return false;
    let delivered = false;
    for (const entry of [...set]) {
      if (!deviceClasses.includes(entry.deviceClass)) continue;
      delivered = this.trySendEntry(sessionId, entry, data) || delivered;
    }
    return delivered;
  }

  private trySendEntry(sessionId: string, entry: SocketEntry, data: string): boolean {
    const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
    if (!open) {
      this.dropSocket(sessionId, entry.socket);
      return false;
    }
    try {
      entry.socket.send(data);
      return true;
    } catch {
      this.dropSocket(sessionId, entry.socket);
      return false;
    }
  }

  /** 静默清理死连接（无 close 事件时 trySend 兜底），末个移除同样标记离线 */
  private dropSocket(sessionId: string, socket: WsLike): void {
    const set = this.connections.get(sessionId);
    if (!set) return;
    const entry = [...set].find((e) => e.socket === socket);
    if (!entry || !set.delete(entry)) return;
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
