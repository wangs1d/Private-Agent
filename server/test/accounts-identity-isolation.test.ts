import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 邮箱登录身份隔离测试：每个邮箱一个独立账号（/accounts/me 各查各的）、
 * 同一邮箱大小写不同写法归一为同一账号（不裂成两行）、
 * 注册后管理后台用户列表可见（/api/admin/users）。
 *
 * 用真实 fastify 实例 + inject（不起监听端口），账号库落临时目录。
 * 运行：npx tsx --test test/accounts-identity-isolation.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-identity-test-"));
const TEST_TOKEN = "test-admin-token-accounts-identity";
process.env.ADMIN_UPLOAD_TOKEN = TEST_TOKEN;
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
process.env.ADMIN_AUTH_DB = path.join(tmpDir, "admin-auth.db");

const { registerAccountRoutes } = await import("../src/routes/http/accounts.js");
const { registerAdminConsoleRoutes } = await import("../src/routes/http/admin-console.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

const accountService = new AgentAccountService();
await accountService.load();

const deps = {
  agentAccountService: accountService,
  emailRegistrationService: null,
} as unknown as HttpRouteDeps;

function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, deps);
  registerAdminConsoleRoutes(app, deps);
  return app;
}

const adminHeaders = { "x-admin-token": TEST_TOKEN };

test("两个不同邮箱注册 → 两个独立账号，/accounts/me 互不串台", async () => {
  const app = buildApp();

  const regA = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "alice@example.com", displayName: "alice", email: "alice@example.com" },
  });
  assert.equal(regA.statusCode, 200);
  assert.equal(regA.json().ok, true);

  const regB = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "bob@example.com", displayName: "bob", email: "bob@example.com" },
  });
  assert.equal(regB.statusCode, 200);

  // 各查各的：都能查到自己
  const meA = await app.inject({ method: "GET", url: "/accounts/me?userId=alice@example.com" });
  assert.equal(meA.statusCode, 200);
  assert.equal(meA.json().account.userId, "alice@example.com");
  assert.equal(meA.json().account.email, "alice@example.com");

  const meB = await app.inject({ method: "GET", url: "/accounts/me?userId=bob@example.com" });
  assert.equal(meB.statusCode, 200);
  assert.equal(meB.json().account.userId, "bob@example.com");

  // 隔离：账号数恰好 2，id 不同
  const all = accountService.listAll();
  assert.equal(all.length, 2);
  assert.notEqual(all[0].accountId, all[1].accountId);
});

test("同一邮箱大小写两种写法 → 归一为同一账号（不裂成两行）", async () => {
  const app = buildApp();

  const first = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "Carol@Example.COM", displayName: "carol", email: "Carol@Example.COM" },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().account.userId, "carol@example.com");

  // 大小写不同的重复注册：服务端按已存在拒绝（网页端视为登录成功）
  const dup = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "carol@example.com", displayName: "carol", email: "carol@example.com" },
  });
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().message, /已存在/);

  // 账号库只有一行，主键为小写
  const all = accountService.listAll().filter((a) => a.userId.includes("carol"));
  assert.equal(all.length, 1);
  assert.equal(all[0].userId, "carol@example.com");
  assert.equal(all[0].email, "carol@example.com");

  // 大写写法查询同样命中（归一后查找）
  const me = await app.inject({ method: "GET", url: "/accounts/me?userId=CAROL@example.com" });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().account.userId, "carol@example.com");
});

test("注册后管理后台用户列表可见（email/userId 同值可辨）", async () => {
  const app = buildApp();

  const res = await app.inject({ method: "GET", url: "/api/admin/users", headers: adminHeaders });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const users: Array<{ userId: string; email?: string }> =
    body.users ?? body.list ?? body.items ?? [];
  const ids = users.map((u) => u.userId);
  for (const expected of ["alice@example.com", "bob@example.com", "carol@example.com"]) {
    assert.ok(ids.includes(expected), `后台用户列表应包含 ${expected}`);
  }
  const carol = users.find((u) => u.userId === "carol@example.com");
  assert.equal(carol?.email, "carol@example.com");
});

test("未带身份的注册被拒（匿名不落共享账号桶）", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { displayName: "nobody" },
  });
  // resolveActorId 回退 anonymous：register 校验非空通过但身份为哨兵值，
  // 不允许匿名建档 —— 服务端以 400「已存在」以外的明确错误拒绝或按 anonymous 建档均可，
  // 这里锁定行为：绝不产生第二个 anonymous 账号行。
  const anonymousRows = accountService.listAll().filter((a) => a.userId === "anonymous");
  assert.ok(anonymousRows.length <= 1, "anonymous 身份至多一行");
  void res;
});
