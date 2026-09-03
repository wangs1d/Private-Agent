// 订阅盘点服务测试（财务管家 P0）：
//  1. 候选检测：同商户 + 金额 ±10% + 月付周期 ±3 天连续 ≥2 期 → candidate
//  2. 非订阅不误报（金额波动过大 / 周期不规律 / 商户分散）
//  3. 确认候选 → confirmed；手动登记新订阅
//  4. 更新操作：used（使用率）/ cancel / ignore / reactivate / set_renewal
//  5. 盘点摘要：月成本折算 + 低使用率名单 + 候选段
//  6. 续费提醒：nextRenewalDate 前 3 天触发，同一续费日单次
//  7. 月报集成：ConsumptionLedgerListener 月报末尾追加订阅盘点段
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import {
  SubscriptionAuditService,
  detectRecurringChain,
  monthlyCost,
  normalizeMerchant,
} from "../src/services/subscription-audit-service.js";
import { ConsumptionLedgerListener } from "../src/services/consumption-ledger-listener.js";

const ACTOR = "actor-subscription-test";

/** 固定时钟：2026-09-03 10:00 */
const NOW = new Date("2026-09-03T10:00:00");
const now = () => new Date(NOW);

function dayOffset(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "subscription-audit-test-"));
  const finance = new FinanceDeepService(dir);
  await finance.load();
  const audit = new SubscriptionAuditService({ financeDeepService: finance, now });
  return { dir, finance, audit };
}

test("normalizeMerchant：大小写/空白归一化", () => {
  assert.equal(normalizeMerchant("  Netflix  "), "netflix");
  assert.equal(normalizeMerchant("iCloud   云盘"), "icloud 云盘");
  assert.equal(normalizeMerchant("NETFLIX"), normalizeMerchant("netflix"));
});

test("monthlyCost：周付/月付/年付折算", () => {
  assert.equal(monthlyCost(25, 30), 25);
  assert.equal(monthlyCost(15, 7), 64.29);
  assert.equal(monthlyCost(388, 365), 31.89);
});

test("detectRecurringChain：三笔规律月扣款 → 命中 2 期", () => {
  const chain = detectRecurringChain([
    { date: Date.parse("2026-07-01"), amount: 25, id: "t1" },
    { date: Date.parse("2026-08-01"), amount: 25, id: "t2" },
    { date: Date.parse("2026-09-01"), amount: 25, id: "t3" },
  ]);
  assert.ok(chain);
  assert.equal(chain.periodDays, 30);
  assert.equal(chain.occurrences, 2);
  assert.deepEqual(chain.transactionIds, ["t1", "t2", "t3"]);
});

test("detectRecurringChain：金额波动超 ±10% → 不命中", () => {
  const chain = detectRecurringChain([
    { date: Date.parse("2026-07-01"), amount: 25, id: "t1" },
    { date: Date.parse("2026-08-01"), amount: 60, id: "t2" },
    { date: Date.parse("2026-09-01"), amount: 25, id: "t3" },
  ]);
  assert.equal(chain, null);
});

test("refreshCandidates：规律扣款出候选，已确认商户不再出", async () => {
  const { finance, audit } = await makeFixture();
  await finance.importTransactions(ACTOR, [
    { id: "a1", date: dayOffset(62), amount: 25, type: "expense", category: "娱乐", merchant: "B站大会员" },
    { id: "a2", date: dayOffset(32), amount: 25, type: "expense", category: "娱乐", merchant: "B站大会员" },
    { id: "a3", date: dayOffset(2), amount: 25, type: "expense", category: "娱乐", merchant: "B站大会员" },
    // 非订阅：商户相同但金额/周期无规律
    { id: "b1", date: dayOffset(50), amount: 120, type: "expense", category: "购物", merchant: "淘宝" },
    { id: "b2", date: dayOffset(10), amount: 45, type: "expense", category: "购物", merchant: "淘宝" },
  ]);

  const changed = await audit.refreshCandidates(ACTOR);
  assert.equal(changed, 1);
  let list = await audit.listSubscriptions(ACTOR);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "candidate");
  assert.equal(list[0].merchant, "B站大会员");
  assert.equal(list[0].periodDays, 30);
  assert.equal(list[0].evidence?.occurrences, 2);

  // 确认后不再出候选
  const confirmed = await audit.confirmSubscription(ACTOR, {
    subscriptionId: list[0].id,
    merchant: "B站大会员",
    amount: 25,
    periodDays: 30,
    nextRenewalDate: "2026-10-01",
  });
  assert.ok(confirmed);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(await audit.refreshCandidates(ACTOR), 0);
  list = await audit.listSubscriptions(ACTOR);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "confirmed");
});

test("confirmSubscription：手动登记新订阅（无候选时新建）", async () => {
  const { audit } = await makeFixture();
  const record = await audit.confirmSubscription(ACTOR, {
    merchant: "iCloud",
    amount: 6,
    periodDays: 30,
  });
  assert.ok(record);
  assert.equal(record.status, "confirmed");
  assert.equal(record.merchant, "iCloud");
});

test("updateSubscription：used/cancel/reactivate/set_renewal", async () => {
  const { audit } = await makeFixture();
  const sub = await audit.confirmSubscription(ACTOR, {
    merchant: "Netflix",
    amount: 45,
    periodDays: 30,
    nextRenewalDate: "2026-09-20",
  });
  assert.ok(sub);

  const used = await audit.updateSubscription(ACTOR, {
    subscriptionId: sub.id,
    action: "used",
  });
  assert.equal(used?.lastUsedAt, "2026-09-03");

  const cancelled = await audit.updateSubscription(ACTOR, {
    subscriptionId: sub.id,
    action: "cancel",
  });
  assert.equal(cancelled?.status, "cancelled");

  const reactivated = await audit.updateSubscription(ACTOR, {
    subscriptionId: sub.id,
    action: "reactivate",
  });
  assert.equal(reactivated?.status, "confirmed");

  const renewed = await audit.updateSubscription(ACTOR, {
    subscriptionId: sub.id,
    action: "set_renewal",
    nextRenewalDate: "2026-09-05",
  });
  assert.equal(renewed?.nextRenewalDate, "2026-09-05");

  assert.equal(
    await audit.updateSubscription(ACTOR, { subscriptionId: "nope", action: "used" }),
    null,
  );
});

test("buildAuditSummary：月成本 + 低使用率 + 候选段", async () => {
  const { finance, audit } = await makeFixture();
  await audit.confirmSubscription(ACTOR, {
    merchant: "Netflix",
    amount: 45,
    periodDays: 30,
  });
  // 高使用率订阅：3 天前用过
  const active = await audit.confirmSubscription(ACTOR, {
    merchant: "iCloud",
    amount: 6,
    periodDays: 30,
  });
  await audit.updateSubscription(ACTOR, {
    subscriptionId: active!.id,
    action: "used",
    lastUsedAt: "2026-08-31",
  });
  // 疑似候选：规律扣款
  await finance.importTransactions(ACTOR, [
    { id: "c1", date: dayOffset(62), amount: 15, type: "expense", category: "娱乐", merchant: "Spotify" },
    { id: "c2", date: dayOffset(32), amount: 15, type: "expense", category: "娱乐", merchant: "Spotify" },
    { id: "c3", date: dayOffset(2), amount: 15, type: "expense", category: "娱乐", merchant: "Spotify" },
  ]);

  const summary = await audit.buildAuditSummary(ACTOR);
  assert.ok(summary.includes("确认 2 个"));
  assert.ok(summary.includes("¥51.00")); // 45 + 6
  assert.ok(summary.includes("Netflix")); // 从未记录使用 → 低使用名单
  assert.ok(!summary.includes("iCloud：¥6.00/月（从未记录使用）"));
  assert.ok(summary.includes("Spotify"));
  assert.ok(summary.includes("疑似订阅"));

  // 无订阅 → 空串（月报不追加）
  const empty = await audit.buildAuditSummary("actor-with-nothing");
  assert.equal(empty, "");
});

test("runDailyScan：续费日前 3 天提醒，同一续费日单次", async () => {
  const { dir, audit } = await makeFixture();
  await audit.confirmSubscription(ACTOR, {
    merchant: "Netflix",
    amount: 45,
    periodDays: 30,
    nextRenewalDate: "2026-09-05", // 距 NOW 2 天
  });
  await audit.confirmSubscription(ACTOR, {
    merchant: "iCloud",
    amount: 6,
    periodDays: 30,
    nextRenewalDate: "2026-10-01", // 不在窗口内
  });

  const reminders: string[] = [];
  const auditWithCb = new SubscriptionAuditService({
    financeDeepService: {
      listActorIds: () => [ACTOR],
      getDataRoot: () => dir,
    } as unknown as FinanceDeepService,
    now,
    onRenewalReminder: (actorId, message) => {
      reminders.push(`${actorId}: ${message}`);
    },
  });
  await auditWithCb.runDailyScan();
  assert.equal(reminders.length, 1);
  assert.ok(reminders[0].includes("Netflix"));
  assert.ok(!reminders[0].includes("iCloud"));

  // 同一天再扫：不重复提醒
  await auditWithCb.runDailyScan();
  assert.equal(reminders.length, 1);
});

test("月报集成：ConsumptionLedgerListener 月报末尾追加订阅盘点段", async () => {
  const { dir, finance, audit } = await makeFixture();
  await audit.confirmSubscription(ACTOR, {
    merchant: "Netflix",
    amount: 45,
    periodDays: 30,
  });

  const listener = new ConsumptionLedgerListener({
    financeDeepService: finance,
    subscriptionAudit: audit,
    now,
  });
  // 每月 1 日：NOW 是 9 月 3 日，手动传 9 月 1 日触发上月（8 月）月报
  const report = await listener.generateMonthlyReport(ACTOR, new Date("2026-09-01T10:00:00"));
  assert.ok(report.includes("消费月报"));
  assert.ok(report.includes("订阅盘点"));
  assert.ok(report.includes("Netflix"));

  // 未注入 subscriptionAudit：月报不含订阅段
  const listenerNoAudit = new ConsumptionLedgerListener({ financeDeepService: finance, now });
  const plain = await listenerNoAudit.generateMonthlyReport(
    ACTOR,
    new Date("2026-09-01T10:00:00"),
  );
  assert.ok(!plain.includes("订阅盘点"));

  await rm(dir, { recursive: true, force: true });
});
