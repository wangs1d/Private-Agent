/**
 * 旅行票务黄金链路端到端测试（服务层闭环，无网络/无 Playwright/无 flyai CLI）。
 *
 * 覆盖链路：
 *   多源报价比价（local 保底 + 飞猪 FlyAI CLI 桩 + 浏览器代查桩，价格升序 + 来源如实标注）
 *   → TravelTicketProvider.search 透出多源选项（实时来源带 extra.bookingUrl 预订链接）
 *   → BookingService 两阶段下单（flyai bookingUrl 作 cashierUrl 随订单落库 → paymentUrl 透出）
 *   → 支付推进 confirmed → 出票 in_progress（票夹 id 进 tracking）
 *   → requestRefund 两阶段立退改工单（不代办真实退改）
 *
 * 真实外部源（飞猪 FlyAI CLI / 携程代查）在 CI 不可用，用同形桩验证聚合契约；
 * FlyAI 桩返回结构与官方文档（flyai search-hotel / search-flight）的 data.itemList 一致。
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ToolContext } from "../src/tools/tool-registry.js";
import {
  buildQuoteAggregator,
  type FlyAiRunner,
  type BrowserRunner,
} from "../src/services/booking/quote/index.js";
import { TravelTicketProvider } from "../src/services/booking/providers/travel-ticket-provider.js";
import { BookingService } from "../src/services/booking/booking-service.js";
import { BookingOrderStore } from "../src/services/booking/booking-order-store.js";

const toolCtx: ToolContext = { sessionId: "golden-path", userId: "u-golden" };

// ── 桩：飞猪 FlyAI CLI（官方 search-hotel / search-flight 同形 JSON） ──

const FLYAI_HOTEL_JSON = {
  status: 0,
  message: "success",
  systemMessage: "",
  data: {
    itemList: [
      {
        name: "成都春熙路亚朵酒店",
        brandName: "亚朵",
        address: "成都市锦江区春熙路99号",
        price: "¥399",
        star: "豪华型",
        score: "5.0",
        scoreDesc: "超棒",
        rate: "4.8",
        mainPic: "https://img.alicdn.com/imgextra/i2/O1CN01zsMaHe1TM8cxIg1gf_!!4611686018427382079-0-fliggy_content_upload_image.jpg",
        detailUrl: "https://h5.m.fliggy.com/hotel-detail?shId=1001001",
        shId: "1001001",
      },
      { name: "无价格脏数据酒店" },
      { name: "体验模式脱敏酒店", price: "¥2x", detailUrl: "https://h5.m.fliggy.com/hotel-detail?shId=masked" },
    ],
  },
};

const FLYAI_FLIGHT_JSON = {
  status: 0,
  message: "success",
  systemMessage: "",
  data: {
    itemList: [
      {
        adultPrice: "¥400.0",
        totalDuration: "140分钟",
        jumpUrl: "https://h5.m.fliggy.com/flight-booking?orderToken=fly-e2e",
        journeys: [
          {
            journeyType: "直达",
            totalDuration: "140分钟",
            segments: [
              {
                depCityName: "北京",
                depStationName: "首都国际机场T3",
                depTerm: "T3",
                depDateTime: "2026-10-01 08:00",
                depWeekAbbrName: "周四",
                arrCityName: "上海",
                arrStationName: "上海虹桥T2",
                arrTerm: "T2",
                arrDateTime: "2026-10-01 10:20",
                arrWeekAbbrName: "周四",
                duration: "140分钟",
                transportType: "飞机",
                marketingTransportName: "国航",
                marketingTransportNo: "CA1883",
                seatClassName: "经济舱",
              },
            ],
          },
        ],
      },
    ],
  },
};

const flyaiRunnerStub: FlyAiRunner = async (args) => {
  const payload =
    args[0] === "search-hotel" ? FLYAI_HOTEL_JSON : args[0] === "search-flight" ? FLYAI_FLIGHT_JSON : null;
  if (!payload) return { ok: false, stdout: "", stderr: `未知子命令 ${String(args[0])}` };
  return { ok: true, stdout: JSON.stringify(payload) };
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
  // 走工厂默认装配（local + flyai 酒店/机票 + 浏览器代查），只注入桩 runner
  return buildQuoteAggregator({ flyAiRunner: flyaiRunnerStub, browserRunner: flightBrowserStub });
}

test("黄金链路①：酒店多源比价——飞猪实时价与本地库价并存、价格升序、来源如实标注", async () => {
  const provider = new TravelTicketProvider({ quoteAggregator: buildStubAggregator() });
  const res = await provider.search(
    { domain: "travel", params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid" } },
    { actorId: "u-golden", location: null, toolContext: toolCtx },
  );
  assert.ok(res.ok);
  assert.ok(res.options.length >= 2, "飞猪实时价 + 本地库价至少两条");
  const prices = res.options.map((o) => o.amountCny ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "比价列表按价格升序");
  const sources = new Set(res.options.map((o) => (o.extra as Record<string, unknown>).priceSource));
  assert.ok(sources.has("api"), "含飞猪实时 API 价");
  assert.ok([...sources].some((s) => s === "database" || s === "list" || s === "estimated"), "含本地库价");
  const apiOpt = res.options.find((o) => (o.extra as Record<string, unknown>).priceSource === "api");
  assert.match(String((apiOpt!.extra as Record<string, unknown>).bookingUrl), /fliggy\.com/, "飞猪选项带预订链接");
  assert.match(
    String((apiOpt!.extra as Record<string, unknown>).mainPicUrl),
    /alicdn\.com/,
    "飞猪选项带平台真实主图",
  );
  assert.equal((apiOpt!.extra as Record<string, unknown>).rating, 4.8, "飞猪选项带平台评分");
  assert.ok(res.note, "汇总说明非空");
});

test("黄金链路②：机票——飞猪实时价 + 浏览器代查价 + 基准价估算并存", async () => {
  const provider = new TravelTicketProvider({ quoteAggregator: buildStubAggregator() });
  const res = await provider.search(
    { domain: "travel", params: { type: "flight", from: "北京", to: "上海", departTime: "2026-10-01", basePriceCny: 1200 } },
    { actorId: "u-golden", location: null, toolContext: toolCtx },
  );
  assert.ok(res.ok);
  const api = res.options.filter((o) => (o.extra as Record<string, unknown>).priceSource === "api");
  assert.equal(api.length, 1, "flyai 解析出 CA1883");
  assert.equal(api[0].amountCny, 400, "飞猪价 ¥400 最低");
  assert.equal((api[0].extra as Record<string, unknown>).code, "CA1883");
  assert.match(String((api[0].extra as Record<string, unknown>).bookingUrl), /fliggy\.com/, "机票选项带预订链接");
  const scraped = res.options.filter((o) => (o.extra as Record<string, unknown>).priceSource === "scraped");
  assert.ok(scraped.length >= 2, "浏览器源解析出 MU5107 与 HU7613");
  assert.equal(scraped[0].amountCny, 530, "最低 scraped 价排前");
  assert.ok(res.options.some((o) => (o.extra as Record<string, unknown>).priceSource === "estimated"));
});

test("黄金链路③：酒店 search → 两阶段 book（flyai bookingUrl 作 cashierUrl）→ 支付 → 出票 → 退改工单", async () => {
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
  type SearchOpts = { options: Array<{ id: string; amountCny: number | null; extra: Record<string, unknown> }> };
  const cheapest = (search as SearchOpts).options[0];
  const bookingUrl = String(cheapest.extra.bookingUrl ?? "");
  assert.match(bookingUrl, /fliggy\.com/, "飞猪 detailUrl 作为预订链接透出");

  // 2. 下单阶段一：摘要 + token（含价格来源）
  const stage1 = (await service.book(toolCtx, "travel", {
    optionId: cheapest.id,
    params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid", cashierUrl: bookingUrl },
    confirm: false,
  })) as { needsConfirmation: boolean; confirmationToken: string; summary: string };
  assert.equal(stage1.needsConfirmation, true);
  assert.match(stage1.summary, /¥/);

  // 3. 下单阶段二：待支付订单 + 飞猪预订链接透出为 paymentUrl
  const booked = (await service.book(toolCtx, "travel", {
    optionId: cheapest.id,
    params: { type: "hotel", city: "成都", hotelName: "成都春熙路亚朵酒店", checkInDate: "2026-10-01", tier: "mid", cashierUrl: bookingUrl },
    confirm: true,
    confirmationToken: stage1.confirmationToken,
  })) as { orderId: string; status: string; paymentUrl: string | null; providerOrderId: string | null };
  assert.equal(booked.status, "pending_payment");
  assert.equal(booked.paymentUrl, bookingUrl);

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

test("黄金链路④：机票——飞猪实时价选项两阶段下单 → 支付 → 出票（jumpUrl 落库 paymentUrl）", async () => {
  const provider = new TravelTicketProvider({ quoteAggregator: buildStubAggregator() });
  const store = new BookingOrderStore(null);
  const service = new BookingService({
    providers: [provider],
    store,
    config: { mode: "mock", maxAmountCny: 5000, dailyBudgetCny: 0, confirmationTtlMs: 300_000 },
  });

  const searchParams = { type: "flight", from: "北京", to: "上海", departTime: "2026-10-01", basePriceCny: 1200 };
  const search = await service.search(toolCtx, "travel", { params: searchParams });
  assert.equal(search.ok, true);
  type Opt = { id: string; amountCny: number | null; extra: Record<string, unknown> };
  const flyaiOpt = (search as { options: Opt[] }).options.find((o) => o.extra.quoteSource === "flyai.flight");
  assert.ok(flyaiOpt, "飞猪机票报价在选项中");
  assert.equal(flyaiOpt!.amountCny, 400);

  // 两阶段下单，cashierUrl = 飞猪 jumpUrl
  const stage1 = (await service.book(toolCtx, "travel", {
    optionId: flyaiOpt!.id,
    params: { ...searchParams, cashierUrl: String(flyaiOpt!.extra.bookingUrl) },
    confirm: false,
  })) as { needsConfirmation: boolean; confirmationToken: string; summary: string };
  assert.equal(stage1.needsConfirmation, true);
  assert.match(stage1.summary, /CA1883|400/);

  const booked = (await service.book(toolCtx, "travel", {
    optionId: flyaiOpt!.id,
    params: { ...searchParams, cashierUrl: String(flyaiOpt!.extra.bookingUrl) },
    confirm: true,
    confirmationToken: stage1.confirmationToken,
  })) as { orderId: string; status: string; paymentUrl: string | null; providerOrderId: string | null };
  assert.equal(booked.status, "pending_payment");
  assert.equal(booked.paymentUrl, "https://h5.m.fliggy.com/flight-booking?orderToken=fly-e2e");

  assert.equal(provider.markPaid(booked.providerOrderId!), true);
  await store.update(booked.orderId, { status: "confirmed" });
  assert.equal(provider.markIssued(booked.providerOrderId!, "tkt-golden-flt-1"), true);
  await store.update(booked.orderId, { status: "in_progress" });

  const status = (await service.getStatus(toolCtx, "travel", booked.orderId)) as {
    order: { status: string };
    tracking?: Record<string, unknown>;
  };
  assert.equal(status.order.status, "in_progress");
  assert.equal(status.tracking?.ticketId, "tkt-golden-flt-1");
});

test("黄金链路⑤：体验模式脱敏价——「¥2x」绝不当实价，机票无价时源如实报错", async () => {
  const trialMsg = "*当前为体验模式，部分搜索结果可能受限，请前往飞猪AI开放平台获取正式API Key解锁完整服务。*";
  const trialRunner: FlyAiRunner = async (args) => {
    const payload =
      args[0] === "search-hotel"
        ? {
            status: 0,
            message: "success",
            systemMessage: trialMsg,
            data: {
              itemList: [
                { name: "脱敏价酒店", price: "¥2x", detailUrl: "https://h5.m.fliggy.com/hotel-detail?shId=masked" },
                { name: "正常价酒店", price: "¥388", detailUrl: "https://h5.m.fliggy.com/hotel-detail?shId=ok" },
              ],
            },
          }
        : {
            status: 0,
            message: "success",
            systemMessage: trialMsg,
            data: {
              itemList: [
                {
                  adultPrice: null,
                  jumpUrl: "https://h5.m.fliggy.com/flight-booking?orderToken=masked",
                  journeys: [
                    {
                      segments: [
                        {
                          marketingTransportNo: "CA1883",
                          depCityName: "北京",
                          arrCityName: "上海",
                          depDateTime: "2026-10-01 08:00",
                          arrDateTime: "2026-10-01 10:20",
                          seatClassName: "经济舱",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          };
    return { ok: true, stdout: JSON.stringify(payload) };
  };
  const aggregator = buildQuoteAggregator({ flyAiRunner: trialRunner });

  // 酒店：脱敏行丢弃、完整数字价保留，note 如实标注体验模式
  const hotel = await aggregator.aggregate({ type: "hotel", city: "成都", checkInDate: "2026-10-01" }, toolCtx);
  const flyaiHotel = hotel.quotes.filter((q) => q.source === "flyai.hotel");
  assert.equal(flyaiHotel.length, 1, "只保留完整数字价的行（¥2x 不算 ¥2）");
  assert.equal(flyaiHotel[0].name, "正常价酒店");
  assert.equal(flyaiHotel[0].amountCny, 388);
  assert.match(flyaiHotel[0].note ?? "", /体验模式/);

  // 机票：体验模式 adultPrice=null → 全部跳过 → 源如实报错（绝不编造）
  const flight = await aggregator.aggregate({ type: "flight", from: "北京", to: "上海", departTime: "2026-10-01" }, toolCtx);
  const flyaiFlight = flight.sources.find((s) => s.source === "flyai.flight");
  assert.equal(flyaiFlight?.ok, false);
  assert.match(flyaiFlight?.error ?? "", /体验模式.*脱敏/);
});
