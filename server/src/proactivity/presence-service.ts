// 在场判定：WS 连接 + 最近活跃 → active / idle / offline
// 供仲裁层择时（离线挂起、对话中不打断）与投递层选通道。away(锁屏)由客户端上报，后续接入。
import type { PresenceState } from "./pipeline-types.js";

export class PresenceService {
  /** 超过该时长无交互视为 idle */
  static readonly IDLE_AFTER_MS = 10 * 60 * 1000;

  /** actorId → 最近活跃时刻（仅记录在线用户） */
  private readonly connected = new Map<string, number>();

  markConnected(actorId: string, at = Date.now()): void {
    this.connected.set(actorId, at);
  }

  markDisconnected(actorId: string): void {
    this.connected.delete(actorId);
  }

  noteActivity(actorId: string, at = Date.now()): void {
    if (this.connected.has(actorId)) this.connected.set(actorId, at);
  }

  isOnline(actorId: string): boolean {
    return this.connected.has(actorId);
  }

  lastActivityAt(actorId: string): number | null {
    return this.connected.get(actorId) ?? null;
  }

  listOnline(): string[] {
    return [...this.connected.keys()];
  }

  getPresence(actorId: string, now = Date.now()): PresenceState {
    const last = this.connected.get(actorId);
    if (last === undefined) return "offline";
    return now - last <= PresenceService.IDLE_AFTER_MS ? "active" : "idle";
  }
}
