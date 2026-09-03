import type { FastifyInstance } from "fastify";

import { getAgentMailInboundSecret } from "../../config/mail.js";
import {
  financeIngestBindBodySchema,
  financeIngestInboundBodySchema,
  financeIngestSetupQuerySchema,
} from "../../schemas/api.js";
import type { FinanceIngestService } from "../../services/finance-ingest-service.js";
import { resolveActorId } from "../../agent/actor-id.js";

/**
 * 财务入站子域：账单邮件自动记账 + 傻瓜式接入引导。
 *
 *   - POST   /finance/ingest/email/inbound  邮件网关回调（账单邮件 → 自动记账）
 *   - GET    /finance/ingest/setup          接入状态 + 个性化三步引导（客户端引导卡数据源）
 *   - POST   /finance/ingest/bind           绑定/解绑账单邮箱（action 缺省 bind）
 *
 * bind/setup 端点供客户端设置页或对话快捷指示调用；未装配服务时返回 503。
 */
export function registerFinanceIngestRoutes(
  app: FastifyInstance,
  deps: { financeIngestService?: FinanceIngestService },
): void {
  const { financeIngestService } = deps;

  /**
   * 真实收信：邮件网关（Mailgun / Cloudflare Email Routing / 自建 MTA 等）将
   * 解析后的账单邮件 POST 到此。密钥与邮箱注册 inbound 共用：
   * 设置 AGENT_MAIL_INBOUND_SECRET 时须携带 X-Agent-Mail-Secret。
   */
  app.post("/finance/ingest/email/inbound", async (request, reply) => {
    if (!financeIngestService) {
      return reply.code(503).send({ ok: false, message: "财务入站记账未启用" });
    }
    const secret = getAgentMailInboundSecret();
    if (secret) {
      const got = String(request.headers["x-agent-mail-secret"] ?? "");
      if (got !== secret) {
        return reply.code(401).send({ ok: false, message: "缺少或错误的 X-Agent-Mail-Secret" });
      }
    }
    const parsed = financeIngestInboundBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = await financeIngestService.applyInboundEmail(parsed.data);
    if (!result.matched) {
      return reply.code(404).send({ ok: false, ...result });
    }
    return { ok: true, ...result };
  });

  /** 接入状态 + 个性化三步引导（ready=true 时 guide 为使用说明）。 */
  app.get("/finance/ingest/setup", async (request, reply) => {
    if (!financeIngestService) {
      return reply.code(503).send({ ok: false, message: "财务入站记账未启用" });
    }
    const parsed = financeIngestSetupQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId ?? "",
    });
    const [status, guide] = await Promise.all([
      financeIngestService.getSetupStatus(actorId),
      financeIngestService.buildSetupGuide(actorId),
    ]);
    return { ok: true, actorId, status, guide: guide.guide, ready: guide.ready };
  });

  /** 绑定/解绑账单邮箱（action 缺省 bind）。 */
  app.post("/finance/ingest/bind", async (request, reply) => {
    if (!financeIngestService) {
      return reply.code(503).send({ ok: false, message: "财务入站记账未启用" });
    }
    const parsed = financeIngestBindBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId ?? "",
    });
    const result =
      parsed.data.action === "unbind"
        ? await financeIngestService.unbindMailbox(actorId)
        : await financeIngestService.bindMailbox(actorId, parsed.data.email);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.message });
    }
    const { guide, ready } = await financeIngestService.buildSetupGuide(actorId);
    return { ok: true, actorId, message: result.message, ready, nextGuide: guide };
  });
}
