/**
 * Mock 验证脚本：飞猪 FlyAI 报价源接入后的酒店/机票预订闭环。
 *
 * 装配是真实的（buildQuoteAggregator 默认源集 + TravelTicketProvider + BookingService
 * mock 支付模式），只有 flyai CLI 执行器换成桩（返回官方文档同形 JSON），不出网。
 *
 * 用法：cd server && npx tsx scripts/verify-flyai-booking-mock.ts
 *
 * 验证点：
 *   ① 酒店链：search（flyai api 价 + 本地库价比价）→ 两阶段 book（detailUrl 作
 *      cashierUrl 落库 paymentUrl）→ 支付 confirmed → 出票 in_progress
 *   ② 机票链：search（flyai api 价 + 浏览器代查桩 + 估算）→ 两阶段 book（jumpUrl
 *      落库 paymentUrl）→ 支付 confirmed → 出票 in_progress
 *   ③ 诚实降级探针：flyai CLI 未安装时该源如实报错、订单链不受影响、绝不编造报价
 */

import type { ToolContext } from "../src/tools/tool-registry.js";
import {
  buildQuoteAggregator,
  type FlyAiRunner,
  type BrowserRunner,
} from "../src/services/booking/quote/index.js";
import { TravelTicketProvider } from "../src/services/booking/providers/travel-ticket-provider.js";
import { BookingService } from "../src/services/booking/booking-service.js";
import { BookingOrderStore } from "../src/services/booking/booking-order-store.js";

const toolCtx: ToolContext = { sessionId: "verify-flyai", userId: "u-verify" };

// ── 飞猪 FlyAI CLI 桩（官方 search-hotel / search-flight 同形 JSON） ──

const FLYAI_HOTEL_JSON = {
  status: 0,
  message: "success",
  systemMessage: "",
  data: {
    itemList: [
      {
        name: "三亚亚特兰蒂斯酒店",
        brandName: "亚特兰蒂斯",
        address: "三亚市海棠湾",
        price: "¥1688",
        star: "豪华型",
        score: "4.8",
        detailUrl: "https://h5.m.fliggy.com/hotel-detail?shId=2002002",
        shId: "2002002",
      },
      {
        name: "三亚湾红树林度假酒店",
        brandName: "红树林",
        address: "三亚市三亚湾路",
        price: "¥456",
        star: "高档型",
        score: "4.7",
        detailUrl: "https://h5.m.fliggy.com/hotel-detail?shId=2002003",
        shId: "2002003",
      },
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
        adultPrice: "¥730.0",
        totalDuration: "165分钟",
        jumpUrl: "https://h5.m.fliggy.com/flight-booking?orderToken=fly-verify-730",
        journeys: [
          {
            journeyType: "直达",
            totalDuration: "165分钟",
            segments: [
              {
                depCityName: "北京",
                depStationName: "大兴机场",
                depTerm: "D",
                depDateTime: "2026-10-02 09:30",
                arrCityName: "三亚",
                arrStationName: "凤凰机场",
                arrTerm: "T1",
                arrDateTime: "2026-10-02 13:35",
                duration: "165分钟",
                transportType: "飞机",
                marketingTransportName: "南方航空",
                marketingTransportNo: "CZ6712",
                seatClassName: "经济舱",
              },
            ],
          },
        ],
      },
    ],
  },
};

function makeFlyAiStub(): FlyAiRunner {
  return async (args) => {
    const payload =
      args[0] === "search-hotel" ? FLYAI_HOTEL_JSON : args[0] === "search-flight" ? FLYAI_FLIGHT_JSON : null;
    if (!payload) return { ok: false, stdout: "", stderr: `未知子命令 ${String(args[0])}` };
    console.log(`  [flyai 桩] ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
    return { ok: true, stdout: JSON.stringify(payload) };
  };
}

// ── 浏览器代查桩（机票 scraped 源，验证多源并存） ──

const browserStub: BrowserRunner = {
  open: async () => ({ ok: true, sessionId: "verify-sess" }),
  extractText: async () => ({ ok: true, text: "厦门航空 MF8388 11:20 大兴机场 ¥820 起" }),
  close: async () => ({ ok: true }),
};

function buildService(flyai: FlyAiRunner) {
  const aggregator = buildQuoteAggregator({ flyAiRunner: flyai, browserRunner: browserStub });
  const provider = new TravelTicketProvider({ quoteAggregator: aggregator });
  const store = new BookingOrderStore(null);
  const service = new BookingService({
    providers: [provider],
    store,
    config: { mode: "mock", maxAmountCny: 20000, dailyBudgetCny: 0, confirmationTtlMs: 300_000 },
  });
  return { provider, store, service };
}

interface Opt {
  id: string;
  title: string;
  amountCny: number | null;
  extra: Record<string, unknown>;
}

function printOptions(opts: Opt[]) {
  for (const o of opts) {
    console.log(
      `    - ${o.title} ¥${o.amountCny} [${o.extra.priceSource}/${o.extra.quoteSource}]${
        o.extra.bookingUrl ? ` bookingUrl=${o.extra.bookingUrl}` : ""
      }`,
    );
  }
}

async function bookTwoStage(
  service: BookingService,
  provider: TravelTicketProvider,
  store: BookingOrderStore,
  opt: Opt,
  params: Record<string, unknown>,
  expectTicketId: string,
): Promise<boolean> {
  const stage1 = (await service.book(toolCtx, "travel", {
    optionId: opt.id,
    params: { ...params, cashierUrl: String(opt.extra.bookingUrl) },
    confirm: false,
  })) as { needsConfirmation: boolean; confirmationToken: string; summary: string };
  if (!stage1.needsConfirmation || !stage1.confirmationToken) {
    console.error(`  FAIL: 阶段一未返回确认 token：${JSON.stringify(stage1).slice(0, 300)}`);
    return false;
  }
  console.log(`  阶段一摘要：${stage1.summary.slice(0, 160)}`);

  const booked = (await service.book(toolCtx, "travel", {
    optionId: opt.id,
    params: { ...params, cashierUrl: String(opt.extra.bookingUrl) },
    confirm: true,
    confirmationToken: stage1.confirmationToken,
  })) as { orderId: string; status: string; paymentUrl: string | null; providerOrderId: string | null };
  if (booked.status !== "pending_payment") {
    console.error(`  FAIL: 阶段二状态非 pending_payment：${JSON.stringify(booked).slice(0, 300)}`);
    return false;
  }
  const okUrl = booked.paymentUrl === String(opt.extra.bookingUrl);
  console.log(
    `  阶段二订单：${booked.orderId}（pending_payment），paymentUrl=${booked.paymentUrl} ${
      okUrl ? "✓ bookingUrl 已落库" : `✗ 期望 ${opt.extra.bookingUrl}`
    }`,
  );
  if (!okUrl || !booked.providerOrderId) return false;

  if (!provider.markPaid(booked.providerOrderId)) {
    console.error("  FAIL: markPaid 未推进（confirmed）");
    return false;
  }
  await store.update(booked.orderId, { status: "confirmed" });
  if (!provider.markIssued(booked.providerOrderId, expectTicketId)) {
    console.error("  FAIL: markIssued 未推进（in_progress）");
    return false;
  }
  await store.update(booked.orderId, { status: "in_progress" });

  const status = (await service.getStatus(toolCtx, "travel", booked.orderId)) as {
    order: { status: string };
    tracking?: Record<string, unknown>;
  };
  const ok =
    status.order.status === "in_progress" && (status.tracking?.ticketId as string | undefined) === expectTicketId;
  console.log(
    `  支付→出票：order.status=${status.order.status}，ticketId=${status.tracking?.ticketId} ${ok ? "✓" : "✗"}`,
  );
  return ok;
}

async function main() {
  // keep-alive：BrowserQuoteSource 的 settle 等时器是 unref 的，脚本若只等它
  // 事件循环会清空导致进程提前以 0 退出（node --test 场景无此问题）
  const keepAlive = setInterval(() => {}, 2 ** 30);
  let pass = true;

  // ① 酒店链
  console.log("\n═══ 链路①：酒店（search 比价 → 两阶段 book → 支付 → 出票） ═══");
  {
    const { provider, store, service } = buildService(makeFlyAiStub());
    const search = (await service.search(toolCtx, "travel", {
      city: "三亚",
      params: { type: "hotel", city: "三亚", checkInDate: "2026-10-02", checkOutDate: "2026-10-04", tier: "mid" },
    })) as { ok: boolean; options: Opt[]; note?: string };
    console.log(`  search 比价结果（升序）：`);
    printOptions(search.options);
    console.log(`  汇总：${search.note ?? "（无）"}`);
    const flyaiOpts = search.options.filter((o) => o.extra.quoteSource === "flyai.hotel");
    if (search.ok && flyaiOpts.length === 2 && flyaiOpts[0].extra.priceSource === "api") {
      const cheapest = flyaiOpts[0];
      console.log(`  选最低飞猪价：${cheapest.title} ¥${cheapest.amountCny}`);
      pass =
        (await bookTwoStage(service, provider, store, cheapest, {
          type: "hotel",
          city: "三亚",
          checkInDate: "2026-10-02",
          checkOutDate: "2026-10-04",
          tier: "mid",
        }, "tkt-verify-hotel")) && pass;
    } else {
      console.error(`  FAIL: flyai 酒店报价异常（ok=${search.ok}, api条数=${flyaiOpts.length}）`);
      pass = false;
    }
  }

  // ② 机票链
  console.log("\n═══ 链路②：机票（search 比价 → 两阶段 book → 支付 → 出票） ═══");
  {
    const { provider, store, service } = buildService(makeFlyAiStub());
    const search = (await service.search(toolCtx, "travel", {
      params: { type: "flight", from: "北京", to: "三亚", departTime: "2026-10-02", basePriceCny: 1500 },
    })) as { ok: boolean; options: Opt[]; note?: string };
    console.log(`  search 比价结果（升序）：`);
    printOptions(search.options);
    console.log(`  汇总：${search.note ?? "（无）"}`);
    const flyaiOpt = search.options.find((o) => o.extra.quoteSource === "flyai.flight");
    if (search.ok && flyaiOpt && flyaiOpt.extra.code === "CZ6712") {
      console.log(`  选飞猪实时价：${flyaiOpt.title} ¥${flyaiOpt.amountCny}`);
      pass =
        (await bookTwoStage(service, provider, store, flyaiOpt, {
          type: "flight",
          from: "北京",
          to: "三亚",
          departTime: "2026-10-02",
          basePriceCny: 1500,
        }, "tkt-verify-flight")) && pass;
    } else {
      console.error(`  FAIL: flyai 机票报价异常`);
      pass = false;
    }
  }

  // ③ 诚实降级探针：CLI 未安装
  console.log("\n═══ 探针③：flyai CLI 未安装 → 源如实报错、绝不编造 ═══");
  {
    const missing: FlyAiRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "flyai CLI 未安装（npm install -g @fly-ai/flyai-cli，或用 FLYAI_BIN 指定可执行文件路径）",
    });
    const aggregator = buildQuoteAggregator({ flyAiRunner: missing });
    const agg = await aggregator.aggregate(
      { type: "hotel", city: "三亚", checkInDate: "2026-10-02" },
      toolCtx,
    );
    const flyaiOutcome = agg.sources.find((s) => s.source === "flyai.hotel");
    const localOk = agg.sources.some((s) => s.source === "local" && s.ok && s.quotes.length > 0);
    const ok = !flyaiOutcome?.ok && !!flyaiOutcome?.error && localOk;
    console.log(`  flyai 源结果：ok=${flyaiOutcome?.ok}，error=${flyaiOutcome?.error ?? "（无）"}`);
    console.log(`  本地保底源仍出价：${localOk ? "✓" : "✗"}（聚合总报价 ${agg.quotes.length} 条，全部来自 local）`);
    if (!ok) pass = false;
  }

  clearInterval(keepAlive);
  console.log(`\n${pass ? "PASS：飞猪 FlyAI 酒店/机票预订闭环（mock）全部通过" : "FAIL：存在未通过验证点"}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
