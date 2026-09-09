import assert from "node:assert/strict";
import test from "node:test";

import type { BookingDraft, BookingSearchQuery } from "../src/services/booking/booking-provider.js";
import { TravelTicketProvider } from "../src/services/booking/providers/travel-ticket-provider.js";
import { BookingService } from "../src/services/booking/booking-service.js";
import { BookingOrderStore } from "../src/services/booking/booking-order-store.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

const provider = new TravelTicketProvider();
const ctx = { actorId: "u1", location: null };

function searchQuery(params: Record<string, unknown>): BookingSearchQuery {
  return { domain: "travel", params };
}

test("availability：无外部 API 依赖，始终可用", () => {
  assert.deepEqual(provider.availability(), { ok: true });
});

test("酒店报价：金额 = 单价 × 晚数，extra 带价格来源", async () => {
  const result = await provider.search(
    searchQuery({
      type: "hotel",
      city: "成都",
      hotelName: "亚朵酒店",
      checkInDate: "2026-10-01",
      checkOutDate: "2026-10-03",
      tier: "mid",
    }),
    ctx,
  );
  assert.ok(result.ok);
  assert.equal(result.options.length, 1);
  const option = result.options[0];
  assert.ok((option.amountCny ?? 0) > 0, "两天应折算总价");
  assert.equal(option.extra?.checkInDate, "2026-10-01");
  assert.ok(["api", "database", "estimated", "list"].includes(String(option.extra?.priceSource)));
});

test("机票：按基准价估算；缺基准价时明确报错引导", async () => {
  const ok = await provider.search(
    searchQuery({ type: "flight", code: "MU5107", from: "北京", to: "上海", departTime: "2026-10-01 08:30", basePriceCny: 1200 }),
    ctx,
  );
  assert.ok(ok.ok);
  assert.equal(ok.options[0].amountCny, 1200);
  assert.equal(ok.options[0].extra?.priceSource, "estimated");

  const missing = await provider.search(
    searchQuery({ type: "flight", code: "MU5107" }),
    ctx,
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes("basePriceCny"));
});

test("book → 支付 → 出票：状态机推进且收银台链接透传", async () => {
  const search = await provider.search(
    searchQuery({ type: "flight", code: "MU5107", departTime: "2026-10-01 08:30", basePriceCny: 1200 }),
    ctx,
  );
  assert.ok(search.ok);
  const option = search.options[0];

  const draft: BookingDraft = {
    domain: "travel",
    provider: provider.key,
    optionId: option.id,
    title: option.title,
    amountCny: option.amountCny,
    scheduleAt: option.scheduleAt ?? null,
    summary: "测试订单",
    params: { type: "flight", code: "MU5107", cashierUrl: "https://qr.alipay.com/test-xxx" },
  };
  const booked = await provider.book(draft, ctx);
  assert.ok(booked.ok);
  assert.equal(booked.status, "pending_payment");
  assert.equal(booked.paymentUrl, "https://qr.alipay.com/test-xxx");
  const orderId = booked.providerOrderId!;

  // 支付前 getStatus：pending_payment
  const before = await provider.getStatus({ provider: provider.key, providerOrderId: orderId }, ctx);
  assert.ok(before.ok);
  assert.equal(before.status, "pending_payment");

  // markPaid → confirmed；markIssued → in_progress 且 tracking 带票夹 id
  assert.equal(provider.markPaid(orderId), true);
  const paid = await provider.getStatus({ provider: provider.key, providerOrderId: orderId }, ctx);
  assert.equal(paid.status, "confirmed");

  assert.equal(provider.markIssued(orderId, "ticket-42"), true);
  const issued = await provider.getStatus({ provider: provider.key, providerOrderId: orderId }, ctx);
  assert.equal(issued.status, "in_progress");
  assert.equal((issued.tracking as Record<string, unknown> | undefined)?.ticketId, "ticket-42");

  // 已出票订单不允许 provider 侧取消
  const cancelled = await provider.cancel({ provider: provider.key, providerOrderId: orderId }, "不需要了", ctx);
  assert.equal(cancelled.ok, false);
});

test("未知 providerOrderId 的 getStatus 交回本地快照兜底", async () => {
  const ghost = await provider.getStatus({ provider: provider.key, providerOrderId: "tt_nonexistent" }, ctx);
  assert.ok(ghost.ok);
  assert.equal(ghost.status, undefined);
});

// --------------------------------------------------------------------------- //
// 退改工单（requestRefund）：两阶段确认 + 不代办真实退改
// --------------------------------------------------------------------------- //

async function withTravelOrder(status: "pending_payment" | "confirmed" | "in_progress" | "completed") {
  const store = new BookingOrderStore(null);
  const service = new BookingService({
    providers: [provider],
    store,
    config: { mode: "mock", maxAmountCny: 5000, dailyBudgetCny: 0, confirmationTtlMs: 300_000 },
  });
  const toolCtx: ToolContext = { sessionId: "s-refund", userId: "u-refund" };
  await store.create({
    orderId: "bkg_refund_test",
    actorId: "u-refund",
    domain: "travel",
    provider: provider.key,
    providerOrderId: "tt_refund_test",
    title: "航班 MU5107 北京→上海 经济舱",
    amountCny: 1200,
    status,
    scheduleAt: "2026-10-01T08:30:00+08:00",
    deadline: null,
    params: { type: "flight", code: "MU5107", cashierUrl: "https://example.com/cashier" },
    paymentUrl: null,
    commitmentId: null,
    simulated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { service, store, toolCtx };
}

test("退改工单：未支付订单拒绝立单并引导取消", async () => {
  const { service, toolCtx } = await withTravelOrder("pending_payment");
  const res = await service.requestRefund(toolCtx, "travel", "bkg_refund_test", { kind: "refund", confirm: false });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /尚未支付/);
});

test("退改工单：已完成订单拒绝立单", async () => {
  const { service, toolCtx } = await withTravelOrder("completed");
  const res = await service.requestRefund(toolCtx, "travel", "bkg_refund_test", { kind: "refund", confirm: false });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /已完成/);
});

test("退改工单：两阶段确认 → 工单落库 + 导航指引（不代办真实退改）", async () => {
  const { service, store, toolCtx } = await withTravelOrder("in_progress");

  // 阶段一：摘要 + token，明确「真实退改在原平台办理」
  const stage1 = await service.requestRefund(toolCtx, "travel", "bkg_refund_test", {
    kind: "change",
    reason: "行程变更",
    confirm: false,
  });
  assert.equal(stage1.ok, true);
  const s1 = stage1 as { needsConfirmation: boolean; confirmationToken: string; summary: string };
  assert.equal(s1.needsConfirmation, true);
  assert.ok(s1.confirmationToken);
  assert.match(s1.summary, /改签/);
  assert.match(s1.summary, /原下单平台办理/);

  // 阶段二缺 token → 拒绝
  const noToken = await service.requestRefund(toolCtx, "travel", "bkg_refund_test", { kind: "change", confirm: true });
  assert.equal(noToken.ok, false);

  // 阶段二：工单写入订单 params.refundTickets，返回导航指引
  const stage2 = await service.requestRefund(toolCtx, "travel", "bkg_refund_test", {
    kind: "change",
    reason: "行程变更",
    confirm: true,
    confirmationToken: s1.confirmationToken,
  });
  assert.equal(stage2.ok, true);
  const s2 = stage2 as {
    ticketId: string;
    navigation: { platformHint: string; cashierUrl: string | null };
    note: string;
  };
  assert.match(s2.ticketId, /^rft_/);
  assert.match(s2.navigation.platformHint, /agent_browser/);
  assert.match(s2.navigation.platformHint, /用户本人/);
  assert.equal(s2.navigation.cashierUrl, "https://example.com/cashier");
  assert.match(s2.note, /平台规则/);

  const order = await store.get("bkg_refund_test");
  const tickets = order?.params.refundTickets as Array<Record<string, unknown>>;
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].kind, "change");
  assert.equal(tickets[0].reason, "行程变更");
  assert.equal(tickets[0].status, "pending_user");
  // 订单本身状态不因工单改变（真实退改在平台完成后由用户/平台侧同步）
  assert.equal(order?.status, "in_progress");
});
