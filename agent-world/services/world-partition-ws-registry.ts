/**
 * AWP：世界分区 WebSocket 订阅表 + 跨 session 观察策略（与主 server / standalone 共用）。
 */

/** 与 `AgentPairingService` duck-type 兼容。 */
export type PartitionPairingLike = {
  arePaired(a: string, b: string): boolean;
};

/**
 * 能否订阅某房间：观察者即拥有者，或与 `ownerSessionId` 在同一配对组。
 */
export function canViewWorldPartition(
  viewerSessionId: string,
  ownerSessionId: string,
  pairing: PartitionPairingLike,
): boolean {
  if (!viewerSessionId || !ownerSessionId) return false;
  if (viewerSessionId === ownerSessionId) return true;
  return pairing.arePaired(viewerSessionId, ownerSessionId);
}

/** Fastify `connection.socket` 等满足即可。 */
export type WsSendLike = {
  send(data: string): void;
  readonly readyState: number;
};

const WS_OPEN = 1;

/**
 * 谁订阅了哪个世界分区，用于 `world.partition.*` 推送与 presence。
 */
export class WorldPartitionWsRegistry {
  private readonly byPartition = new Map<string, Set<WsSendLike>>();
  private readonly socketMeta = new Map<WsSendLike, { partitionId: string; sessionId: string }>();

  attach(partitionId: string, watcherSessionId: string, socket: WsSendLike): void {
    this.detachSocket(socket);
    let set = this.byPartition.get(partitionId);
    if (!set) {
      set = new Set();
      this.byPartition.set(partitionId, set);
    }
    set.add(socket);
    this.socketMeta.set(socket, { partitionId, sessionId: watcherSessionId });
  }

  detachSocket(socket: WsSendLike): { partitionId: string } | undefined {
    const meta = this.socketMeta.get(socket);
    if (!meta) return undefined;
    this.socketMeta.delete(socket);
    const set = this.byPartition.get(meta.partitionId);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.byPartition.delete(meta.partitionId);
    }
    return { partitionId: meta.partitionId };
  }

  getPartitionForSocket(socket: WsSendLike): string | undefined {
    return this.socketMeta.get(socket)?.partitionId;
  }

  uniqueWatcherSessionIds(partitionId: string): string[] {
    const set = this.byPartition.get(partitionId);
    if (!set) return [];
    const ids = new Set<string>();
    for (const ws of set) {
      const sid = this.socketMeta.get(ws)?.sessionId;
      if (sid) ids.add(sid);
    }
    return [...ids];
  }

  broadcastToPartition(partitionId: string, data: string): void {
    const set = this.byPartition.get(partitionId);
    if (!set) return;
    for (const ws of set) {
      if (ws.readyState === WS_OPEN) ws.send(data);
    }
  }
}
