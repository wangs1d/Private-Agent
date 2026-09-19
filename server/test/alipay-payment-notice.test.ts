// 支付宝通知解析单测（钱迹模式：自动捕获、免确认）。
// 设计原则：宁可漏记不可错记——
//   1. 常见支付/收款通知文本 → 正确提取 金额/收支/商户/时间；
//   2. 营销/积分/活动类噪音推送 → 一律不入账；
//   3. 收支语义不明或冲突（同时命中/都不命中）→ 放弃；
//   4. 相对时间（今天/昨天）与绝对时间归一化。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAlipayPaymentNotice,
} from "../src/services/alipay-payment-notice.js";

const NOW = new Date(2026, 8, 18, 12, 30, 0); // 2026-09-18 12:30:00（周五）

test("支出：常见「支付成功」通知 → expense + 金额", () => {
  const tx = parseAlipayPaymentNotice("支付成功。你在【美团】付款成功，金额¥25.80", NOW);
  assert.ok(tx);
  assert.equal(tx!.type, "expense");
  assert.equal(tx!.amount, 25.8);
  assert.equal(tx!.merchant, "美团");
});

test("支出：「在XX支付成功」内联商户 + 元单位金额", () => {
  const tx = parseAlipayPaymentNotice("支付宝通知：你在瑞幸咖啡支付成功 19.9元", NOW);
  assert.ok(tx);
  assert.equal(tx!.type, "expense");
  assert.equal(tx!.amount, 19.9);
  assert.equal(tx!.merchant, "瑞幸咖啡");
});

test("收入：收款码到账 → income", () => {
  const tx = parseAlipayPaymentNotice("收款到账：你已收钱 ¥0.01（收款码）", NOW);
  assert.ok(tx);
  assert.equal(tx!.type, "income");
  assert.equal(tx!.amount, 0.01);
});

test("收入：朋友转账", () => {
  const tx = parseAlipayPaymentNotice("你收到一笔转账，金额 ¥200.00，备注：饭钱", NOW);
  assert.ok(tx);
  assert.equal(tx!.type, "income");
  assert.equal(tx!.amount, 200);
});

test("还款成功算支出；还款提醒不算交易", () => {
  const paid = parseAlipayPaymentNotice("花呗还款成功，本期已还清 ¥1,234.56", NOW);
  assert.ok(paid);
  assert.equal(paid!.type, "expense");
  assert.equal(paid!.amount, 1234.56);

  const reminder = parseAlipayPaymentNotice("还款提醒：你的花呗将于3天后到期，请及时还款", NOW);
  assert.equal(reminder, null);
});

test("噪音推送：蚂蚁森林/积分/活动/验证码 → 不入账", () => {
  for (const noise of [
    "你的蚂蚁森林能量已成熟，快去收取",
    "会员积分到期提醒：您有 500 积分即将过期",
    "限时活动：领优惠券立减 5 元",
    "【支付宝】验证码 882133，您正在登录，泄露有风险",
    "芝麻信用分更新：本月评估完成",
  ]) {
    assert.equal(parseAlipayPaymentNotice(noise, NOW), null, noise);
  }
});

test("收支语义不明 → 放弃（宁可漏记）", () => {
  // 有金额但无收支语义
  assert.equal(parseAlipayPaymentNotice("你的账户余额为 ¥1,024.00", NOW), null);
  // 收支词都没有
  assert.equal(parseAlipayPaymentNotice("账单服务已开通 ¥0.00", NOW), null);
});

test("收支语义冲突（同时命中收入与支出）→ 放弃", () => {
  const tx = parseAlipayPaymentNotice("支付成功，收款方已到账 ¥50.00", NOW);
  // 同时含"支付成功"与"到账"：语义冲突，宁可漏记
  assert.equal(tx, null);
});

test("相对时间：今天/昨天 归一化", () => {
  const today = parseAlipayPaymentNotice("今天 09:15 你在便利店付款成功 ¥6.50", NOW);
  assert.ok(today);
  assert.equal(today!.date, "2026-09-18 09:15:00");

  const yesterday = parseAlipayPaymentNotice("昨天 21:00 收款成功 ¥88.00", NOW);
  assert.ok(yesterday);
  assert.equal(yesterday!.date, "2026-09-17 21:00:00");
});

test("绝对时间归一化（中文年月日）", () => {
  const tx = parseAlipayPaymentNotice("2026年9月17日 20:05 支付成功 ¥12.00", NOW);
  assert.ok(tx);
  assert.equal(tx!.date, "2026-09-17 20:05:00");
});

test("无时间戳 → 回退通知到达时间", () => {
  const tx = parseAlipayPaymentNotice("付款成功 ¥33.00", NOW);
  assert.ok(tx);
  assert.equal(tx!.date, "2026-09-18 12:30:00");
});
