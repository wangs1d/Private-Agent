import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { resolveActorId } from "../../agent/actor-id.js";
import type { MessagePlatformGateway } from "../../services/message-platform-gateway.js";
import { runChatTurnForActor } from "../../services/chat-turn-runner.js";
import type { RuntimeFacade } from "../../runtime/runtime-facade.js";
import type { MessageHubService } from "../../services/message-hub-service.js";

const actorQuerySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  platform: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const conversationQuerySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const markReadBodySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
});

const sendBodySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  text: z.string().min(1).max(4000),
  replyToMessageId: z.string().optional(),
});

const suggestReplyBodySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  style: z.string().max(500).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

function actorFrom(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

export function registerMessageHubRoutes(
  app: FastifyInstance,
  deps: {
    messageHubService: MessageHubService;
    messagePlatformGateway: MessagePlatformGateway;
    runtime: RuntimeFacade;
  },
): void {
  app.get("/messages/conversations", async (request, reply) => {
    const parsed = actorQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const actorId = actorFrom(parsed.data);
    if (!actorId) return reply.code(400).send({ ok: false, message: "missing userId or sessionId" });
    return {
      ok: true,
      conversations: deps.messageHubService.listConversations(actorId, {
        platform: parsed.data.platform,
        limit: parsed.data.limit,
      }),
    };
  });

  app.get<{ Params: { conversationId: string } }>("/messages/conversations/:conversationId", async (request, reply) => {
    const parsed = conversationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const actorId = actorFrom(parsed.data);
    const conversationId = String(request.params.conversationId ?? "").trim();
    if (!actorId || !conversationId) return reply.code(400).send({ ok: false, message: "missing actor or conversationId" });
    const conversation = deps.messageHubService.getConversation(actorId, conversationId);
    if (!conversation) return reply.code(404).send({ ok: false, message: "conversation not found" });
    return {
      ok: true,
      conversation,
      messages: deps.messageHubService.listMessages(actorId, conversationId, { limit: parsed.data.limit }),
    };
  });

  app.post<{ Params: { conversationId: string } }>("/messages/conversations/:conversationId/read", async (request, reply) => {
    const parsed = markReadBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const actorId = actorFrom(parsed.data);
    const conversationId = String(request.params.conversationId ?? "").trim();
    if (!actorId || !conversationId) return reply.code(400).send({ ok: false, message: "missing actor or conversationId" });
    const ok = await deps.messageHubService.markConversationRead(actorId, conversationId);
    if (!ok) return reply.code(404).send({ ok: false, message: "conversation not found" });
    return { ok: true };
  });

  app.post<{ Params: { conversationId: string } }>("/messages/conversations/:conversationId/send", async (request, reply) => {
    const parsed = sendBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const actorId = actorFrom(parsed.data);
    const conversationId = String(request.params.conversationId ?? "").trim();
    if (!actorId || !conversationId) return reply.code(400).send({ ok: false, message: "missing actor or conversationId" });
    const conversation = deps.messageHubService.getConversation(actorId, conversationId);
    if (!conversation) return reply.code(404).send({ ok: false, message: "conversation not found" });
    const sendResult = await deps.messagePlatformGateway.send({
      actorId,
      platform: conversation.platform,
      channelId: conversation.channelId,
      text: parsed.data.text,
      conversationId,
      replyToMessageId: parsed.data.replyToMessageId,
    });
    const created = await deps.messageHubService.createOutbound({
      actorId,
      platform: conversation.platform,
      channelId: conversation.channelId,
      text: parsed.data.text,
      participantId: conversation.participantId,
      participantName: conversation.participantName,
      title: conversation.title,
      replyToMessageId: parsed.data.replyToMessageId,
      externalMessageId: sendResult.externalMessageId,
      meta: { delivered: sendResult.delivered === true, platformMessage: sendResult.message ?? "" },
    });
    return { ok: true, delivered: sendResult.delivered === true, message: created.message, conversation: created.conversation };
  });

  app.post<{ Params: { conversationId: string } }>("/messages/conversations/:conversationId/suggest-reply", async (request, reply) => {
    const parsed = suggestReplyBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const actorId = actorFrom(parsed.data);
    const conversationId = String(request.params.conversationId ?? "").trim();
    if (!actorId || !conversationId) return reply.code(400).send({ ok: false, message: "missing actor or conversationId" });
    const conversation = deps.messageHubService.getConversation(actorId, conversationId);
    if (!conversation) return reply.code(404).send({ ok: false, message: "conversation not found" });
    const messages = deps.messageHubService.listMessages(actorId, conversationId, { limit: parsed.data.limit ?? 20 });
    const transcript = messages
      .map((m) => `${m.direction === "outbound" ? "我" : (m.senderName || m.senderId || "对方")}: ${m.text}`)
      .join("\n");
    const style = parsed.data.style?.trim() ? `回复风格要求：${parsed.data.style!.trim()}\n` : "";
    const prompt = `请基于以下聊天记录，生成一条适合直接发送的简短中文回复。只输出回复正文，不要解释，不要加引号。\n${style}聊天记录：\n${transcript}`;
    const result = await runChatTurnForActor(deps.runtime, actorId, {
      text: prompt,
      userId: parsed.data.userId ?? actorId,
      preferFullPipeline: true,
    });
    if (!result.ok) return reply.code(422).send(result);
    return { ok: true, suggestedReply: result.finalText.trim(), conversation };
  });
}
