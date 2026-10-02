/**
 * 票务/日历邮件 → 日程提取（mail-schedule-extractor）：
 *   MIME 全文/ICS 附件提取、12306 购票/改签/退票三意图（同订单号串联生命周期）、
 *   航司出票、酒店确认、ICS 附件会议邀请、预筛负例、重复邮件幂等、时间闸。
 *
 * fixture 为手写的原始 RFC822（UTF-8 8bit），走 extractMailCalendarParts 同一解析路径。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MailScheduleBridge,
  extractMailScheduleDrafts,
  isTicketLikeMail,
} from "../src/services/mail-schedule-extractor.js";
import { extractMailCalendarParts } from "../src/services/mail-watch-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

// 时间炸弹根修（2026-10-01）：固定日历日期会随时间过期（parseRunAt 拒过去时刻，
// 2026-10-01 当天真实炸过）——全部行程 fixture 改为「今天 +20 天」动态基准，
// 断言从同一基准推导；过去行程用例保持固定过去日期（永远成立）
const NOW = new Date().toISOString();
const TRIP_BASE = Date.now() + 20 * 24 * 3600_000;
const cnDate = (offsetDays: number): string => {
  const d = new Date(TRIP_BASE + offsetDays * 24 * 3600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};
const isoDay = (offsetDays: number): string =>
  new Date(TRIP_BASE + offsetDays * 24 * 3600_000).toISOString().slice(0, 10);

function mime(from: string, subject: string, body: string, bodyContentType = 'text/plain; charset="utf-8"'): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      `To: user@example.com`,
      `Subject: ${subject}`,
      `Date: Thu, 24 Sep 2026 08:00:00 +0800`,
      `MIME-Version: 1.0`,
      `Content-Type: ${bodyContentType}`,
      "",
      body,
    ].join("\r\n"),
    "utf8",
  );
}

const MAIL_12306_BUY = mime(
  "中国铁路客户服务中心 <12306@rails.com.cn>",
  "[铁路客服] 网上购票成功",
  [
    "尊敬的旅客：",
    "您已成功购买车票，订单号 E987654321。",
    "车次：G101次",
    "乘车日期：" + cnDate(0) + " 09:15开",
    "北京南站 至 南京南站",
    "二等座 01车05F号",
  ].join("\r\n"),
);

const MAIL_12306_RESCHEDULE = mime(
  "中国铁路客户服务中心 <12306@rails.com.cn>",
  "[铁路客服] 改签成功",
  [
    "尊敬的旅客：",
    "您的车票已改签，订单号 E987654321。",
    "新票信息：G102次",
    "乘车日期：" + cnDate(1) + " 10:30开",
    "北京南站 至 南京南站",
  ].join("\r\n"),
);

const MAIL_12306_REFUND = mime(
  "中国铁路客户服务中心 <12306@rails.com.cn>",
  "[铁路客服] 退票成功",
  ["尊敬的旅客：", "您的车票已退票，订单号 E987654321。"].join("\r\n"),
);

const MAIL_FLIGHT = mime(
  "携程旅行 <noreply@mail.ctrip.com>",
  "出票成功：您的机票已出票",
  [
    "订单号：C12345678",
    "航班号：MU5101",
    "起飞时间：" + cnDate(1) + " 08:00 起飞",
    "上海虹桥机场 至 北京首都机场",
  ].join("\r\n"),
);

const MAIL_HOTEL = mime(
  "华住会员 <noreply@huazhu.com>",
  "预订成功通知",
  [
    "订单号：H88888888",
    "您已成功预订：上海全季酒店虹桥店",
    "入住日期：" + cnDate(2) + ",",
    "退房日期：" + cnDate(3) + ",",
  ].join("\r\n"),
);

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:kickoff@company.com",
  "SUMMARY:项目启动会",
  "LOCATION:A栋3楼会议室",
  "DTSTART:" + isoDay(13).replace(/-/g, "") + "T020000Z",
  "DTEND:" + isoDay(13).replace(/-/g, "") + "T030000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** multipart/mixed：正文 + text/calendar 附件（会议邀请形态）。 */
const MAIL_ICS_INVITE = Buffer.from(
  [
    "From: 同事 <colleague@company.com>",
    "To: user@example.com",
    "Subject: 项目启动会邀请",
    "Date: Thu, 24 Sep 2026 09:00:00 +0800",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "请查收会议邀请。",
    "--b1",
    'Content-Type: text/calendar; charset="utf-8"; name="invite.ics"',
    "Content-Disposition: attachment; filename=invite.ics",
    "",
    SAMPLE_ICS,
    "--b1--",
  ].join("\r\n"),
  "utf8",
);

test("extractMailCalendarParts：全文与 ICS 附件分离提取", () => {
  const parts = extractMailCalendarParts(MAIL_ICS_INVITE);
  assert.ok(parts.fullText.includes("请查收会议邀请"), "正文文本进 fullText");
  assert.equal(parts.icsTexts.length, 1, "text/calendar 部件进 icsTexts");
  assert.ok(parts.icsTexts[0]!.includes("BEGIN:VCALENDAR"));

  const plain = extractMailCalendarParts(MAIL_12306_BUY);
  assert.equal(plain.icsTexts.length, 0);
  assert.ok(plain.fullText.includes("G101次"));
});

test("extractMailScheduleDrafts：12306 购票草案字段", () => {
  const drafts = extractMailScheduleDrafts({
    from: "12306@rails.com.cn",
    subject: "[铁路客服] 网上购票成功",
    bodyText: extractMailCalendarParts(MAIL_12306_BUY).fullText,
    icsTexts: [],
  });
  assert.equal(drafts.length, 1);
  const d = drafts[0]!;
  assert.equal(d.matchKey, "rail-12306:E987654321");
  assert.equal(d.intent, "create");
  assert.equal(d.title, "【火车票】G101次 北京南站→南京南站");
  assert.equal(d.runAtIso, new Date(Date.parse(`${isoDay(0)}T01:15:00Z`)).toISOString(), "本地 09:15 +08 → epoch");
  assert.equal(d.location, "北京南站");
});

test("extractMailScheduleDrafts：改签/退票与购票共享同一 matchKey", () => {
  const buy = extractMailScheduleDrafts({ from: "12306@rails.com.cn", subject: "网上购票成功", bodyText: extractMailCalendarParts(MAIL_12306_BUY).fullText, icsTexts: [] })[0]!;
  const re = extractMailScheduleDrafts({ from: "12306@rails.com.cn", subject: "改签成功", bodyText: extractMailCalendarParts(MAIL_12306_RESCHEDULE).fullText, icsTexts: [] })[0]!;
  const refund = extractMailScheduleDrafts({ from: "12306@rails.com.cn", subject: "退票成功", bodyText: extractMailCalendarParts(MAIL_12306_REFUND).fullText, icsTexts: [] })[0]!;
  assert.equal(re.intent, "reschedule", "改签在购票规则之前命中");
  assert.equal(re.matchKey, buy.matchKey, "同一订单同一 key");
  assert.equal(refund.intent, "cancel");
  assert.equal(refund.matchKey, buy.matchKey, "退票只需订单号即可对上原票");
});

test("extractMailScheduleDrafts：航司/OTA 出票与酒店确认", () => {
  const flight = extractMailScheduleDrafts({ from: "noreply@mail.ctrip.com", subject: "出票成功：您的机票已出票", bodyText: extractMailCalendarParts(MAIL_FLIGHT).fullText, icsTexts: [] })[0]!;
  assert.equal(flight.matchKey, "flight-ticket:C12345678");
  assert.equal(flight.title, "【航班】MU5101 上海虹桥机场→北京首都机场");
  assert.equal(flight.runAtIso, new Date(Date.parse(`${isoDay(1)}T00:00:00Z`)).toISOString());

  const hotel = extractMailScheduleDrafts({ from: "noreply@huazhu.com", subject: "预订成功通知", bodyText: extractMailCalendarParts(MAIL_HOTEL).fullText, icsTexts: [] })[0]!;
  assert.equal(hotel.matchKey, "hotel-confirm:H88888888");
  assert.ok(hotel.title.includes("全季酒店"));
  assert.equal(hotel.runAtIso, new Date(Date.parse(`${isoDay(2)}T06:00:00Z`)).toISOString(), "入住日 14:00 +08");
});

test("extractMailScheduleDrafts：ICS 附件产出草案（窗口内）", () => {
  const drafts = extractMailScheduleDrafts(
    { from: "colleague@company.com", subject: "项目启动会邀请", bodyText: "", icsTexts: [SAMPLE_ICS] },
    { nowMs: Date.parse(NOW), lookaheadDays: 35 },
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.intent, "create");
  assert.ok(drafts[0]!.title.includes("项目启动会"));
  assert.equal(drafts[0]!.location, "A栋3楼会议室");
});

test("isTicketLikeMail：预筛正负例", () => {
  assert.equal(isTicketLikeMail("12306@rails.com.cn", "随便"), true);
  assert.equal(isTicketLikeMail("friend@qq.com", "退票通知转发"), true);
  assert.equal(isTicketLikeMail("friend@qq.com", "周末聚餐"), false);
  assert.equal(isTicketLikeMail("boss@company.com", "下周会议安排"), false);
});

type BridgeHarness = { bridge: MailScheduleBridge; tasks: ScheduleTaskService; intents: ProactiveIntent[] };

async function withBridge(fn: (h: BridgeHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mail-schedule-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  const tasks = new ScheduleTaskService();
  const intents: ProactiveIntent[] = [];
  const bridge = new MailScheduleBridge({
    tasks,
    notify: (intent) => intents.push(intent),
    now: () => new Date(NOW),
  });
  try {
    await fn({ bridge, tasks, intents });
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("桥全生命周期：购票建 → 改签改期 → 退票软取消，每轮一条汇总提醒", async () => {
  await withBridge(async ({ bridge, tasks, intents }) => {
    const actor = "user1";

    const buy = await bridge.onMail({ actorId: actor, from: "12306@rails.com.cn", subject: "网上购票成功", source: MAIL_12306_BUY });
    assert.equal(buy!.created, 1);
    const created = tasks.listAllTasks().find((t) => t.source === "email")!;
    assert.equal(created.sourceRefId, "rail-12306:E987654321");
    assert.equal(created.title, "【火车票】G101次 北京南站→南京南站");
    assert.equal(created.category, "itinerary");

    const re = await bridge.onMail({ actorId: actor, from: "12306@rails.com.cn", subject: "改签成功", source: MAIL_12306_RESCHEDULE });
    assert.equal(re!.updated, 1);
    assert.equal(re!.created, 0);
    assert.equal(tasks.getTask(created.taskId)!.runAt, new Date(Date.parse(`${isoDay(1)}T02:30:00Z`)).toISOString(), "改期同步到同一任务");

    const refund = await bridge.onMail({ actorId: actor, from: "12306@rails.com.cn", subject: "退票成功", source: MAIL_12306_REFUND });
    assert.equal(refund!.cancelled, 1);
    assert.equal(tasks.getTask(created.taskId)!.status, "cancelled");

    assert.equal(intents.length, 3, "每次变更各一条汇总提醒");
    assert.equal(intents[0]!.source, "email");
    assert.equal(intents[0]!.actorId, actor);
  });
});

test("重复投递同一封购票邮件幂等（不重复建）；正常邮件零成本跳过", async () => {
  await withBridge(async ({ bridge, tasks }) => {
    const actor = "user1";
    await bridge.onMail({ actorId: actor, from: "12306@rails.com.cn", subject: "网上购票成功", source: MAIL_12306_BUY });
    const again = await bridge.onMail({ actorId: actor, from: "12306@rails.com.cn", subject: "网上购票成功", source: MAIL_12306_BUY });
    assert.equal(again!.created, 0);
    assert.equal(again!.skipped, 1);
    assert.equal(tasks.listAllTasks().filter((t) => t.source === "email").length, 1);

    const normal = await bridge.onMail({
      actorId: actor,
      from: "friend@qq.com",
      subject: "周末聚餐",
      source: mime("friend@qq.com", "周末聚餐", "周六老地方见"),
    });
    assert.equal(normal, null, "预筛不过直接 null");
  });
});

test("时间闸：过去行程（历史邮件导入）不建日程；ICS 会议邀请走附件通道", async () => {
  await withBridge(async ({ bridge, tasks, intents }) => {
    const actor = "user1";
    const pastMail = mime(
      "中国铁路客户服务中心 <12306@rails.com.cn>",
      "网上购票成功",
      ["订单号 E1111222233。", "车次：G999次", "乘车日期：2025年1月1日 09:15开", "北京南站 至 上海站"].join("\r\n"),
    );
    const report = await bridge.onMail({ actorId: actor, from: "12306@rails.com.cn", subject: "网上购票成功", source: pastMail });
    assert.equal(report!.skipped, 1, "过去车次不入日程");
    assert.equal(tasks.listAllTasks().filter((t) => t.source === "email").length, 0);

    const invite = await bridge.onMail({ actorId: actor, from: "colleague@company.com", subject: "项目启动会邀请", source: MAIL_ICS_INVITE });
    assert.equal(invite!.created, 1, "预筛不过但 ICS 探针命中的会议邀请");
    const task = tasks.listAllTasks().find((t) => t.source === "email")!;
    assert.equal(task.title, "【日历】项目启动会");
    assert.equal(task.durationMinutes, 60);
    assert.equal(task.reminderMessage, "项目启动会");
    assert.equal(intents.length, 1);
  });
});
