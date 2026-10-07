// 手机端邮箱登录真链探针（一次性，放仓库根：不在 server/ 内，避免触发 tsx watch 重启）。
// 走的接口与手机端 EmailLoginApi 完全一致：
//   1. POST /accounts/email/otp/start        真实 SMTP 发码
//   2. POST /accounts/register (无码)        验证 OTP 闸文案
//   3. IMAP 收验证码                          证明邮件真落地
//   4. POST /accounts/register (错码)        验证码校验
//   5. POST /accounts/register (真码)        新号注册成功 / 老号「已存在」幂等登录
// 用法：node probe-mobile-email-login.mjs <目标邮箱>
import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";

const target = process.argv[2] ?? "";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
  console.error("用法：node probe-mobile-email-login.mjs <目标邮箱>");
  process.exit(1);
}

const env = readFileSync("server/.env", "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
const smtpUser = pick("OUTBOUND_SMTP_USER");
const smtpPass = pick("OUTBOUND_SMTP_PASS");
const BASE = "http://127.0.0.1:3000";

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

console.log("=== 1) otp/start ===");
const start = await post("/accounts/email/otp/start", { email: target });
console.log(start.status, JSON.stringify(start.data));
if (start.status !== 200) process.exit(1);
await new Promise((r) => setTimeout(r, 3000));

console.log("=== 2) register 无码（预期 OTP 闸文案/已存在幂等）===");
const noCode = await post("/accounts/register", {
  userId: target, displayName: target.split("@")[0], email: target,
});
console.log(noCode.status, JSON.stringify(noCode.data));

console.log("=== 3) IMAP 收验证码 ===");
const client = new ImapFlow({
  host: "imap.qq.com", port: 993, secure: true,
  auth: { user: smtpUser, pass: smtpPass },
  logger: false,
});
await client.connect();
const lock = await client.getMailboxLock("INBOX");
let code = "";
try {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const uids = await client.search({ since });
  console.log("近10分钟邮件数:", uids.length);
  for (let i = uids.length - 1; i >= 0; i--) {
    const msg = await client.fetchOne(uids[i], { envelope: true, source: true });
    const subject = msg.envelope?.subject ?? "";
    console.log("  mail:", subject.slice(0, 60));
    if (!code && subject.includes("NEXTBOT")) {
      const m = subject.match(/(\d{6})/);
      code = m?.[1] ?? "";
    }
  }
  console.log("code:", code ? "***" + code.slice(-2) : "(未提取到)");
} finally {
  lock.release();
  await client.logout();
}
if (!code) process.exit(1);

console.log("=== 4) register 错码（预期 400 验证码不正确）===");
const wrong = await post("/accounts/register", {
  userId: target, displayName: target.split("@")[0], email: target, otpCode: "000000" === code ? "111111" : "000000",
});
console.log(wrong.status, JSON.stringify(wrong.data));

console.log("=== 5) register 真码（预期 200 ok / 400 已存在=登录成功语义）===");
const ok = await post("/accounts/register", {
  userId: target, displayName: target.split("@")[0], email: target, otpCode: code,
});
console.log(ok.status, JSON.stringify(ok.data));
const loginOk =
  (ok.status === 200 && ok.data.ok === true) ||
  (typeof ok.data.message === "string" && ok.data.message.includes("已存在"));
console.log(loginOk ? "\n[PASS] 手机端登录链全通（发码→收码→验证→登录）" : "\n[FAIL] 登录未通过");
process.exit(loginOk ? 0 : 1);
