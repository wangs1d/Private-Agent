/**
 * 每个 sessionId 保留最近一次 WebSocket 连接（多设备场景下后连覆盖）。
 */
export type WsLike = {
  send(data: string): void;
  readyState?: number;
};

export class WsConnectionRegistry {
  private readonly connections = new Map<string, WsLike>();

  register(sessionId: string, socket: WsLike): void {
    this.connections.set(sessionId, socket);
  }

  /**
   * 仅当当前注册的 socket 与传入的一致时移除，避免旧连接 close 误删新连接。
   */
  unregister(sessionId: string, socket: WsLike): void {
    if (this.connections.get(sessionId) !== socket) return;
    this.connections.delete(sessionId);
  }

  get(sessionId: string): WsLike | undefined {
    return this.connections.get(sessionId);
  }

  trySend(sessionId: string, data: string): boolean {
    const socket = this.connections.get(sessionId);
    if (!socket) return false;
    const open = socket.readyState === undefined || socket.readyState === 1;
    if (!open) {
      this.connections.delete(sessionId);
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch {
      if (this.connections.get(sessionId) === socket) {
        this.connections.delete(sessionId);
      }
      return false;
    }
  }
}
