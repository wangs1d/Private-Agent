import { resolveActorId } from "../agent/actor-id.js";
import type { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import type { MessageHubService } from "../services/message-hub-service.js";
import { runChatTurnForActor } from "../services/chat-turn-runner.js";
import type { AgentCore } from "../services/agent-core.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

export function registerMessageHubTools(
  registry: ToolRegistry,
  deps: { hub: MessageHubService; gateway: MessagePlatformGateway; agentCore: AgentCore },
): void {
  registry.register("messages.list_conversations", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    return {
      ok: true,
      conversations: deps.hub.listConversations(actorId, {
        platform: typeof params.platform === "string" ? params.platform : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      }),
    };
  });

  registry.register("messages.read_conversation", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    const conversation = deps.hub.getConversation(actorId, conversationId);
    if (!conversation) return { ok: false, error: "conversation not found" };
    return {
      ok: true,
      conversation,
      messages: deps.hub.listMessages(actorId, conversationId, {
        limit: typeof params.limit === "number" ? params.limit : undefined,
      }),
    };
  });

  registry.register("messages.reply", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    const text = String(params.text ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    if (!text) return { ok: false, error: "missing text" };
    const conversation = deps.hub.getConversation(actorId, conversationId);
    if (!conversation) return { ok: false, error: "conversation not found" };
    const sendResult = await deps.gateway.send({
      actorId,
      platform: conversation.platform,
      channelId: conversation.channelId,
      text,
      conversationId,
      replyToMessageId: typeof params.replyToMessageId === "string" ? params.replyToMessageId : undefined,
    });
    const created = await deps.hub.createOutbound({
      actorId,
      platform: conversation.platform,
      channelId: conversation.channelId,
      text,
      participantId: conversation.participantId,
      participantName: conversation.participantName,
      title: conversation.title,
      replyToMessageId: typeof params.replyToMessageId === "string" ? params.replyToMessageId : undefined,
      externalMessageId: sendResult.externalMessageId,
      meta: { delivered: sendResult.delivered === true, platformMessage: sendResult.message ?? "" },
    });
    return { ok: true, delivered: sendResult.delivered === true, conversation: created.conversation, message: created.message };
  });

  registry.register("messages.mark_read", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    const ok = await deps.hub.markConversationRead(actorId, conversationId);
    return ok ? { ok: true } : { ok: false, error: "conversation not found" };
  });

  registry.register("messages.suggest_reply", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    const conversation = deps.hub.getConversation(actorId, conversationId);
    if (!conversation) return { ok: false, error: "conversation not found" };
    const messages = deps.hub.listMessages(actorId, conversationId, {
      limit: typeof params.limit === "number" ? params.limit : 20,
    });
    const transcript = messages
      .map((m) => `${m.direction === "outbound" ? "我" : (m.senderName || m.senderId || "对方")}: ${m.text}`)
      .join("\n");
    const style = typeof params.style === "string" && params.style.trim()
      ? `回复风格要求：${params.style.trim()}\n`
      : "";
    const prompt =
      `请基于以下聊天记录，生成一条适合直接发送的简短中文回复。` +
      `只输出回复正文，不要解释，不要加引号。\n${style}聊天记录：\n${transcript}`;
    const result = await runChatTurnForActor(deps.agentCore, actorId, {
      text: prompt,
      userId: ctx.userId ?? actorId,
      preferFullPipeline: true,
      agentAccessMode: ctx.agentAccessMode,
      clientLocation: ctx.clientLocation,
    });
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      conversation,
      suggestedReply: result.finalText.trim(),
    };
  });
}
