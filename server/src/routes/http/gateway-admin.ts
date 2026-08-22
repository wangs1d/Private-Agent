import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  getGatewayTraceStats,
  listGatewayTraces,
} from "../../gateway/gateway-trace.js";

function adminToken(): string {
  return process.env.ADMIN_UPLOAD_TOKEN ?? "admin-upload-secret";
}

function checkAdmin(req: FastifyRequest): boolean {
  const token = req.headers["x-admin-token"] as string | undefined;
  return token === adminToken();
}

/**
 * 网关全链路路由追踪诊断端点。
 *
 * - GET /api/admin/gateway/traces?limit=50  最近 N 条路由决策（时间倒序）
 * - GET /api/admin/gateway/trace-stats      各阶段计数统计
 */
export function registerGatewayAdminRoutes(app: FastifyInstance): void {
  app.get("/api/admin/gateway/traces", async (req, reply) => {
    if (!checkAdmin(req)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    const rawLimit = (req.query as { limit?: string } | undefined)?.limit;
    const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return reply.send({ ok: true, traces: listGatewayTraces(limit) });
  });

  app.get("/api/admin/gateway/trace-stats", async (req, reply) => {
    if (!checkAdmin(req)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    return reply.send({ ok: true, ...getGatewayTraceStats() });
  });
}
