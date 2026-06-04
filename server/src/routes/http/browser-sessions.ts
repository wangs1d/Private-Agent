import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import {
  browserSessionActorBodySchema,
  browserSessionConsentBodySchema,
  browserSessionImportBodySchema,
  browserSessionRevokeBodySchema,
  browserSessionStatusQuerySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

function actorFromQuery(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

function actorFromBody(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

/** 用户本机导入 Cookie + 按站点授权 Agent 读价 */
export function registerBrowserSessionRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { browserSessionService } = deps;

  app.get("/integrations/browser-sessions", async () => ({
    domain: "browser-sessions",
    statusPath: "/integrations/browser-sessions/status",
    importPath: "/integrations/browser-sessions/import",
    consentPath: "/integrations/browser-sessions/consent",
    revokePath: "/integrations/browser-sessions/revoke",
    catalogPath: "/integrations/browser-sessions/catalog",
    supportedSites: await browserSessionService.listSiteCatalog(),
    cookieFormat:
      "Chrome 扩展导出的 JSON 数组：[{ name, value, domain, path, expires?, httpOnly?, secure?, sameSite? }]",
    notes: [
      "导入后默认 agentAllowed=false，Agent 无法读价直至用户显式授权",
      "Agent 工具 browser.fetch_page 另须对话「完全访问」模式",
      "生产环境请设置 BROWSER_SESSION_SECRET",
    ],
  }));

  app.get("/integrations/browser-sessions/catalog", async () => ({
    ok: true,
    sites: await browserSessionService.listSiteCatalog(),
  }));

  app.get("/integrations/browser-sessions/status", async (request, reply) => {
    const parsed = browserSessionStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromQuery(parsed.data);
    const sites = await browserSessionService.listStatuses(actorId);
    return { ok: true, actorId, sites };
  });

  app.post("/integrations/browser-sessions/import", async (request, reply) => {
    const parsed = browserSessionImportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromBody(parsed.data);
    try {
      const site = await browserSessionService.importCookies(
        actorId,
        parsed.data.siteId,
        parsed.data.cookies,
        { agentAllowed: parsed.data.agentAllowed },
      );
      return { ok: true, site };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.post("/integrations/browser-sessions/consent", async (request, reply) => {
    const parsed = browserSessionConsentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromBody(parsed.data);
    try {
      const site = await browserSessionService.setAgentAllowed(
        actorId,
        parsed.data.siteId,
        parsed.data.agentAllowed,
      );
      return { ok: true, site };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.post("/integrations/browser-sessions/revoke", async (request, reply) => {
    const parsed = browserSessionRevokeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = actorFromBody(parsed.data);
    try {
      await browserSessionService.revoke(actorId, parsed.data.siteId);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });
}
