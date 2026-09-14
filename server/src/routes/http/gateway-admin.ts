import type { FastifyInstance } from "fastify";

import { requireAdmin } from "./admin-auth.js";
import {
  getGatewayTraceStats,
  listGatewayTraces,
} from "../../gateway/gateway-trace.js";

/**
 * 网关全链路路由追踪诊断端点。
 *
 * - GET /api/admin/gateway/traces?limit=50  最近 N 条路由决策（时间倒序）
 * - GET /api/admin/gateway/trace-stats      各阶段计数统计
 */
export function registerGatewayAdminRoutes(app: FastifyInstance): void {
  app.get("/api/admin/gateway/traces", { preHandler: requireAdmin }, async (req, reply) => {
    const rawLimit = (req.query as { limit?: string } | undefined)?.limit;
    const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return reply.send({ ok: true, traces: listGatewayTraces(limit) });
  });

  app.get("/api/admin/gateway/trace-stats", { preHandler: requireAdmin }, async () => {
    return { ok: true, ...getGatewayTraceStats() };
  });
}
