import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import {
  wechatClawActorBodySchema,
  wechatClawBridgeChatBodySchema,
  wechatClawLoginStartBodySchema,
  wechatClawLoginWaitBodySchema,
  wechatClawStatusQuerySchema,
} from "../../schemas/api.js";
import {
  assertWechatClawBridgeAuthorized,
  readWechatClawBridgeConfig,
} from "../../services/wechat-claw-bridge-service.js";
import type { HttpRouteDeps } from "./types.js";

function actorFromQuery(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

function actorFromBody(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

/** 微信 Claw（OpenClaw openclaw-weixin 渠道）绑定 HTTP API */
export function registerWechatClawRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { wechatClawBindingService, wechatClawBridgeService } = deps;
  const bridgeConfig = readWechatClawBridgeConfig();

  app.get("/integrations/wechat-claw", async () => ({
    domain: "wechat-claw",
    statusPath: "/integrations/wechat-claw/status",
    loginStartPath: "/integrations/wechat-claw/login/start",
    loginWaitPath: "/integrations/wechat-claw/login/wait",
    unbindPath: "/integrations/wechat-claw/unbind",
    bridgeChatPath: "/integrations/wechat-claw/bridge/chat",
    channel: "openclaw-weixin",
    bridgeEnabled: bridgeConfig.enabled,
  }));

  app.get("/integrations/wechat-claw/status", async (request, reply) => {
    const parsed = wechatClawStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromQuery(parsed.data);
    const status = await wechatClawBindingService.getStatus(actorId);
    return { ok: true, ...status };
  });

  app.post("/integrations/wechat-claw/login/start", async (request, reply) => {
    const parsed = wechatClawLoginStartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromBody(parsed.data);
    try {
      const result = await wechatClawBindingService.startLogin(actorId, parsed.data.force ?? false);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(503).send({ ok: false, message });
    }
  });

  app.post("/integrations/wechat-claw/login/wait", async (request, reply) => {
    const parsed = wechatClawLoginWaitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromBody(parsed.data);
    try {
      const result = await wechatClawBindingService.waitLogin(
        actorId,
        {
          currentQrDataUrl: parsed.data.currentQrDataUrl,
          qrKnown: parsed.data.qrKnown,
          timeoutMs: parsed.data.timeoutMs ?? 25_000,
        },
      );
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(503).send({ ok: false, message });
    }
  });

  app.post("/integrations/wechat-claw/unbind", async (request, reply) => {
    const parsed = wechatClawActorBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromBody(parsed.data);
    try {
      await wechatClawBindingService.unbind(actorId);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(503).send({ ok: false, message });
    }
  });

  app.post("/integrations/wechat-claw/bridge/chat", async (request, reply) => {
    if (!wechatClawBridgeService.isEnabled()) {
      return reply.code(503).send({ ok: false, message: "微信消息桥未启用" });
    }
    try {
      assertWechatClawBridgeAuthorized(request);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(401).send({ ok: false, message });
    }
    const parsed = wechatClawBridgeChatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = await wechatClawBridgeService.handleChat(parsed.data);
    if (!result.ok) {
      return reply.code(422).send(result);
    }
    return result;
  });
}
