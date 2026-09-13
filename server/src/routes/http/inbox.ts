import type { FastifyInstance } from "fastify";

import {
  inboxListQuerySchema,
  inboxReadBodySchema,
  inboxSendBodySchema,
} from "../../schemas/api.js";
import type { InboxImportance, InboxService } from "../../services/inbox-service.js";

/** 站内信（平台→用户收件箱）：
 * - POST /api/inbox/send          推送站内消息（单发/群发）；先落盘必达，在线设备 WS 实时提醒
 * - GET  /api/inbox/messages      拉取收件箱（含未读数；离线消息补齐入口）
 * - POST /api/inbox/read          批量置已读（ids 缺省 = 全部未读）
 * - GET  /api/inbox/unread-count  未读数（角标轮询） */
export function registerInboxRoutes(
  app: FastifyInstance,
  deps: { inboxService: InboxService },
): void {
  const { inboxService } = deps;

  app.post("/api/inbox/send", async (request, reply) => {
    const parsed = inboxSendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { userId, userIds, kind, importance, fromActorId, messageId, ...content } =
      parsed.data;
    const targets = userIds ?? (userId ? [userId] : []);
    if (targets.length === 0) {
      return reply.code(400).send({ ok: false, message: "missing userId or userIds" });
    }
    const results = [];
    for (const target of targets) {
      // 群发时调用方的幂等键按目标展开，避免互相吞并
      const targetMessageId =
        targets.length > 1 && messageId ? `${messageId}:${target}` : messageId;
      const sent = await inboxService.send({
        actorId: target,
        title: content.title,
        body: content.body,
        kind,
        importance: importance as InboxImportance | undefined,
        fromActorId,
        messageId: targetMessageId,
      });
      results.push({
        userId: target,
        messageId: sent.message.messageId,
        deliveredLive: sent.deliveredLive,
      });
    }
    return { ok: true, results };
  });

  app.get("/api/inbox/messages", async (request, reply) => {
    const parsed = inboxListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { userId, limit, unreadOnly } = parsed.data;
    const [messages, unreadCount] = await Promise.all([
      inboxService.list(userId, { limit, unreadOnly: unreadOnly === "1" || unreadOnly === "true" }),
      inboxService.unreadCount(userId),
    ]);
    return { ok: true, messages, unreadCount };
  });

  app.post("/api/inbox/read", async (request, reply) => {
    const parsed = inboxReadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { userId, ids } = parsed.data;
    return { ok: true, marked: await inboxService.markRead(userId, ids) };
  });

  app.get("/api/inbox/unread-count", async (request, reply) => {
    const parsed = inboxListQuerySchema.pick({ userId: true }).safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    return { ok: true, unreadCount: await inboxService.unreadCount(parsed.data.userId) };
  });
}
