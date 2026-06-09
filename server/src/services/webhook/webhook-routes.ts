/**
 * Webhook HTTP 路由 — 端点管理 + 测试触发 API
 *
 * Routes:
 *   GET    /api/webhooks              查询所有已注册端点
 *   POST   /api/webhooks              注册新端点
 *   GET    /api/webhooks/:id          查询单个端点
 *   PATCH  /api/webhooks/:id          更新端点配置
 *   DELETE /api/webhooks/:id          删除端点
 *   POST   /api/webhooks/test         手动发送测试事件
 *   GET    /api/webhooks/events       查询最近事件历史
 *   GET    /api/webhooks/dispatches    查询最近调度结果
 *   GET    /api/webhooks/stats        查询统计信息
 */
import type { FastifyInstance } from "fastify";
import type { WebhookService } from "./webhook-service.js";
import type { WebhookEventType } from "./webhook-event-types.js";

/** 所有合法的事件类型（用于请求校验） */
const VALID_EVENT_TYPES: WebhookEventType[] = [
  "agent.online",
  "agent.offline",
  "agent.error",
  "agent.message_sent",
  "agent.message_received",
  "agent.task_started",
  "agent.task_completed",
  "agent.task_failed",
  "agent.tool_called",
  "schedule.reminder_fired",
  "life.signal",
  "custom",
];

export function registerWebhookRoutes(
  app: FastifyInstance,
  webhookService: WebhookService,
): void {
  // ─── 端点 CRUD ───

  /** 查询所有已注册端点 */
  app.get("/api/webhooks", (_req, reply) => {
    return reply.send({
      ok: true,
      endpoints: webhookService.getAllEndpoints(),
      enabled: webhookService.isEnabled(),
    });
  });

  /** 注册新端点 */
  app.post("/api/webhooks", async (req, reply) => {
    const body = req.body as {
      url?: string;
      events?: string[];
      secret?: string;
      description?: string;
    };

    if (!body.url) {
      return reply.status(400).send({ ok: false, error: "url is required" });
    }

    // 校验 URL 格式
    try {
      new URL(body.url);
    } catch {
      return reply.status(400).send({ ok: false, error: "invalid url format" });
    }

    // 校验事件类型
    const events = (body.events ?? []) as WebhookEventType[];
    for (const e of events) {
      if (!VALID_EVENT_TYPES.includes(e)) {
        return reply
          .status(400)
          .send({ ok: false, error: `invalid event type: ${e}` });
      }
    }

    const endpoint = webhookService.addEndpoint({
      url: body.url,
      events: events.length > 0 ? events : undefined,
      secret: body.secret,
      description: body.description,
    });

    return reply.status(201).send({ ok: true, endpoint });
  });

  /** 查询单个端点 */
  app.get<{ Params: { id: string } }>("/api/webhooks/:id", (req, reply) => {
    const endpoint = webhookService.getEndpoint(req.params.id);
    if (!endpoint) {
      return reply.status(404).send({ ok: false, error: "endpoint not found" });
    }
    return reply.send({ ok: true, endpoint });
  });

  /** 更新端点配置 */
  app.patch<{ Params: { id: string } }>(
    "/api/webhooks/:id",
    async (req, reply) => {
      const body = req.body as Partial<{
        url: string;
        events: string[];
        secret: string;
        enabled: boolean;
        description: string;
      }>;

      const patch: Parameters<
        WebhookService["updateEndpoint"]
      >[1] = {};

      if (body.url !== undefined) {
        try {
          new URL(body.url);
          patch.url = body.url;
        } catch {
          return reply
            .status(400)
            .send({ ok: false, error: "invalid url format" });
        }
      }
      if (body.events !== undefined) {
        for (const e of body.events) {
          if (!VALID_EVENT_TYPES.includes(e as WebhookEventType)) {
            return reply
              .status(400)
              .send({ ok: false, error: `invalid event type: ${e}` });
          }
        }
        patch.events = body.events as WebhookEventType[];
      }
      if (body.secret !== undefined) patch.secret = body.secret;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.description !== undefined) patch.description = body.description;

      const updated = webhookService.updateEndpoint(req.params.id, patch);
      if (!updated) {
        return reply
          .status(404)
          .send({ ok: false, error: "endpoint not found" });
      }
      return reply.send({ ok: true, endpoint: updated });
    },
  );

  /** 删除端点 */
  app.delete<{ Params: { id: string } }>(
    "/api/webhooks/:id",
    (req, reply) => {
      const removed = webhookService.removeEndpoint(req.params.id);
      if (!removed) {
        return reply
          .status(404)
          .send({ ok: false, error: "endpoint not found" });
      }
      return reply.send({ ok: true });
    },
  );

  // ─── 测试 & 查询 ───

  /** 手动发送测试事件 */
  app.post("/api/webhooks/test", async (req, reply) => {
    const body = req.body as {
      type?: string;
      data?: Record<string, unknown>;
    };
    const eventType = (body.type ?? "custom") as WebhookEventType;
    const testData = body.data ?? { message: "test event from webhook api" };

    const event = webhookService.emit(eventType, testData, {
      source: "api-test",
    });

    return reply.send({
      ok: true,
      event: {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
      },
      dispatchedTo: webhookService.getAllEndpoints().length,
    });
  });

  /** 查询最近事件历史 */
  app.get("/api/webhooks/events", (req) => {
    const q = req.query as { limit?: string; type?: string };
    const limit = Number(q.limit ?? 50);
    const typeFilter = q.type as WebhookEventType | undefined;

    return {
      ok: true,
      events: webhookService.getRecentEvents(
        Math.min(limit, 200),
        typeFilter,
      ),
    };
  });

  /** 查询最近调度结果 */
  app.get("/api/webhooks/dispatches", (req) => {
    const q = req.query as { limit?: string };
    const limit = Number(q.limit ?? 50);

    return {
      ok: true,
      dispatches: webhookService.getRecentDispatchResults(
        Math.min(limit, 200),
      ),
    };
  });

  /** 统计信息 */
  app.get("/api/webhooks/stats", (_req, reply) => {
    return reply.send({
      ok: true,
      ...webhookService.getDispatcherStats(),
      enabled: webhookService.isEnabled(),
      config: webhookService.getConfig(),
    });
  });
}
