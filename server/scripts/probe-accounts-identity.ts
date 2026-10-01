/**
 * 邮箱登录身份隔离 — 真实 HTTP 探针（独立端口 + 临时账号库，不碰常驻实例）。
 *
 * 复刻 /accounts/web 网页登录全链：
 *   GET  /accounts/web          登录页（含小写归一脚本）
 *   POST /accounts/register    网页表单提交（含大小写混写，服务端兜底归一）
 *   GET  /accounts/me          客户端会话身份查询
 *   GET  /api/admin/users      后台用户列表可见性
 *
 * 运行：npx tsx scripts/probe-accounts-identity.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3457;
const TOKEN = "probe-admin-token-accounts-identity";
const tmpDir = mkdtempSync(join(tmpdir(), "accounts-identity-probe-"));

process.env.PORT = String(PORT);
process.env.ADMIN_UPLOAD_TOKEN = TOKEN;
process.env.AGENT_ACCOUNTS_FILE = join(tmpDir, "agent-accounts.json");
process.env.ADMIN_AUTH_DB = join(tmpDir, "admin-auth.db");

const { registerAccountRoutes } = await import("../src/routes/http/accounts.js");
const { registerAccountWebRoutes } = await import("../src/routes/http/accounts-web.js");
const { registerAdminConsoleRoutes } = await import("../src/routes/http/admin-console.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { default: Fastify } = await import("fastify");

const accountService = new AgentAccountService();
await accountService.load();
const app = Fastify({ logger: false });
const deps = {
  agentAccountService: accountService,
  emailRegistrationService: null,
} as never;
registerAccountRoutes(app, deps);
registerAccountWebRoutes(app);
registerAdminConsoleRoutes(app, deps);
await app.listen({ port: PORT, host: "127.0.0.1" });

const base = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. 登录页可访问且带小写归一脚本
const page = await fetch(`${base}/accounts/web?cb=http://127.0.0.1:41527/callback&state=abc`);
const html = await page.text();
check("GET /accounts/web = 200", page.status === 200);
check(
  "登录页提交前邮箱归一小写",
  html.includes('value.trim().toLowerCase()'),
);

// 2. 模拟浏览器提交（大小写混写邮箱；即便页面脚本失效，服务端也归一）
const reg = await fetch(`${base}/accounts/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId: "Probe.User@Example.COM",
    displayName: "probe",
    email: "Probe.User@Example.COM",
  }),
});
const regBody = (await reg.json()) as { ok: boolean; account?: { userId: string; email?: string } };
check("POST /accounts/register = 200", reg.status === 200 && regBody.ok === true);
check("账号主键归一为小写", regBody.account?.userId === "probe.user@example.com", regBody.account?.userId);

// 3. 幂等重登录：小写再注册 → 已存在（网页端视为登录成功）
const dup = await fetch(`${base}/accounts/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userId: "probe.user@example.com", displayName: "probe", email: "probe.user@example.com" }),
});
const dupBody = (await dup.json()) as { ok: boolean; message?: string };
check("重登录幂等（已存在）", dup.status === 400 && (dupBody.message ?? "").includes("已存在"));

// 4. /accounts/me 两种写法查询都命中同一账号
const me1 = await fetch(`${base}/accounts/me?userId=probe.user@example.com`);
const me2 = await fetch(`${base}/accounts/me?userId=PROBE.USER@EXAMPLE.COM`);
const me1Body = (await me1.json()) as { registered: boolean };
const me2Body = (await me2.json()) as { registered: boolean };
check("me 小写查询命中", me1.status === 200 && me1Body.registered === true);
check("me 大写查询命中（归一查找）", me2.status === 200 && me2Body.registered === true);

// 5. 第二个邮箱注册 → 后台用户列表恰好两行且互不混
await fetch(`${base}/accounts/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userId: "other@example.com", displayName: "other", email: "other@example.com" }),
});
const users = await fetch(`${base}/api/admin/users`, { headers: { "x-admin-token": TOKEN } });
const usersBody = (await users.json()) as {
  users?: Array<{ userId: string; email?: string }>;
};
const list = usersBody.users ?? [];
const ids = list.map((u) => u.userId);
check("后台用户列表可见", users.status === 200 && ids.includes("probe.user@example.com") && ids.includes("other@example.com"), JSON.stringify(ids));
check("大小写归一后无重复行", ids.filter((i) => i.includes("probe.user")).length === 1);

await app.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
