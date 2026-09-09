/**
 * 旅行票务黄金链路端到端测试（服务层闭环，无网络/无 Playwright）。
 *
 * 覆盖链路：
 *   多源报价比价（local 保底 + MCP 桩 + 浏览器代查桩，价格升序 + 来源如实标注）
 *   → TravelTicketProvider.search 透出多源选项
 *   → BookingService 两阶段下单（cashierUrl 随订单落库 → paymentUrl 透出）
 *   → 支付推进 confirmed → 出票 in_progress（票夹 id 进 tracking）
 *   → requestRefund 两阶段立退改工单（不代办真实退改）
 *
 * 真实外部源（RollingGo MCP / 携程代查）在 CI 不可用，用同形桩验证聚合契约；
 * 桩返回结构与 site-adapters 的解析口径一致。
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ToolContext } from "../src/tools/tool-registry.js";
import {
  buildQuoteAggregator,
  LocalQuoteSource,
  McpQuoteSource,
  BrowserQuoteSource,
  type McpCaller,
  type BrowserRunner,
} from "../src/services/booking/quote/index.js";
import { TravelTicketProvider } from "../src/services/booking/providers/travel-ticket-provider.js";
import { BookingService } from "../src/services/booking/booking-service.js";
import { BookingOrderStore } from "../src/services/booking/booking-order-store.js";

const toolCtx: ToolContext = { sessionId: "golden-path", userId: "u-golden" };

// ── 桩：RollingGo 酒店 MCP（返回低于本地价格库的实时价） ──

const hotelMcpStub: McpCaller = {
  listServers: () => [{ alias: "rollinggo", enabled: true }],
  callTool: async () => ({
    ok: true,
    result: {
      hotels: [
        { name: "成都春熙路亚朵酒店", minPrice: 420 },
        { name: "无价格的脏数据酒店" },
      ],
    },
  }),
};

// ── 桩：浏览器代查·携程机票（页面文本 → parseCtripFlightText 解析） ──

const flightBrowserStub: BrowserRunner = {
  open: async () => ({ ok: true, sessionId: "sess-1" }),
  extractText: async () => ({
    ok: true,
    text: "东方航空 MU5107 空客320(中) 08:00 首都机场T2 ¥530 起 海南航空 HU7613 09:30 虹桥T1 ¥610 起",
  }),
  close: async () => ({ ok: true }),
};

function buildStubAggregator() {
  return buildQuoteAggregator({
    sources: [
      new LocalQuoteSource(),
      new McpQuoteSource(hotelMcpStub, {
        id: "mcp.rollinggo",
        label: "RollingGo 酒店（实时API）",
        serverAlias: "rollinggo",
        toolName: "searchHotels",
        supports: (t) => t === "hotel",
        mapRequest: (req) => (req.city ? { city: req.city } : null),
        parseResult: (raw) => {
          const list = Array.isArray(raw.hotels) ? (raw.hotels as Array<Record<string, unknown>>) : [];
          return list
            .filter((h) => typeof h.name === "string" && typeof h.minPrice === "number")
            .map((h) => ({
              source: "mcp.rollinggo",
              sourceLabel: "RollingGo 酒店（实时API）",
              type: "hotel" as const,
              name: h.name as string,
              amountCny: h.minPrice as number,
              nights: 1,
              currency: "CNY" as const,
              priceSource: "api" as const,
              note: "RollingGo 实时报价，最终以下单页为准",
              fetchedAt: Date.now(),
            }));
        },
      }),
      new BrowserQuoteSource(flightBrowserStub, {
        id: "browser.ctrip",
        label: "浏览器代查·携程机票",
        supports: (t) => t === "flight",
        buildUrl: (req) => (req.from && req.to ? `https://flights.ctrip.com/online/list/${req.from}-${req.to}` : null),
        parseText: (text) => {
          const re = /([A-Z]{2}\d{3,4})[\s\S]{0,120}?¥\s*(\d{2,5})/g;
          const quotes = [];
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            quotes.push({
              source: "browser.ctrip",
              sourceLabel: "浏览器代查·携程机票",
              type: "flight" as const,
              code: m[1],
              amountCny: Number(m[2]),
              currency: "CNY" as const,
              priceSource: "scraped" as const,
              note: "携程列表页代查价，以平台实价为准",
              fetchedAt: Date.now(),
            });
          }
          return quotes;
        },
        settleMs: 0,
      }),
    ],
  });
}

test("黄金链路①：酒店多源比价——实时 API 价与本地库价并存、价格升序、来源如实标注", async () => {
  const provider = new TravelTicketProvider({ quoteAggregator: buildStubAggregator() });
  const res = await provider.search(
    { domain: "travel", params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid" } },
    { actorId: "u-golden", location: null, toolContext: toolCtx },
  );
  assert.ok(res.ok);
  assert.ok(res.options.length >= 2, "MCP 实时价 + 本地库价至少两条");
  const prices = res.options.map((o) => o.amountCny ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "比价列表按价格升序");
  const sources = new Set(res.options.map((o) => (o.extra as Record<string, unknown>).priceSource));
  assert.ok(sources.has("api"), "含实时 API 价");
  assert.ok([...sources].some((s) => s === "database" || s === "list" || s === "estimated"), "含本地库价");
  assert.ok(res.note, "汇总说明非空");
});

test("黄金链路②：机票浏览器代查价 + 基准价估算并存", async () => {
  const provider = new TravelTicketProvider({ quoteAggregator: buildStubAggregator() });
  const res = await provider.search(
    { domain: "travel", params: { type: "flight", code: "MU5107", from: "北京", to: "上海", departTime: "2026-10-01", basePriceCny: 1200 } },
    { actorId: "u-golden", location: null, toolContext: toolCtx },
  );
  assert.ok(res.ok);
  const scraped = res.options.filter((o) => (o.extra as Record<string, unknown>).priceSource === "scraped");
  assert.ok(scraped.length >= 2, "浏览器源解析出 MU5107 与 HU7613");
  assert.equal(scraped[0].amountCny, 530, "最低 scraped 价排前");
  assert.ok(res.options.some((o) => (o.extra as Record<string, unknown>).priceSource === "estimated"));
});

test("黄金链路③：search → 两阶段 book → 支付 → 出票 → 退改工单（全链路）", async () => {
  const provider = new TravelTicketProvider({ quoteAggregator: buildStubAggregator() });
  const store = new BookingOrderStore(null);
  const service = new BookingService({
    providers: [provider],
    store,
    config: { mode: "mock", maxAmountCny: 5000, dailyBudgetCny: 0, confirmationTtlMs: 300_000 },
  });

  // 1. 多源比价
  const search = await service.search(toolCtx, "travel", {
    city: "成都",
    params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid" },
  });
  assert.equal(search.ok, true);
  type SearchOpts = { options: Array<{ id: string; amountCny: number | null }> };
  const cheapest = (search as SearchOpts).options[0];

  // 2. 下单阶段一：摘要 + token（含价格来源）
  const stage1 = (await service.book(toolCtx, "travel", {
    optionId: cheapest.id,
    params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid", cashierUrl: "https://pay.example.com/cashier/abc" },
    confirm: false,
  })) as { needsConfirmation: boolean; confirmationToken: string; summary: string };
  assert.equal(stage1.needsConfirmation, true);
  assert.match(stage1.summary, /¥/);

  // 3. 下单阶段二：待支付订单 + 收银台链接透出
  const booked = (await service.book(toolCtx, "travel", {
    optionId: cheapest.id,
    params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid", cashierUrl: "https://pay.example.com/cashier/abc" },
    confirm: true,
    confirmationToken: stage1.confirmationToken,
  })) as { orderId: string; status: string; paymentUrl: string | null; providerOrderId: string | null };
  assert.equal(booked.status, "pending_payment");
  assert.equal(booked.paymentUrl, "https://pay.example.com/cashier/abc");

  // 4. 支付成功推进（travel-pay skill 内部同款调用）→ confirmed
  assert.equal(provider.markPaid(booked.providerOrderId!), true);
  await store.update(booked.orderId, { status: "confirmed" });

  // 5. 出票 → in_progress，票夹 id 进 tracking
  assert.equal(provider.markIssued(booked.providerOrderId!, "tkt-golden-1"), true);
  await store.update(booked.orderId, { status: "in_progress" });
  const status = (await service.getStatus(toolCtx, "travel", booked.orderId)) as {
    order: { status: string };
    tracking?: Record<string, unknown>;
  };
  assert.equal(status.order.status, "in_progress");
  assert.equal(status.tracking?.ticketId, "tkt-golden-1");

  // 6. 已出票订单不能直接取消（阶段二 provider 拒绝，引导退改工单）
  const cancel1 = (await service.cancel(toolCtx, "travel", booked.orderId, false)) as { confirmationToken: string };
  assert.ok(cancel1.confirmationToken);
  const cancelBlocked = await service.cancel(toolCtx, "travel", booked.orderId, true, cancel1.confirmationToken);
  assert.equal(cancelBlocked.ok, false);
  assert.match((cancelBlocked as { error: string }).error, /已出票|原平台/);

  // 7. 退改工单：两阶段立单 + 导航（Agent 不代办真实退改）
  const refund1 = (await service.requestRefund(toolCtx, "travel", booked.orderId, { kind: "refund", reason: "行程取消", confirm: false })) as {
    confirmationToken: string;
  };
  const refund2 = (await service.requestRefund(toolCtx, "travel", booked.orderId, {
    kind: "refund",
    reason: "行程取消",
    confirm: true,
    confirmationToken: refund1.confirmationToken,
  })) as { ticketId: string; navigation: { platformHint: string } };
  assert.match(refund2.ticketId, /^rft_/);
  assert.match(refund2.navigation.platformHint, /用户本人/);
  const finalOrder = await store.get(booked.orderId);
  assert.equal((finalOrder?.params.refundTickets as Array<unknown>).length, 1);
});
