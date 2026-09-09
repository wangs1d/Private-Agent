/**
 * 报价源站点适配器：把具体平台（MCP / 商家站点）接成 QuoteSource。
 *
 * 新增平台 = 在这里加一个工厂函数，bootstrap 注册；聚合器与 provider 不动。
 * 诚实降级：站点解析失败/未启用一律返回空报价或 ok:false，聚合器如实汇总。
 */

import { McpQuoteSource, type McpCaller } from "./mcp-quote-source.js";
import { BrowserQuoteSource, type BrowserRunner } from "./browser-quote-source.js";
import type { QuoteRequest, QuoteSource, TravelQuote } from "./quote-source.js";

// ── RollingGo 酒店 MCP（data/mcp-servers.json alias=rollinggo，需填 url+key 启用） ──

export function createRollingGoHotelSource(caller: McpCaller): QuoteSource {
  return new McpQuoteSource(caller, {
    id: "mcp.rollinggo",
    label: "RollingGo 酒店（实时API）",
    serverAlias: "rollinggo",
    toolName: "searchHotels",
    supports: (t) => t === "hotel",
    mapRequest: (req) => {
      if (!req.city) return null;
      const args: Record<string, unknown> = { city: req.city };
      if (req.checkInDate) args.checkIn = req.checkInDate;
      if (req.checkOutDate) args.checkOut = req.checkOutDate;
      if (req.hotelName) args.keyword = req.hotelName;
      return args;
    },
    parseResult: (raw, req) => {
      // 宽容解析：酒店列表可能挂在 hotels / hotelList / data / results 任一键下
      const list =
        (Array.isArray(raw.hotels) && raw.hotels) ||
        (Array.isArray(raw.hotelList) && raw.hotelList) ||
        (Array.isArray(raw.results) && raw.results) ||
        (Array.isArray(raw.data) && raw.data) ||
        [];
      const quotes: TravelQuote[] = [];
      for (const item of list as Array<Record<string, unknown>>) {
        const name = typeof item.name === "string" ? item.name : typeof item.hotelName === "string" ? item.hotelName : "";
        const price =
          (typeof item.minPrice === "number" && item.minPrice) ||
          (typeof item.price === "number" && item.price) ||
          (typeof item.amount === "number" ? (item.amount as number) : NaN);
        if (!name || !Number.isFinite(price) || price <= 0) continue;
        quotes.push({
          source: "mcp.rollinggo",
          sourceLabel: "RollingGo 酒店（实时API）",
          type: "hotel",
          name,
          to: req.city,
          checkInDate: req.checkInDate,
          amountCny: Math.round(price),
          nights: 1,
          currency: "CNY",
          priceSource: "api",
          note: "RollingGo 实时报价，最终以下单页为准",
          fetchedAt: Date.now(),
        });
      }
      return quotes;
    },
  });
}

// ── 浏览器代查：携程机票列表页 ──

/** 城市名 → 携程城市码（列表页 URL 用；覆盖常见城市，未命中则本源跳过）。 */
const CTRIP_CITY_CODES: Record<string, string> = {
  北京: "bjs", 上海: "sha", 广州: "can", 深圳: "szx", 杭州: "hgh",
  成都: "ctu", 重庆: "ckg", 西安: "sia", 南京: "nkg", 武汉: "wuh",
  长沙: "csx", 昆明: "kmg", 厦门: "xmm", 青岛: "tao", 大连: "dlc",
  天津: "tsn", 三亚: "syx", 哈尔滨: "hrb", 乌鲁木齐: "urc", 拉萨: "lxa",
  郑州: "cgo", 贵阳: "kwe", 南宁: "nng", 福州: "foc", 合肥: "hfe",
  济南: "tna", 太原: "tyn", 石家庄: "sjw", 呼和浩特: "hlt", 沈阳: "she",
  长春: "cgq", 宁波: "ngb", 温州: "wnz", 苏州: "szv",
};

function ctripCityCode(name: string | undefined): string | null {
  if (!name) return null;
  const trimmed = name.replace(/市$/, "").trim();
  return CTRIP_CITY_CODES[trimmed] ?? null;
}

/**
 * 从列表页正文解析「航班号 … ¥价格」对。
 * 携程列表文本形如「东方航空 MU5107 空客320(中) 08:00 首都机场T2 … ¥530 起」；
 * 页面结构变化时解析不到 → 返回空（如实说明，绝不编造）。
 */
export function parseCtripFlightText(text: string, req: QuoteRequest): TravelQuote[] {
  const quotes = new Map<string, TravelQuote>();
  const re = /([A-Z]{2}\d{3,4})[\s\S]{0,120}?¥\s*(\d{2,5})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    const price = Number(m[2]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const existing = quotes.get(code);
    if (existing && existing.amountCny <= price) continue;
    quotes.set(code, {
      source: "browser.ctrip",
      sourceLabel: "浏览器代查·携程",
      type: "flight",
      code,
      from: req.from,
      to: req.to,
      departTime: req.departTime,
      seat: req.seat ?? "经济舱",
      amountCny: price,
      currency: "CNY",
      priceSource: "scraped",
      note: "携程列表页代查价，以平台实价为准",
      fetchedAt: Date.now(),
    });
  }
  return Array.from(quotes.values());
}

export function createCtripFlightSource(browser: BrowserRunner): QuoteSource {
  return new BrowserQuoteSource(browser, {
    id: "browser.ctrip",
    label: "浏览器代查·携程机票",
    supports: (t) => t === "flight",
    buildUrl: (req) => {
      const from = ctripCityCode(req.from);
      const to = ctripCityCode(req.to);
      const dep = (req.departTime ?? "").slice(0, 10);
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) return null;
      return `https://flights.ctrip.com/online/list/oneway-${from}-${to}?depdate=${dep}`;
    },
    parseText: parseCtripFlightText,
    // SPA 渲染等待（列表首屏数据加载）
    settleMs: 4_000,
  });
}
