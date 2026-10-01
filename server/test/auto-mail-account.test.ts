/**
 * 邮箱自动接入单测（2026-10-01 P2）：注册邮箱 → IMAP host 推断 + actorId 归属。
 * 诚实边界：授权码永远不猜，缺了如实报 needs_pass。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAutoMailAccount } from "../src/proactivity/auto-mail-account.js";
import { MailWatchService } from "../src/services/mail-watch-service.js";
import { AgentAccountService } from "../src/services/agent-account-service.js";

function makeAccountService(rows: Array<Partial<{ userId: string; email: string; setupComplete: boolean; lastActiveAt: string; createdAt: string }>>): AgentAccountService {
  const svc = new AgentAccountService();
  const anySvc = svc as unknown as { byActorId: Map<string, Record<string, unknown>> };
  anySvc.byActorId.clear();
  rows.forEach((r, i) => {
    anySvc.byActorId.set(r.userId ?? `u${i}`, {
      accountId: `id-${i}`,
      userId: r.userId ?? `u${i}`,
      displayName: r.userId ?? `u${i}`,
      email: r.email,
      setupComplete: r.setupComplete ?? true,
      lastActiveAt: r.lastActiveAt,
      createdAt: r.createdAt ?? "2026-09-28T00:00:00Z",
    });
  });
  return svc;
}

test("resolveAutoMailAccount：QQ 邮箱映射 imap.qq.com，取最近活跃账号", () => {
  const svc = makeAccountService([
    { userId: "old@qq.com", email: "old@qq.com", lastActiveAt: "2026-09-28T00:00:00Z" },
    { userId: "new@qq.com", email: "new@qq.com", lastActiveAt: "2026-09-30T12:00:00Z" },
  ]);
  const acct = resolveAutoMailAccount(svc);
  assert.ok(acct);
  assert.equal(acct!.actorId, "new@qq.com", "取最近活跃的账号");
  assert.equal(acct!.imapHost, "imap.qq.com");
  assert.equal(acct!.imapPort, 993);
});

test("resolveAutoMailAccount：未收录域/无邮箱返回 null（不猜）", () => {
  assert.equal(
    resolveAutoMailAccount(makeAccountService([{ userId: "x@some-corp.cn", email: "x@some-corp.cn" }])),
    null,
    "企业邮箱域不猜 host",
  );
  assert.equal(resolveAutoMailAccount(makeAccountService([{ userId: "noemail" }])), null);
});

test("applyAutoAccount：自动补 host/user/actorId + enabled，缺 pass 如实报等待授权码", () => {
  const svc = new MailWatchService({ env: { MAIL_WATCH_ENABLED: "0" } });
  svc.applyAutoAccount({ actorId: "u@qq.com", email: "u@qq.com", imapHost: "imap.qq.com", imapPort: 993 });
  svc.start();
  const st = svc.status();
  assert.equal(st.running, false, "无授权码不假装运行");
  assert.match(st.reason ?? "", /授权码/);
  assert.ok(svc.isConfigured() === false, "pass 缺失时 configured=false");
});

test("applyAutoAccount：有 pass 即全链 configured，可启动", () => {
  const svc = new MailWatchService({
    env: { MAIL_WATCH_ENABLED: "0", MAIL_WATCH_PASS: "dummy-auth-code" },
  });
  svc.applyAutoAccount({ actorId: "u@qq.com", email: "u@qq.com", imapHost: "imap.qq.com", imapPort: 993 });
  assert.equal(svc.isConfigured(), true);
  svc.start();
  assert.equal(svc.status().running, true, "自动接入 + 授权码齐备 → 运行");
  svc.stop();
});

test("applyAutoAccount：env 显式配置时不覆盖", () => {
  const svc = new MailWatchService({
    env: { MAIL_WATCH_ENABLED: "1", MAIL_WATCH_HOST: "imap.custom.com", MAIL_WATCH_USER: "me@custom.com", MAIL_WATCH_PASS: "p" },
  });
  svc.applyAutoAccount({ actorId: "u@qq.com", email: "u@qq.com", imapHost: "imap.qq.com", imapPort: 993 });
  svc.start();
  assert.equal(svc.status().running, true);
  svc.stop();
});
