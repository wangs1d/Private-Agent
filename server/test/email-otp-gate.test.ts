import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 邮箱所有权验证码（OTP）闸测试：
 * - 闸关（无 SMTP 凭据）：注册行为与旧版完全一致（不锁用户）；
 * - 闸开（mock SMTP）：无码/错码/重放一律拒绝，正确验证码放行且一次性；
 *   验证码与账号主键绑定（拿自己邮箱收码注册别人的邮箱行不通）；
 *   inst_* 机器身份豁免；限频与尝试次数封顶。
 * - /accounts/web 页面按闸状态渲染验证码步骤。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）；SMTP 腿用内置 mock 服务器
 * 捕获邮件（真实走 nodemailer 客户端协议栈）。
 * 运行：npx tsx --test test/email-otp-gate.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-otp-test-"));
process.env.AGENT_ACCOUNTS_FILE = path.join(tmpDir, "agent-accounts.json");
delete process.env.EMAIL_OTP_REQUIRED;

const { registerAccountRoutes } = await import("../src/routes/http/accounts.js");
const { AgentAccountService } = await import("../src/services/agent-account-service.js");
const { EmailOtpService } = await import("../src/services/email-otp-service.js");
const { EmailSmsService } = await import("../src/services/email-sms-service.js");
const { default: Fastify } = await import("fastify");
type HttpRouteDeps = import("../src/routes/http/types.js").HttpRouteDeps;

// ── mock SMTP 服务器：捕获 DATA 内容，验证码从邮件正文提取 ──

type CapturedMail = { from: string; to: string; data: string };

function startMockSmtp(): Promise<{ port: number; mails: CapturedMail[]; close: () => void }> {
  const mails: CapturedMail[] = [];
  const server = net.createServer((socket) => {
    let inData = false;
    // AUTH LOGIN 三段状态机（必须与命令解析同处一个 data 处理器，
    // 否则嵌套 once 会对同一块数据双重响应，协议死锁）
    let authStage = 0;
    let buffer = "";
    let current: CapturedMail | null = null;
    socket.write("220 mock.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            if (current) mails.push(current);
            current = null;
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else if (current) {
            current.data += line + "\n";
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (authStage === 1 || authStage === 2) {
          // 用户名/密码行（base64）：直接收下
          authStage += 1;
          if (authStage >= 3) {
            authStage = 0;
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else {
            socket.write("334 UGFzc3dvcmQ6\r\n");
          }
          continue;
        }
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          socket.write("250-mock.test\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n");
        } else if (cmd.startsWith("AUTH")) {
          authStage = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (cmd.startsWith("MAIL FROM:")) {
          current = { from: line.slice(10).trim(), to: "", data: "" };
          socket.write("250 2.1.0 Ok\r\n");
        } else if (cmd.startsWith("RCPT TO:")) {
          if (current) current.to = line.slice(8).trim();
          socket.write("250 2.1.5 Ok\r\n");
        } else if (cmd.startsWith("DATA")) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (cmd.startsWith("QUIT")) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, mails, close: () => server.close() });
    });
  });
}

function extractCode(mail: CapturedMail): string {
  const m = mail.data.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`mock SMTP 邮件里没有 6 位验证码：${mail.data.slice(0, 300)}`);
  return m[1];
}

// ── 装配 ──

const accountService = new AgentAccountService();
await accountService.load();
const otpService = new EmailOtpService();

const openSmtpServers: Array<{ close: () => void }> = [];

async function buildDeps(otpOn: boolean): Promise<HttpRouteDeps> {
  if (!otpOn) {
    return {
      agentAccountService: accountService,
      emailRegistrationService: null,
    } as unknown as HttpRouteDeps;
  }
  const smtp = await startMockSmtp();
  openSmtpServers.push(smtp);
  const emailSmsService = new EmailSmsService({
    smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: "bot@test", pass: "x", from: "NEXTBOT <bot@test>" },
  });
  (buildDeps as unknown as { _smtp?: ReturnType<typeof startMockSmtp> })._smtp = smtp;
  return {
    agentAccountService: accountService,
    emailRegistrationService: null,
    emailOtpService: otpService,
    emailSmsService,
  } as unknown as HttpRouteDeps;
}

function buildApp(deps: HttpRouteDeps): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, deps);
  return app;
}

// ── 服务级单测 ──

test("EmailOtpService：签发→校验→一次性作废；连错 5 次作废", async () => {
  const svc = new EmailOtpService();
  const sent: string[] = [];
  const r = await svc.issue("Alice@Example.COM", { deliver: async (_e, code) => sent.push(code) });
  assert.equal(r.ok, true);
  const code = sent[0];
  assert.match(code, /^\d{6}$/);

  assert.equal(svc.verify("alice@example.com", "000000" === code ? "111111" : "000000"), false, "错码不过");
  assert.equal(svc.verify("alice@example.com", code, { consume: true }), true, "对码通过并作废");
  assert.equal(svc.verify("alice@example.com", code, { consume: true }), false, "重放拒绝");

  // 尝试封顶：连错 5 次后，正确码也失效
  const sent2: string[] = [];
  await svc.issue("bob@example.com", { deliver: async (_e, c) => sent2.push(c) });
  for (let i = 0; i < 5; i++) assert.equal(svc.verify("bob@example.com", "999999"), false);
  assert.equal(svc.verify("bob@example.com", sent2[0]), false, "封顶后正确码也失效");
});

test("EmailOtpService：60 秒重发冷却", async () => {
  const svc = new EmailOtpService();
  const deliver = async () => {};
  assert.equal((await svc.issue("cool@example.com", { deliver })).ok, true);
  const again = await svc.issue("cool@example.com", { deliver });
  assert.equal(again.ok, false);
  if (!again.ok) assert.ok((again.retryAfterSeconds ?? 0) > 0 && again.retryAfterSeconds <= 60);
});

// ── 路由级：闸关（无 SMTP 凭据）＝旧行为，不锁注册 ──

test("OTP 闸关闭：无验证码照常注册（向后兼容）", async () => {
  const deps = await buildDeps(false);
  const app = buildApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "legacy@example.com", displayName: "legacy", email: "legacy@example.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().account.userId, "legacy@example.com");

  const otpStart = await app.inject({
    method: "POST",
    url: "/accounts/email/otp/start",
    payload: { email: "legacy@example.com" },
  });
  assert.equal(otpStart.statusCode, 503, "SMTP 未配置时发码端点 503");
});

// ── 路由级：闸开（mock SMTP）＝必须有真验证码 ──

test("OTP 闸开启：无码/错码拒绝 → 正确码放行 → 重放拒绝；inst_* 豁免", async () => {
  const deps = await buildDeps(true);
  const app = buildApp(deps);

  // 无码：新邮箱被拒
  const noCode = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "otp-user@example.com", displayName: "otp", email: "otp-user@example.com" },
  });
  assert.equal(noCode.statusCode, 400);
  assert.match(noCode.json().message, /验证码/);

  // 发码（走真实 nodemailer → mock SMTP）
  const start = await app.inject({
    method: "POST",
    url: "/accounts/email/otp/start",
    payload: { email: "OTP-User@Example.com" },
  });
  assert.equal(start.statusCode, 200);
  const mails = (buildDeps as unknown as { _smtp: { mails: CapturedMail[] } })._smtp.mails;
  assert.equal(mails.length, 1);
  assert.ok(mails[0].to.includes("otp-user@example.com"), "收件人是归一后的邮箱");
  // 验证码直读服务（邮件正文是 MIME 编码，不在原始报文里做脆弱解析）
  const code = otpService.peekCodeForTest("otp-user@example.com");
  assert.ok(code, "OTP 记录已建立");
  assert.match(code!, /^\d{6}$/);

  // 错码拒绝
  const wrong = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "otp-user@example.com", displayName: "otp", email: "otp-user@example.com", otpCode: "000000" === code ? "111111" : "000000" },
  });
  assert.equal(wrong.statusCode, 400);

  // 大写邮箱 + 正确码：放行（主键归一小写）
  const ok = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "OTP-User@Example.com", displayName: "otp", email: "OTP-User@Example.com", otpCode: code },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().account.userId, "otp-user@example.com");
  assert.equal(ok.json().account.email, "otp-user@example.com");

  // 重放同一码：拒绝
  const replay = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "other@example.com", displayName: "other", email: "other@example.com", otpCode: code },
  });
  assert.equal(replay.statusCode, 400);

  // inst_* 机器身份豁免：无码照常建档
  const inst = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "inst_testmachine", displayName: "inst_testmachine" },
  });
  assert.equal(inst.statusCode, 200);

  // 已注册主体带正确码重注册＝登录：服务端按「已存在」幂等（客户端视为成功）
  const sent2: CapturedMail[] = [];
  const start2 = await app.inject({
    method: "POST",
    url: "/accounts/email/otp/start",
    payload: { email: "otp-user@example.com" },
  });
  assert.equal(start2.statusCode, 200);
  void sent2;
  const mails2 = (buildDeps as unknown as { _smtp: { mails: CapturedMail[] } })._smtp.mails;
  assert.ok(mails2[mails2.length - 1].to.includes("otp-user@example.com"));
  const code2 = otpService.peekCodeForTest("otp-user@example.com");
  assert.ok(code2);
  const login = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "otp-user@example.com", displayName: "otp", email: "otp-user@example.com", otpCode: code2 },
  });
  assert.equal(login.statusCode, 400);
  assert.match(login.json().message, /已存在/);

  // 已注册主体不带码：同样维持「已存在」幂等语义（旧客户端兼容）
  const dupNoCode = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "otp-user@example.com", displayName: "otp", email: "otp-user@example.com" },
  });
  assert.equal(dupNoCode.statusCode, 400);
  assert.match(dupNoCode.json().message, /已存在/);
});

test("OTP 闸开启：验证码与账号主键绑定——拿 A 邮箱的码注册 B 邮箱行不通", async () => {
  const deps = await buildDeps(true);
  const app = buildApp(deps);

  const start = await app.inject({
    method: "POST",
    url: "/accounts/email/otp/start",
    payload: { email: "attacker@example.com" },
  });
  assert.equal(start.statusCode, 200);
  const code = otpService.peekCodeForTest("attacker@example.com");
  assert.ok(code);

  const stolen = await app.inject({
    method: "POST",
    url: "/accounts/register",
    payload: { userId: "victim@example.com", displayName: "victim", email: "attacker@example.com", otpCode: code },
  });
  assert.equal(stolen.statusCode, 400, "userId 与收码邮箱不一致必须拒绝");
  assert.equal(accountService.getByActorId("victim@example.com"), undefined);
});

test("OTP 闸开启：发码限频（60s 冷却返回 429）", async () => {
  const deps = await buildDeps(true);
  const app = buildApp(deps);
  const first = await app.inject({
    method: "POST",
    url: "/accounts/email/otp/start",
    payload: { email: "limited@example.com" },
  });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({
    method: "POST",
    url: "/accounts/email/otp/start",
    payload: { email: "limited@example.com" },
  });
  assert.equal(second.statusCode, 429);
  assert.ok(second.json().retryAfterSeconds > 0);
});

test("/accounts/web 按 OTP 闸状态渲染验证码步骤", async () => {
  const { registerAccountWebRoutes } = await import("../src/routes/http/accounts-web.js");
  const appOn = Fastify({ logger: false });
  registerAccountWebRoutes(appOn, { otpEnabled: true });
  const on = await appOn.inject({ method: "GET", url: "/accounts/web" });
  assert.equal(on.statusCode, 200);
  assert.match(on.body, /var otpEnabled = true/, "开启时页面烘焙 OTP 开关");

  const appOff = Fastify({ logger: false });
  registerAccountWebRoutes(appOff, {});
  const off = await appOff.inject({ method: "GET", url: "/accounts/web" });
  assert.equal(off.statusCode, 200);
  assert.match(off.body, /var otpEnabled = false/, "关闭时页面隐藏验证码步骤");
});

test("OTP 闸由 OUTBOUND_SMTP_* 环境变量驱动（生产构造路径）", async () => {
  const smtp = await startMockSmtp();
  openSmtpServers.push(smtp);
  process.env.OUTBOUND_SMTP_HOST = "127.0.0.1";
  process.env.OUTBOUND_SMTP_PORT = String(smtp.port);
  process.env.OUTBOUND_SMTP_SECURE = "false";
  process.env.OUTBOUND_SMTP_USER = "probe@test";
  process.env.OUTBOUND_SMTP_PASS = "dummy";
  process.env.OUTBOUND_SMTP_FROM = "NEXTBOT <probe@test>";
  try {
    const envDriven = new EmailSmsService();
    assert.equal(envDriven.isEmailEnabled(), true, "env 凭据齐备即启用");

    const deps = {
      agentAccountService: accountService,
      emailRegistrationService: null,
      emailOtpService: otpService,
      emailSmsService: envDriven,
    } as unknown as HttpRouteDeps;
    const app = buildApp(deps);

    const start = await app.inject({
      method: "POST",
      url: "/accounts/email/otp/start",
      payload: { email: "env-driven@example.com" },
    });
    assert.equal(start.statusCode, 200, "env 构造的服务可以真实发码");

    const code = otpService.peekCodeForTest("env-driven@example.com");
    assert.ok(code);
    const reg = await app.inject({
      method: "POST",
      url: "/accounts/register",
      payload: { userId: "env-driven@example.com", displayName: "env", email: "env-driven@example.com", otpCode: code },
    });
    assert.equal(reg.statusCode, 200, "env 驱动的 OTP 闸全链放行");
  } finally {
    for (const k of ["OUTBOUND_SMTP_HOST", "OUTBOUND_SMTP_PORT", "OUTBOUND_SMTP_SECURE", "OUTBOUND_SMTP_USER", "OUTBOUND_SMTP_PASS", "OUTBOUND_SMTP_FROM"]) {
      delete process.env[k];
    }
  }
});

test.after(() => {
  for (const s of openSmtpServers) s.close();
});
