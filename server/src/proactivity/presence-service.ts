// 在场判定：多端连接引用计数 + 最近活跃 → active / idle / offline
// 电脑端 + 手机端互通：任一设备在线即算在线（fan-out 由 WsConnectionRegistry 承担），
// 全部设备掉线才算 offline。away(锁屏)由客户端上报，后续接入。
import type { PresenceState } from "./pipeline-types.js";

export class PresenceService {
  /** 超过该时长无交互视为 idle */
  static readonly IDLE_AFTER_MS = 10 * 60 * 1000;

  /** actorId → 在线设备数（引用计数：任一设备在线即在线） */
  private readonly deviceCount = new Map<string, number>();

  /** actorId → 最近活跃时刻（任一设备的交互都刷新） */
  private readonly lastActivity = new Map<string, number>();

  markConnected(actorId: string, at = Date.now()): void {
    this.deviceCount.set(actorId, (this.deviceCount.get(actorId) ?? 0) + 1);
    this.lastActivity.set(actorId, at);
  }

  markDisconnected(actorId: string): void {
    const n = this.deviceCount.get(actorId) ?? 0;
    if (n <= 1) this.deviceCount.delete(actorId);
    else this.deviceCount.set(actorId, n - 1);
  }

  noteActivity(actorId: string, at = Date.now()): void {
    if (this.deviceCount.has(actorId)) this.lastActivity.set(actorId, at);
  }

  isOnline(actorId: string): boolean {
    return (this.deviceCount.get(actorId) ?? 0) > 0;
  }

  lastActivityAt(actorId: string): number | null {
    return this.lastActivity.get(actorId) ?? null;
  }

  listOnline(): string[] {
    return [...this.deviceCount.keys()];
  }

  getPresence(actorId: string, now = Date.now()): PresenceState {
    if (!this.isOnline(actorId)) return "offline";
    const last = this.lastActivity.get(actorId);
    return last !== undefined && now - last <= PresenceService.IDLE_AFTER_MS ? "active" : "idle";
  }
}
