import type { FastifyRequest } from "fastify";

import { resolveActorId } from "../agent/actor-id.js";
import { runChatTurnForActor } from "./chat-turn-runner.js";
import type { AgentCore } from "./agent-core.js";
import type { MessageHubPlatform, MessageHubService } from "./message-hub-service.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type UnifiedBridgeInboundBody = {
  platform: MessageHubPlatform;
  text: string;
  userId?: string;
  sessionId?: string;
  senderId?: string;
  senderName?: string;
  channelId?: string;
  channelName?: string;
  accountId?: string;
  messageId?: string;
  autoReply?: boolean;
};

export class MessageBridgeService {
  constructor(
    private readonly agentCore: AgentCore,
    private readonly hub: MessageHubService,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  isEnabled(): boolean {
    return parseBooleanEnv(this.env.MESSAGE_BRIDGE_ENABLED) || parseBooleanEnv(this.env.WECHAT_CLAW_BRIDGE_ENABLED);
  }

  assertAuthorized(request: FastifyRequest): void {
    const token =
      this.env.MESSAGE_BRIDGE_TOKEN?.trim() ||
      this.env.WECHAT_CLAW_BRIDGE_TOKEN?.trim() ||
      "";
    if (!token) return;
    const header =
      (typeof request.headers.authorization === "string"
        ? request.headers.authorization.replace(/^Bearer\s+/i, "").trim()
        : "") ||
      (typeof request.headers["x-message-bridge-token"] === "string"
        ? request.headers["x-message-bridge-token"].trim()
        : "");
    if (header !== token) {
      throw new Error("message bridge auth failed");
    }
  }

  async ingest(body: UnifiedBridgeInboundBody): Promise<{
    ok: true;
    actorId: string;
    conversationId: string;
    messageId: string;
    replyText?: string;
  } | { ok: false; message: string }> {
    if (!this.isEnabled()) {
      return { ok: false, message: "message bridge disabled" };
    }
    const text = body.text.trim();
    if (!text) return { ok: false, message: "message text is empty" };

    const actorId = resolveActorId({
      userId: body.userId,
      sessionId: body.sessionId?.trim() || this.env.MESSAGE_BRIDGE_DEFAULT_ACTOR_ID?.trim() || "session-mvp-001",
    });
    const channelId = body.channelId?.trim() || body.senderId?.trim() || body.accountId?.trim() || `${body.platform}-default`;
    const ingested = await this.hub.ingestInbound({
      actorId,
      platform: body.platform,
      channelId,
      text,
      participantId: body.senderId?.trim() || body.accountId?.trim(),
      participantName: body.senderName?.trim() || body.channelName?.trim() || body.platform,
      title: body.channelName?.trim() ? `${body.platform} · ${body.channelName!.trim()}` : body.platform,
      senderId: body.senderId?.trim(),
      senderName: body.senderName?.trim() || body.channelName?.trim(),
      externalMessageId: body.messageId,
      meta: { accountId: body.accountId, autoReply: body.autoReply === true },
    });

    if (body.autoReply !== true) {
      return {
        ok: true,
        actorId,
        conversationId: ingested.conversation.conversationId,
        messageId: ingested.message.messageId,
      };
    }

    const reply = await runChatTurnForActor(this.agentCore, actorId, {
      text,
      messageId: body.messageId,
      userId: body.userId ?? actorId,
      preferFullPipeline: true,
    });
    if (!reply.ok) {
      return { ok: false, message: reply.message };
    }
    return {
      ok: true,
      actorId,
      conversationId: ingested.conversation.conversationId,
      messageId: ingested.message.messageId,
      replyText: reply.finalText,
    };
  }
}
