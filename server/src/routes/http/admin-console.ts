import { stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import os from "node:os";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { renderAdminConsolePage } from "./admin-console-page.js";
import { adminAudit, readAdminAudit, requireAdmin } from "./admin-auth.js";
import { feedbackStatusCounts } from "./feedback.js";
import { resolvePrimaryExternalModelBinding } from "../../external-model/resolve-provider.js";
import type { HttpRouteDeps } from "./types.js";

const DAY_MS = 86_400_000;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 管理控制台：页面 + 管理数据 API。
 *
 * - GET  /admin                            控制台页面（概览/用户/支付/站内信/反馈/下载分发/系统）
 * - GET  /admin/feedback                   兼容旧链接，重定向到控制台反馈标签
 * - GET  /api/admin/overview               业务聚合概览（注册 / 支付 / 站内信 / 反馈）
 * - GET  /api/admin/users                  用户注册数据（列表 + 新增趋势）
 * - POST /api/admin/users/:id/disabled     禁用/恢复用户（审计落 admin-audit.jsonl）
 * - GET  /api/admin/orders                 支付订单（持久台账，mock/live 拆分统计）
 * - GET  /api/admin/messages               站内信统计（平台分布 + 最近消息）
 * - GET  /api/admin/system                 系统状态（进程/OS/存储占用/依赖探活/定时任务）
 * - GET  /api/admin/config                 服务配置状态（支付渠道/模型/邮件，不回传密钥）
 * - GET  /api/admin/audit?limit=50         最近管理操作审计
 *
 * 全部接口经共享 requireAdmin 鉴权（x-admin-token == ADMIN_UPLOAD_TOKEN，
 * 无默认值：未配置该环境变量时管理接口一律 503）。
 */

/** 目录体积：递归求和，限制扫描文件数防止失控。 */
async function dirSize(dir: string): Promise<{ bytes: number; files: number; truncated: boolean }> {
  const FILE_CAP = 20_000;
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files > FILE_CAP) {
        truncated = true;
        return { bytes, files, truncated };
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files++;
        try {
          const s = await stat(full);
          bytes += s.size;
        } catch {
          // 竞态删除：忽略
        }
      }
    }
  }
  return { bytes, files, truncated };
}

/** data 目录顶层条目体积明细（管理页存储表用）。 */
async function dataDirBreakdown(): Promise<{
  path: string;
  totalBytes: number;
  entries: Array<{ name: string; bytes: number; files: number; isDir: boolean }>;
}> {
  const dataDir = resolve(process.cwd(), "data");
  let entries: Array<{ name: string; bytes: number; files: number; isDir: boolean }> = [];
  let totalBytes = 0;
  try {
    const items = await readdir(dataDir, { withFileTypes: true });
    entries = await Promise.all(items.map(async (item) => {
      const full = join(dataDir, item.name);
      if (item.isDirectory()) {
        const s = await dirSize(full);
        return { name: item.name, bytes: s.bytes, files: s.files, isDir: true };
      }
      try {
        const st = await stat(full);
        return { name: item.name, bytes: st.size, files: 1, isDir: false };
      } catch {
        return { name: item.name, bytes: 0, files: 0, isDir: false };
      }
    }));
    entries.sort((a, b) => b.bytes - a.bytes);
    totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  } catch {
    // data 目录不存在
  }
  return { path: dataDir, totalBytes, entries };
}

/** 下载目录路径（与 downloads.ts 的解析规则保持一致）。 */
function downloadsDirPath(): string {
  if (process.env.DOWNLOADS_DIR) return resolve(process.env.DOWNLOADS_DIR);
  if (process.env.NODE_ENV === "production") return resolve("/app/downloads");
  return resolve(import.meta.dirname ?? __dirname, "../../../downloads");
}

/** Redis TCP 探活：连通即认为健康（不发 PING，避免协议兼容问题）。 */
function probeRedis(url: string, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((res) => {
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      res({ ok, detail });
    };
    let host = "127.0.0.1";
    let port = 6379;
    try {
      const parsed = new URL(url);
      host = parsed.hostname || host;
      port = Number(parsed.port) || port;
    } catch {
      // 非 URL 形式：按 host:port 解析
      const [h, p] = url.replace(/^redis:\/\//, "").split(":");
      if (h) host = h;
      if (p && Number.isFinite(Number(p))) port = Number(p);
    }
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, `tcp ${host}:${port} 连通`));
    socket.once("timeout", () => done(false, `tcp ${host}:${port} 超时`));
    socket.once("error", (err) => done(false, `tcp ${host}:${port} 失败：${err.message}`));
  });
}

/** Qdrant HTTP 探活（GET /readyz，2s 超时）。 */
async function probeQdrant(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/readyz`, { signal: AbortSignal.timeout(2000) });
    return { ok: resp.ok, detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function registerAdminConsoleRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  app.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderAdminConsolePage();
  });

  app.get("/admin/feedback", async (_request, reply) => {
    return reply.redirect("/admin#feedback");
  });

  app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
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
      disabled: accounts.filter((a) => a.disabled).length,
      newToday,
      new7d,
      series: [...regByDay.entries()].map(([day, count]) => ({ day, count })),
    };

    // —— 支付：台账统计（mock/live 拆分），下单量=付费意愿，已支付金额=收入 ——
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

  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
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
        disabled: Boolean(a.disabled),
        createdAt: a.createdAt,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      ok: true,
      stats: {
        total: users.length,
        disabled: users.filter((u) => u.disabled).length,
        newToday,
        new7d,
        series: [...regByDay.entries()].map(([day, count]) => ({ day, count })),
      },
      users,
    };
  });

  const disableBodySchema = z.object({ disabled: z.boolean() });

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/disabled",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = disableBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const userId = String(request.params.userId ?? "").trim();
      const record = await deps.agentAccountService?.setDisabled(userId, parsed.data.disabled);
      if (!record) {
        return reply.code(404).send({ ok: false, message: "user not found" });
      }
      await adminAudit(
        parsed.data.disabled ? "user.disable" : "user.enable",
        { userId, displayName: record.displayName },
        request,
      );
      return { ok: true, account: record };
    },
  );

  app.get("/api/admin/orders", { preHandler: requireAdmin }, async () => {
    if (!deps.paymentService) {
      return { ok: true, enabled: false, stats: null, orders: [] };
    }
    const stats = deps.paymentService.orderStats();
    const orders = deps.paymentService.listOrders(300).map((o) => ({
      outTradeNo: o.outTradeNo,
      provider: o.provider,
      method: o.method,
      amount: o.amount,
      description: o.description,
      mode: o.mode,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
    }));
    return { ok: true, enabled: true, stats, orders };
  });

  app.get("/api/admin/messages", { preHandler: requireAdmin }, async () => {
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

  app.get("/api/admin/system", { preHandler: requireAdmin }, async () => {
    const mem = process.memoryUsage();
    const [storage, downloads] = await Promise.all([
      dataDirBreakdown(),
      dirSize(downloadsDirPath()),
    ]);

    // —— 依赖探活：只在配置了对应服务时探测（变量名与实际使用方一致） ——
    const qdrantUrl = process.env.AGENT_QDRANT_URL?.trim() || "";
    const qdrant = qdrantUrl
      ? { configured: true, ...(await probeQdrant(qdrantUrl)) }
      : { configured: false, ok: false, detail: "AGENT_QDRANT_URL 未配置" };
    const redisUrl =
      process.env.AGENT_REDIS_URL?.trim() || process.env.HTTP_RATE_LIMIT_REDIS_URL?.trim() || "";
    const redis = redisUrl
      ? { configured: true, ...(await probeRedis(redisUrl)) }
      : { configured: false, ok: false, detail: "AGENT_REDIS_URL / HTTP_RATE_LIMIT_REDIS_URL 未配置" };
    const modelBinding = resolvePrimaryExternalModelBinding();
    const model = modelBinding
      ? {
          configured: true,
          ok: true,
          detail: `${modelBinding.providerId} · ${modelBinding.model || "(默认模型)"} · ${modelBinding.baseUrl}`,
        }
      : {
          configured: false,
          ok: false,
          detail: "未配置任何模型密钥（MOONSHOT_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY）",
        };

    // —— 定时任务（用户日程）统计 ——
    const tasks = deps.scheduleTaskService?.listAllTasks() ?? [];
    const now = Date.now();
    const jobs = {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "active" || t.status === "paused").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
      nextRunAt:
        tasks
          .map((t) => t.nextRunAt ?? t.runAt)
          .filter((t) => {
            const ms = Date.parse(t);
            return Number.isFinite(ms) && ms >= now;
          })
          .sort()[0] ?? null,
    };

    const accounts = deps.agentAccountService?.listAll() ?? [];
    const feedback = await feedbackStatusCounts();

    return {
      ok: true,
      server: {
        uptimeMs: Math.round(process.uptime() * 1000),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        cwd: process.cwd(),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        externalMemoryBytes: mem.external,
      },
      os: {
        hostname: os.hostname(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      },
      storage: {
        dataDir: storage,
        downloadsDir: { path: downloadsDirPath(), bytes: downloads.bytes, files: downloads.files },
      },
      deps: { qdrant, redis, model },
      jobs,
      accounts: { total: accounts.length, disabled: accounts.filter((a) => a.disabled).length },
      feedback,
    };
  });

  app.get("/api/admin/config", { preHandler: requireAdmin }, async () => {
    const env = process.env;
    const modelBinding = resolvePrimaryExternalModelBinding();
    return {
      ok: true,
      payment: {
        wechat: {
          mode: env.WECHAT_PAY_MODE?.trim() || "mock(默认)",
          appId: env.WECHAT_PAY_APP_ID?.trim() || null,
          mchId: env.WECHAT_PAY_MCH_ID?.trim() || null,
          apiKeySet: Boolean(env.WECHAT_PAY_API_KEY?.trim()),
          privateKeySet: Boolean(env.WECHAT_PAY_PRIVATE_KEY?.trim()),
          certSerialNo: env.WECHAT_PAY_CERT_SERIAL_NO?.trim() || null,
        },
        alipay: {
          mode: env.ALIPAY_MODE?.trim() || "mock(默认)",
          appId: env.ALIPAY_APP_ID?.trim() || null,
          gatewayUrl: env.ALIPAY_GATEWAY_URL?.trim() || "https://openapi.alipay.com/gateway.do",
          privateKeySet: Boolean(env.ALIPAY_PRIVATE_KEY?.trim()),
          publicKeySet: Boolean(env.ALIPAY_PUBLIC_KEY?.trim()),
        },
        notifyBaseUrl: env.PAYMENT_NOTIFY_BASE_URL?.trim() || null,
      },
      model: modelBinding
        ? {
            configured: true,
            providerId: modelBinding.providerId,
            model: modelBinding.model,
            baseUrl: modelBinding.baseUrl,
          }
        : { configured: false },
      mail: {
        agentMailDomain: env.AGENT_MAIL_DOMAIN?.trim() || "agents.privateai.local(默认)",
        inboundSecretSet: Boolean(env.AGENT_MAIL_INBOUND_SECRET?.trim()),
        outboundSmtpConfigured: Boolean(
          env.OUTBOUND_SMTP_HOST?.trim() && env.OUTBOUND_SMTP_USER?.trim() && env.OUTBOUND_SMTP_PASS?.trim(),
        ),
        outboundSmtpHost: env.OUTBOUND_SMTP_HOST?.trim() || null,
        outboundFrom: env.OUTBOUND_SMTP_FROM?.trim() || env.OUTBOUND_SMTP_USER?.trim() || null,
      },
      paths: {
        downloadsDir: downloadsDirPath(),
      },
    };
  });

  app.get("/api/admin/audit", { preHandler: requireAdmin }, async (request) => {
    const q = request.query as { limit?: string } | undefined;
    const parsed = q?.limit ? Number.parseInt(q.limit, 10) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return { ok: true, entries: await readAdminAudit(limit) };
  });
}
