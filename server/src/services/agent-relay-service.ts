/** 可选：AIP v0.1 结构化载荷（与 text 并存，便于跨厂商 Agent 解析）。 */
export type RelayMessageRecord = {
  messageId: string;
  fromSessionId: string;
  toSessionId: string;
  text: string;
  subject?: string;
  createdAt: string;
  traceId?: string;
  /** 发送方主会话中触发投递的用户消息 ID（`chat.user_message.messageId`），供服务端关联，非终端展示字段 */
  chatUserMessageId?: string;
  aip?: {
    aipVersion: string;
    kind: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    proposalId?: string;
  };
};

export class AgentRelayService {
  private readonly inboxBySession = new Map<string, RelayMessageRecord[]>();

  postMessage(params: {
    fromSessionId: string;
    toSessionId: string;
    text: string;
    subject?: string;
    traceId?: string;
    messageId?: string;
    chatUserMessageId?: string;
    aip?: RelayMessageRecord["aip"];
  }): RelayMessageRecord {
    const messageId =
      params.messageId ?? `relay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = new Date().toISOString();
    const record: RelayMessageRecord = {
      messageId,
      fromSessionId: params.fromSessionId,
      toSessionId: params.toSessionId,
      text: params.text,
      subject: params.subject,
      createdAt,
      traceId: params.traceId,
      chatUserMessageId: params.chatUserMessageId,
      aip: params.aip,
    };
    const bucket = this.inboxBySession.get(params.toSessionId) ?? [];
    bucket.push(record);
    this.inboxBySession.set(params.toSessionId, bucket);
    return record;
  }

  listInbox(sessionId: string, limit = 50): RelayMessageRecord[] {
    const bucket = this.inboxBySession.get(sessionId) ?? [];
    return bucket.slice(-limit);
  }
}
