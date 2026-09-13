import type { FastifyInstance, FastifyRequest } from "fastify";

import { renderAdminConsolePage } from "./admin-console-page.js";
import { feedbackStatusCounts } from "./feedback.js";
import type { HttpRouteDeps } from "./types.js";

function adminToken(): string {
  return process.env.ADMIN_UPLOAD_TOKEN ?? "admin-upload-secret";
}

function checkAdmin(req: FastifyRequest): boolean {
  return req.headers["x-admin-token"] === adminToken();
}

const DAY_MS = 86_400_000;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 管理控制台：页面 + 管理数据 API。
 *
 * - GET /admin                 控制台页面（概览 / 用户 / 支付 / 站内信 / 反馈管理）
 * - GET /admin/feedback        兼容旧链接，重定向到控制台反馈标签
 * - GET /api/admin/overview    业务聚合概览（注册 / 支付 / 站内信 / 反馈）
 * - GET /api/admin/users       用户注册数据（列表 + 新增趋势）
 * - GET /api/admin/orders      支付订单（付费意愿 = 下单量，收入 = 已支付金额）
 * - GET /api/admin/messages    站内信统计（平台分布 + 最近消息）
 *
 * 数据 API 与 gateway-admin 一致用 x-admin-token 校验
 * （ADMIN_UPLOAD_TOKEN，默认 admin-upload-secret，私有部署内网边界）。
 */
export function registerAdminConsoleRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  app.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderAdminConsolePage();
  });

  app.get("/admin/feedback", async (_request, reply) => {
    return reply.redirect("/admin#feedback");
  });

  app.get("/api/admin/overview", async (request, reply) => {
    if (!checkAdmin(request)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    const mem = process.memoryUsage();
    const feedback = await feedbackStatusCounts();

    // —— 用户注册：总量、今日/近7日新增、近14日逐日趋势 ——
    const accounts = deps.agentAccountService?.listAll() ?? [];
    const now = Date.now();
    let newToday = 0;
    let new7d = 0;
    const regByDay = new Map<string, number>();
    for (let i = 13; i >= 0; i--) regByDay.set(localDay(now - i * DAY_MS), 0);
    for (const account of accounts) {
      const t = Date.parse(account.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t >= now - DAY_MS) newToday++;
      if (t >= now - 7 * DAY_MS) new7d++;
      const key = localDay(t);
      if (regByDay.has(key)) regByDay.set(key, (regByDay.get(key) ?? 0) + 1);
    }
    const users = {
      total: accounts.length,
      newToday,
      new7d,
      series: [...regByDay.entries()].map(([day, count]) => ({ day, count })),
    };

    // —— 支付：下单量=付费意愿，已支付金额=收入（live 订单在渠道侧，本地只统计 mock 单） ——
    const orders = deps.paymentService ? deps.paymentService.orderStats() : null;

    // —— 站内信：总量、收/发、今日、近14日趋势 ——
    const messages = deps.messageHubService?.globalStats(14) ?? null;

    return {
      ok: true,
      server: {
        uptimeMs: Math.round(process.uptime() * 1000),
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        rssBytes: mem.rss,
      },
      users,
      orders,
      messages,
      feedback,
    };
  });

  app.get("/api/admin/users", async (request, reply) => {
    if (!checkAdmin(request)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    const accounts = deps.agentAccountService?.listAll() ?? [];
    const now = Date.now();
    let newToday = 0;
    let new7d = 0;
    const regByDay = new Map<string, number>();
    for (let i = 29; i >= 0; i--) regByDay.set(localDay(now - i * DAY_MS), 0);
    for (const account of accounts) {
      const t = Date.parse(account.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t >= now - DAY_MS) newToday++;
      if (t >= now - 7 * DAY_MS) new7d++;
      const key = localDay(t);
      if (regByDay.has(key)) regByDay.set(key, (regByDay.get(key) ?? 0) + 1);
    }
    const users = accounts
      .map((a) => ({
        userId: a.userId,
        displayName: a.displayName,
        email: a.email ?? null,
        setupComplete: a.setupComplete,
        createdAt: a.createdAt,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      ok: true,
      stats: {
        total: users.length,
        newToday,
        new7d,
        series: [...regByDay.entries()].map(([day, count]) => ({ day, count })),
      },
      users,
    };
  });

  app.get("/api/admin/orders", async (request, reply) => {
    if (!checkAdmin(request)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    if (!deps.paymentService) {
      return { ok: true, enabled: false, stats: null, orders: [] };
    }
    const stats = deps.paymentService.orderStats();
    const orders = deps.paymentService.getMockOrders()
      .map((o) => ({
        outTradeNo: o.outTradeNo,
        provider: o.provider,
        method: o.method,
        amount: o.amount,
        description: o.description,
        status: o.status,
        createdAt: o.createdAt,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { ok: true, enabled: true, stats, orders };
  });

  app.get("/api/admin/messages", async (request, reply) => {
    if (!checkAdmin(request)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    const hub = deps.messageHubService;
    if (!hub) return { ok: true, enabled: false, stats: null, byPlatform: [], recent: [] };
    return {
      ok: true,
      enabled: true,
      stats: hub.globalStats(14),
      byPlatform: hub.platformStats(),
      recent: hub.recentMessages(30),
    };
  });
}
