import assert from "node:assert/strict";
import test from "node:test";

import type { BookingDraft, BookingSearchQuery } from "../src/services/booking/booking-provider.js";
import { TravelTicketProvider } from "../src/services/booking/providers/travel-ticket-provider.js";

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
