/**
 * 邮箱 IMAP 轮询服务（MailWatchService）单元测试。
 *
 * 全部用假 clientFactory（不发真网络请求）覆盖：
 *   - 新邮件差量检测 + UID 幂等（重复轮询不重复回调）
 *   - processed-uids 落盘读写（跨实例/重启仍然幂等）
 *   - 重要性分级：VIP → critical / 关键词 → high / 普通 → normal
 *   - 未配置或未启用时 start() no-op 且 status() 如实说明
 *   - 连接失败：诚实记账（lastError / consecutiveFailures），不抛错不 crash
 *   - 原始邮件正文摘要提取（plain / base64 / quoted-printable+gbk / multipart / html）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import iconv from "iconv-lite";

import {
  classifyMailImportance,
  extractMailTextSnippet,
  MailWatchService,
  type IncomingMail,
  type MailWatchClassification,
  type MailWatchDeps,
  type MailWatchFetchedMail,
  type MailWatchClient,
} from "../src/services/mail-watch-service.js";

// ---------------------------------------------------------------------- //
// 假 IMAP 客户端：内存邮箱，可模拟连接失败与标记已读
// ---------------------------------------------------------------------- //

class FakeMailbox {
  mails: MailWatchFetchedMail[] = [];
  seenUids: number[] = [];
  connectFailures = 0;
  client: MailWatchClient;

  constructor() {
    this.client = {
      connect: async () => {
        if (this.connectFailures > 0) {
          this.connectFailures -= 1;
          throw new Error("connect ECONNREFUSED 127.0.0.1:993");
        }
      },
      logout: async () => {},
      mailboxOpen: async () => ({ uidValidity: 42n, exists: this.mails.length }),
      fetchRecentMessages: async (limit: number) => this.mails.slice(-limit),
      markSeen: async (uid: number) => {
        this.seenUids.push(uid);
      },
    };
  }

  add(uid: number, from: string, subject: string, textSnippet?: string): void {
    this.mails.push({ uid, from, to: "me@example.com", subject, textSnippet });
  }
}

interface Received {
  mail: IncomingMail;
  classification: MailWatchClassification;
}

function makeService(opts: {
  mailbox: FakeMailbox;
  persistPath: string;
  env?: Record<string, string | undefined>;
  onNewMessage?: MailWatchDeps["onNewMessage"];
  factoryCalls?: { count: number };
}): MailWatchService {
  return new MailWatchService({
    clientFactory: () => {
      if (opts.factoryCalls) opts.factoryCalls.count += 1;
      return opts.mailbox.client;
    },
    onNewMessage: opts.onNewMessage,
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
      ...opts.env,
    },
    persistPath: opts.persistPath,
  });
}

function tmpStatePath(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mail-watch-")).then((dir) => join(dir, "mail-watch", "processed-uids.json"));
}

// ---------------------------------------------------------------------- //
// 差量检测 / UID 幂等 / 落盘
// ---------------------------------------------------------------------- //

test("首启基线：第一轮只记录已处理 UID，不把历史邮件当新消息轰炸", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(101, "a@example.com", "上月对账单");
  mailbox.add(102, "b@example.com", "周末聚餐呀");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });

  const result = await service.pollOnce();
  assert.ok(result.ok);
  assert.equal(result.handled, 0, "首启应建立基线而不通知");
  assert.equal(received.length, 0);

  const status = service.status();
  assert.equal(status.processedUidCount, 2);
  assert.equal(status.uidValidity, "42");
});

test("差量检测：窗口内新增 UID 才触发 onNewMessage，且分级信息齐全", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(101, "a@example.com", "旧邮件");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  await service.pollOnce(); // 基线

  mailbox.add(102, "老板 <boss@example.com>", "明天开会提前半小时");
  const result = await service.pollOnce();
  assert.ok(result.ok);
  assert.equal(result.handled, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.mail.uid, 102);
  assert.equal(received[0]!.mail.actorId, "default_user");
  assert.equal(received[0]!.mail.from, "老板 <boss@example.com>");
  assert.ok(received[0]!.classification.reasons.length >= 0, "reasons 数组存在");
});

test("UID 幂等：重复轮询同一批邮件不重复回调", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(101, "a@example.com", "第一封");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  await service.pollOnce();

  mailbox.add(102, "b@example.com", "第二封");
  const r2 = await service.pollOnce();
  assert.ok(r2.ok && r2.handled === 1);
  const r3 = await service.pollOnce();
  const r4 = await service.pollOnce();
  assert.ok(r3.ok && r3.handled === 0, "第三轮无新邮件");
  assert.ok(r4.ok && r4.handled === 0, "第四轮无新邮件");
  assert.equal(received.length, 1, "uid=102 只回调一次");
});

test("processed-uids 落盘：文件可读、结构完整，跨实例（重启）仍然幂等", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(201, "a@example.com", "落盘前");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  await service.pollOnce();
  mailbox.add(202, "b@example.com", "落盘前2");
  await service.pollOnce();

  // 文件确实落盘且内容可解析
  const raw = JSON.parse(await readFile(persistPath, "utf8")) as { version: number; initialized: boolean; uidValidity: string; uids: number[] };
  assert.equal(raw.version, 1);
  assert.equal(raw.initialized, true);
  assert.equal(raw.uidValidity, "42");
  assert.deepEqual(raw.uids, [201, 202]);

  // 模拟重启：新实例 + 同一落盘文件 + 邮箱里还是那两封 → 不重复回调
  const service2 = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  const result = await service2.pollOnce();
  assert.ok(result.ok && result.handled === 0, "重启后同一批邮件不得重复通知");
  assert.equal(received.length, 1);
});

// ---------------------------------------------------------------------- //
// 重要性分级
// ---------------------------------------------------------------------- //

test("VIP 白名单命中 → critical（精确地址大小写不敏感 + @domain 整域）", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received = new Map<number, MailWatchClassification>();
  const service = makeService({
    mailbox,
    persistPath,
    env: { MAIL_WATCH_VIP_SENDERS: "Boss@Family.com, @corp.example.com" },
    onNewMessage: async (mail, c) => { received.set(mail.uid!, c); },
  });
  await service.pollOnce(); // 基线

  mailbox.add(301, '老板 <BOSS@family.com>', "晚饭吃什么");
  mailbox.add(302, "同事 <someone@corp.example.com>", "周报请查收");
  mailbox.add(303, "陌生 <stranger@other.com>", "促销邮件");
  const result = await service.pollOnce();
  assert.ok(result.ok && result.handled === 3);

  assert.equal(received.get(301)!.importance, "critical", "精确地址（大小写不敏感）命中 VIP");
  assert.equal(received.get(301)!.reasons[0], "vip_sender:boss@family.com");
  assert.equal(received.get(302)!.importance, "critical", "@domain 整域命中 VIP");
  assert.equal(received.get(303)!.importance, "normal", "非 VIP 即便含营销词也不升级为 critical");
});

test("确定性关键词 → high：主题命中验证码、正文命中取件码、英文航班", () => {
  const subjectHit = classifyMailImportance({
    from: "noreply@service.com",
    subject: "【某平台】您的验证码是 823105，5 分钟内有效",
    textSnippet: "",
  });
  assert.equal(subjectHit.importance, "high");
  assert.match(subjectHit.reasons[0]!, /验证码/);

  const textHit = classifyMailImportance({
    from: "notice@cainiao.com",
    subject: "您有新的包裹通知",
    textSnippet: "您的包裹已到丰巢驿站，取件码 8-2-3010，请及时领取。",
  });
  assert.equal(textHit.importance, "high");

  const englishHit = classifyMailImportance({
    from: "no-reply@airline.com",
    subject: "Your flight boarding pass is ready",
    textSnippet: "",
  });
  assert.equal(englishHit.importance, "high");
});

test("无关邮件 → normal（无规则命中、reasons 为空）", () => {
  const normal = classifyMailImportance({
    from: "friend@example.com",
    subject: "周末聚餐呀",
    textSnippet: "周六晚上老地方见？",
  });
  assert.equal(normal.importance, "normal");
  assert.deepEqual(normal.reasons, []);
});

test("VIP 优先级高于关键词：VIP 发来的普通邮件也是 critical", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received: Received[] = [];
  const service = makeService({
    mailbox,
    persistPath,
    env: { MAIL_WATCH_VIP_SENDERS: "boss@family.com" },
    onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); },
  });
  await service.pollOnce();
  mailbox.add(401, "boss@family.com", "周末聚餐呀"); // 无关键词，但 VIP
  await service.pollOnce();
  assert.equal(received[0]!.classification.importance, "critical");
});

// ---------------------------------------------------------------------- //
// 标记已读 / 生命周期 / 诚实失败
// ---------------------------------------------------------------------- //

test("MAIL_WATCH_MARK_SEEN 默认不标已读；=1 时仅对新邮件标记", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(501, "a@example.com", "历史邮件");
  const persistPath = await tmpStatePath();
  const service = makeService({ mailbox, persistPath, env: { MAIL_WATCH_MARK_SEEN: "1" } });
  await service.pollOnce();
  assert.deepEqual(mailbox.seenUids, [], "首启基线不标已读");

  mailbox.add(502, "b@example.com", "新邮件");
  await service.pollOnce();
  assert.deepEqual(mailbox.seenUids, [502], "只标新邮件");

  // 默认（未设 env）不标
  const mailbox2 = new FakeMailbox();
  mailbox2.add(501, "a@example.com", "历史邮件");
  const service2 = makeService({ mailbox: mailbox2, persistPath: await tmpStatePath() });
  await service2.pollOnce();
  mailbox2.add(502, "b@example.com", "新邮件");
  await service2.pollOnce();
  assert.deepEqual(mailbox2.seenUids, [], "默认不污染用户邮箱已读状态");
});

test("未启用 start() no-op；启用但缺凭证也 no-op 并如实说明原因", () => {
  const mailbox = new FakeMailbox();
  const factoryCalls = { count: 0 };

  // 默认 MAIL_WATCH_ENABLED=0：不启动、不碰 IMAP
  const disabled = new MailWatchService({
    clientFactory: () => {
      factoryCalls.count += 1;
      return mailbox.client;
    },
    env: { MAIL_WATCH_HOST: "imap.example.com", MAIL_WATCH_USER: "u", MAIL_WATCH_PASS: "p" },
    persistPath: join(tmpdir(), "mail-watch-disabled-test", "uids.json"),
  });
  disabled.start();
  let status = disabled.status();
  assert.equal(status.running, false);
  assert.equal(status.enabled, false);
  assert.match(status.reason ?? "", /未启用/);

  // 启用了但缺 MAIL_WATCH_PASS：no-op + 如实说明
  const unconfigured = new MailWatchService({
    clientFactory: () => {
      factoryCalls.count += 1;
      return mailbox.client;
    },
    env: { MAIL_WATCH_ENABLED: "1", MAIL_WATCH_HOST: "imap.example.com", MAIL_WATCH_USER: "u" },
    persistPath: join(tmpdir(), "mail-watch-disabled-test", "uids.json"),
  });
  unconfigured.start();
  status = unconfigured.status();
  assert.equal(status.running, false);
  assert.equal(status.configured, false);
  assert.match(status.reason ?? "", /未配置/);
  assert.equal(factoryCalls.count, 0, "no-op 路径不得创建 IMAP 客户端");
});

test("start/stop：启动后真实轮询，stop 后如实标注并停止调度", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(601, "a@example.com", "启动时的存量");
  const persistPath = await tmpStatePath();
  const service = makeService({ mailbox, persistPath });

  service.start();
  assert.equal(service.status().running, true);
  // 等 setTimeout(0) 的第一轮 tick 跑完
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(service.status().lastPollAt, "启动后应完成第一轮拉取");

  service.stop();
  const status = service.status();
  assert.equal(status.running, false);
  assert.match(status.reason ?? "", /停止/);
});

test("连接失败：pollOnce 返回 ok:false，status 如实记账（连续失败计数可见），恢复后清零", async () => {
  const mailbox = new FakeMailbox();
  mailbox.connectFailures = 2; // 前两轮连接失败
  const persistPath = await tmpStatePath();
  const service = makeService({ mailbox, persistPath });

  const r1 = await service.pollOnce();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /ECONNREFUSED/);
  const s1 = service.status();
  assert.equal(s1.consecutiveFailures, 1);
  assert.match(s1.lastError ?? "", /ECONNREFUSED/, "失败原因如实进 status，不假装在盯");

  await service.pollOnce();
  assert.equal(service.status().consecutiveFailures, 2);

  const r3 = await service.pollOnce();
  assert.equal(r3.ok, true);
  const s3 = service.status();
  assert.equal(s3.consecutiveFailures, 0, "恢复后失败计数清零");
  assert.equal(s3.lastError, null);
});

test("actorId 约定：MAIL_WATCH_ACTOR_ID > MESSAGE_BRIDGE_DEFAULT_ACTOR_ID > default_user", () => {
  const mk = (env: Record<string, string | undefined>) =>
    new MailWatchService({ env, persistPath: join(tmpdir(), "mail-watch-actor-test", "uids.json") });

  assert.equal(mk({}).status().actorId, "default_user");
  assert.equal(
    mk({ MESSAGE_BRIDGE_DEFAULT_ACTOR_ID: "session-mvp-001" }).status().actorId,
    "session-mvp-001",
    "未显式配置时沿用消息桥的默认用户约定",
  );
  assert.equal(
    mk({ MESSAGE_BRIDGE_DEFAULT_ACTOR_ID: "session-mvp-001", MAIL_WATCH_ACTOR_ID: "alice" }).status().actorId,
    "alice",
    "显式 MAIL_WATCH_ACTOR_ID 优先",
  );
});

// ---------------------------------------------------------------------- //
// 原始邮件正文摘要提取（生产 imapflow 适配器依赖的解析逻辑）
// ---------------------------------------------------------------------- //

test("extractMailTextSnippet：plain 文本直接提取", () => {
  const raw = Buffer.from(
    "From: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n你好，请查收明天的会议纪要。",
    "utf8",
  );
  assert.equal(extractMailTextSnippet(raw), "你好，请查收明天的会议纪要。");
});

test("extractMailTextSnippet：base64 + utf-8 正文解码", () => {
  const text = "您的快递已到菜鸟驿站，取件码 8823。";
  const raw = Buffer.from(
    `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text, "utf8").toString("base64")}`,
    "latin1",
  );
  assert.match(extractMailTextSnippet(raw), /取件码 8823/);
});

test("extractMailTextSnippet：quoted-printable + gbk 中文解码", () => {
  const gbkBytes = iconv.encode("您的验证码是 823105，请勿泄露。", "gbk");
  // 手工 QP 编码：=XX 形式还原字节
  let qp = "";
  for (const b of gbkBytes) {
    if (b === 0x3d || b < 0x20 || b > 0x7e) qp += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    else qp += String.fromCharCode(b);
  }
  const raw = Buffer.from(
    `Content-Type: text/plain; charset="gbk"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`,
    "latin1",
  );
  assert.match(extractMailTextSnippet(raw), /验证码是 823105/);
});

test("extractMailTextSnippet：multipart/alternative 优先取 text/plain", () => {
  const boundary = "----part-boundary-42";
  const raw = Buffer.from(
    [
      "Content-Type: multipart/alternative;",
      ` boundary="${boundary}"`,
      "",
      "preamble 应被跳过",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "会议改期到明天上午十点。",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><b>会议改期到明天上午十点。</b></body></html>",
      `--${boundary}--`,
      "epilogue 应被跳过",
    ].join("\r\n"),
    "utf8",
  );
  assert.equal(extractMailTextSnippet(raw), "会议改期到明天上午十点。");
});

test("extractMailTextSnippet：仅 HTML 时去标签兜底；空输入返回空串", () => {
  const raw = Buffer.from(
    "Content-Type: text/html; charset=utf-8\r\n\r\n<html><body style='x'><b>面试邀请</b>：请查收</body></html>",
    "utf8",
  );
  assert.match(extractMailTextSnippet(raw), /面试邀请\s*：?\s*请查收/);
  assert.equal(extractMailTextSnippet(null), "");
  assert.equal(extractMailTextSnippet(Buffer.alloc(0)), "");
});
