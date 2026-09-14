import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 管理后台域测试：共享鉴权门 / 反馈 SQLite 存储与权限边界 /
 * 支付订单台账（mock 模式落库）/ 用户禁用 API 与对话禁用门。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）。
 * 运行：npx tsx --test test/admin-console.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-console-test-"));
const TEST_TOKEN = "test-admin-token-12345";
delete process.env.ADMIN_UPLOAD_TOKEN;
process.env.FEEDBACK_DB = path.join(tmpDir, "feedback.db");
process.env.PAYMENT_LEDGER_DB = path.join(tmpDir, "payment", "orders.db");
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");

const { registerFeedbackRoutes, feedbackStatusCounts } = await import(
  "../src/routes/http/feedback.js"
);
const { registerAdminConsoleRoutes } = await import("../src/routes/http/admin-console.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { PaymentService } = await import("../src/services/payment-service.js");
const { isActorDisabled } = await import("../src/services/user-disable-gate.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();
const paymentService = new PaymentService();

/** 管理台路由只需少数依赖，其余以 null/缺省占位。 */
const deps = {
  agentAccountService: accountService,
  paymentService,
} as unknown as HttpRouteDeps;

function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerFeedbackRoutes(app);
  registerAdminConsoleRoutes(app, deps);
  return app;
}

const adminHeaders = { "x-admin-token": TEST_TOKEN };

test("ADMIN_UPLOAD_TOKEN 未配置时管理接口返回 503", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/admin/overview" });
  assert.equal(res.statusCode, 503);
  await app.close();
});

test("配置 token 后：错误 token 401、正确 token 200", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();
  const bad = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { "x-admin-token": "wrong" } });
  assert.equal(bad.statusCode, 401);
  const good = await app.inject({ method: "GET", url: "/api/admin/overview", headers: adminHeaders });
  assert.equal(good.statusCode, 200);
  const body = good.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.users.total, "number");
  await app.close();
});

test("反馈：提交开放；全量列表与状态流转须管理员；按身份查询保持开放", async () => {
  const app = buildApp();

  const submit = await app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: { userId: "user-fb-1", type: "bug", title: "闪退", description: "点开设置就闪退" },
  });
  assert.equal(submit.statusCode, 200);
  const record = submit.json().feedback;
  assert.equal(record.status, "open");

  // 无 token 全量列表 → 401
  const listNoAuth = await app.inject({ method: "GET", url: "/api/feedback" });
  assert.equal(listNoAuth.statusCode, 401);
  // 带 token 全量列表 → 200
  const listAuth = await app.inject({ method: "GET", url: "/api/feedback", headers: adminHeaders });
  assert.equal(listAuth.statusCode, 200);
  assert.ok(listAuth.json().total >= 1);

  // 客户端按身份查自己的反馈 → 开放
  const mine = await app.inject({ method: "GET", url: "/api/feedback?actorId=user-fb-1&userId=user-fb-1" });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().total, 1);

  // 状态流转：无 token 401；带 token 200 并写审计
  const statusNoAuth = await app.inject({
    method: "POST",
    url: `/api/feedback/${record.id}/status`,
    payload: { status: "resolved", replyNote: "已修复" },
  });
  assert.equal(statusNoAuth.statusCode, 401);
  const statusAuth = await app.inject({
    method: "POST",
    url: `/api/feedback/${record.id}/status`,
    headers: adminHeaders,
    payload: { status: "resolved", replyNote: "已修复" },
  });
  assert.equal(statusAuth.statusCode, 200);
  assert.equal(statusAuth.json().feedback.status, "resolved");
  assert.equal(statusAuth.json().feedback.replyNote, "已修复");

  const counts = await feedbackStatusCounts();
  assert.equal(counts.resolved, 1);
  await app.close();
});

test("支付：mock 下单落台账，管理接口可见且统计按模式拆分", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();

  await paymentService.createOrder({
    amount: 9.9,
    description: "台账测试商品",
    provider: "wechat",
    method: "native",
  });

  const res = await app.inject({ method: "GET", url: "/api/admin/orders", headers: adminHeaders });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.ok(body.stats.byMode.mock.total >= 1);
  const row = body.orders.find((o: { description: string }) => o.description === "台账测试商品");
  assert.ok(row, "台账中应能查到刚下的订单");
  assert.equal(row.mode, "mock");
  assert.equal(row.status, "pending");
  await app.close();
});

test("用户禁用：API 生效、写审计、对话门拦截", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();
  await accountService.register("user-dis-1", "被禁用用户");

  const disable = await app.inject({
    method: "POST",
    url: "/api/admin/users/user-dis-1/disabled",
    headers: adminHeaders,
    payload: { disabled: true },
  });
  assert.equal(disable.statusCode, 200);
  assert.equal(accountService.getByActorId("user-dis-1")?.disabled, true);
  assert.equal(await isActorDisabled("user-dis-1"), true, "禁用门应读到文件里的禁用标记");

  const enable = await app.inject({
    method: "POST",
    url: "/api/admin/users/user-dis-1/disabled",
    headers: adminHeaders,
    payload: { disabled: false },
  });
  assert.equal(enable.statusCode, 200);
  assert.equal(accountService.getByActorId("user-dis-1")?.disabled, undefined);
  assert.equal(await isActorDisabled("user-dis-1"), false);

  // 不存在的用户 404
  const missing = await app.inject({
    method: "POST",
    url: "/api/admin/users/nobody/disabled",
    headers: adminHeaders,
    payload: { disabled: true },
  });
  assert.equal(missing.statusCode, 404);

  // 禁用操作进了审计
  const audit = await app.inject({ method: "GET", url: "/api/admin/audit", headers: adminHeaders });
  assert.equal(audit.statusCode, 200);
  const actions = audit.json().entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes("user.disable"), "审计应包含 user.disable");
  assert.ok(actions.includes("user.enable"), "审计应包含 user.enable");
  await app.close();
});

test("系统状态与服务配置接口返回完整结构", async () => {
  process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
  const app = buildApp();

  const sys = await app.inject({ method: "GET", url: "/api/admin/system", headers: adminHeaders });
  assert.equal(sys.statusCode, 200);
  const s = sys.json();
  assert.equal(s.ok, true);
  assert.ok(s.server.uptimeMs >= 0);
  assert.ok(typeof s.storage.dataDir.totalBytes, "number");
  assert.ok(s.deps && "model" in s.deps && "redis" in s.deps && "qdrant" in s.deps);
  assert.ok(s.jobs && typeof s.jobs.total === "number");

  const cfg = await app.inject({ method: "GET", url: "/api/admin/config", headers: adminHeaders });
  assert.equal(cfg.statusCode, 200);
  const c = cfg.json();
  assert.equal(c.ok, true);
  assert.ok(c.payment.wechat && c.payment.alipay);
  // 密钥绝不回传，只回传是否已设置
  assert.equal(typeof c.payment.wechat.apiKeySet, "boolean");
  assert.equal(c.payment.wechat.apiKey, undefined);
  await app.close();
});
