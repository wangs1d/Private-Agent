import type { FastifyInstance } from "fastify";

import { getAgentMailInboundSecret } from "../../config/mail.js";
import {
  accountEmailInboundBodySchema,
  accountEmailRegisterPendingQuerySchema,
  accountEmailRegisterStartBodySchema,
  accountEmailRegisterVerifyBodySchema,
  accountMeQuerySchema,
  accountRegisterBodySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";
import { resolveActorId } from "../../agent/actor-id.js";

function accountActorFromBody(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

/**
 * 账号子域：Agent 账号与 **登录主体**（`userId` 优先，否则 `sessionId`）绑定。
 */
export function registerAccountRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { agentAccountService, emailRegistrationService } = deps;

  app.post("/accounts/register", async (request, reply) => {
    const parsed = accountRegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { displayName } = parsed.data;
    const actorId = accountActorFromBody(parsed.data);
    try {
      const account = await agentAccountService.register(actorId, displayName);
      await agentAccountService.markSetupComplete(actorId);
      return { ok: true, account };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /**
   * 邮箱验证码注册 — 步骤 1：分配占位邮箱并生成验证码（不落真实 SMTP）。
   */
  app.post("/accounts/register/email/start", async (request, reply) => {
    const parsed = accountEmailRegisterStartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { displayName } = parsed.data;
    const actorId = accountActorFromBody(parsed.data);
    if (agentAccountService.getByActorId(actorId)) {
      return reply.code(400).send({ ok: false, message: "该用户已存在 Agent 账号" });
    }
    try {
      const pending = await emailRegistrationService.start(actorId, displayName);
      return {
        ok: true,
        mailDomain: emailRegistrationService.getDomain(),
        email: pending.email,
        expiresAt: pending.expiresAt,
        hint:
          "本服务生成的验证码：GET /accounts/register/email/pending 。真实邮件：将网关指向 POST /accounts/register/email/inbound 。",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /**
   * 邮箱验证码注册 — 步骤 2：Agent 拉取待验证邮件（含验证码）。
   */
  app.get("/accounts/register/email/pending", async (request, reply) => {
    const parsed = accountEmailRegisterPendingQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = accountActorFromBody(parsed.data);
    const p = emailRegistrationService.getPending(actorId);
    if (!p) {
      return { ok: true, pending: null };
    }
    return {
      ok: true,
      pending: {
        displayName: p.displayName,
        email: p.email,
        code: p.code,
        inboundCodes: p.inboundCodes,
        expiresAt: p.expiresAt,
      },
    };
  });

  /**
   * 真实收信：邮件网关（Mailgun / Cloudflare Email Routing / 自建 MTA 等）将解析后的邮件 POST 到此。
   * 若设置 AGENT_MAIL_INBOUND_SECRET，则须携带请求头 X-Agent-Mail-Secret。
   */
  app.post("/accounts/register/email/inbound", async (request, reply) => {
    const secret = getAgentMailInboundSecret();
    if (secret) {
      const got = String(request.headers["x-agent-mail-secret"] ?? "");
      if (got !== secret) {
        return reply.code(401).send({ ok: false, message: "缺少或错误的 X-Agent-Mail-Secret" });
      }
    }
    const parsed = accountEmailInboundBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = await emailRegistrationService.applyInbound(parsed.data);
    if (!result.matched) {
      return reply.code(404).send({ ok: false, ...result });
    }
    return { ok: true, ...result };
  });

  /**
   * 邮箱验证码注册 — 步骤 3：提交验证码并创建账号。
   */
  app.post("/accounts/register/email/verify", async (request, reply) => {
    const parsed = accountEmailRegisterVerifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { code } = parsed.data;
    const actorId = accountActorFromBody(parsed.data);
    if (agentAccountService.getByActorId(actorId)) {
      return reply.code(400).send({ ok: false, message: "该用户已存在 Agent 账号" });
    }
    try {
      const { displayName, email } = await emailRegistrationService.consume(actorId, code);
      const account = await agentAccountService.register(actorId, displayName, email);
      await agentAccountService.markSetupComplete(actorId);
      return { ok: true, account };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.get("/accounts/me", async (request, reply) => {
    const parsed = accountMeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = accountActorFromBody(parsed.data);
    const acc = agentAccountService.getByActorId(actorId);
    if (!acc) {
      return reply.code(404).send({ ok: false, registered: false });
    }
    return { ok: true, registered: true, account: acc };
  });
}
