// 统一投递出口：所有主动内容的唯一出站点（替换散落的 trySend/sendToUser 直调）。
// 通道序：在线 WS 直投 → 失败（离线）落 MessageHub（离线必达，重连可读）。
// 每条投递带 deliveryId，客户端回传 outcome 反馈。
import type { DeliveryChannel, ProactiveProposal } from "./pipeline-types.js";

export type OfflineStoreLike = {
  createOutbound(input: {
    actorId: string;
    platform: "generic";
    channelId: string;
    text: string;
    title?: string;
    meta?: Record<string, unknown>;
  }): Promise<unknown>;
};

export type DeliveredMessage = {
  deliveryId: string;
  channel: DeliveryChannel;
};

export type DeliveryDeps = {
  trySend: (actorId: string, json: string) => boolean;
  offlineStore?: OfflineStoreLike;
  onDelivered?: (info: { deliveryId: string; channel: DeliveryChannel; proposal: ProactiveProposal }) => void;
};

export class ProactiveDeliveryService {
  private seq = 0;

  constructor(private readonly deps: DeliveryDeps) {}

  deliver(p: ProactiveProposal, text: string, title: string): DeliveredMessage {
    const deliveryId = `d_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const payload = {
      type: "agent.proactive_message",
      payload: {
        deliveryId,
        title,
        text,
        importance: p.importance,
        kind: p.kind,
        proposalId: p.proposalId,
        source: p.source,
      },
    };
    if (this.deps.trySend(p.actorId, JSON.stringify(payload))) {
      this.deps.onDelivered?.({ deliveryId, channel: "in_app", proposal: p });
      return { deliveryId, channel: "in_app" };
    }
    // 离线兜底：MessageHub 落库（人不在电脑前也必达，重连后可读）
    void this.deps.offlineStore
      ?.createOutbound({
        actorId: p.actorId,
        platform: "generic",
        channelId: "proactive",
        text,
        title,
        meta: { deliveryId, kind: p.kind, importance: p.importance, source: p.source },
      })
      .catch(() => {});
    this.deps.onDelivered?.({ deliveryId, channel: "offline_store", proposal: p });
    return { deliveryId, channel: "offline_store" };
  }
}
