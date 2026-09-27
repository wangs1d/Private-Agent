/**
 * ShoppingCompareService 双通道取数测试（2026-09-24，官方 API 优先 / 浏览器兜底）。
 *
 * 契约：
 *   - 官方源配置了且出结果 → 不触浏览器链路，offer 标 source=official_api
 *   - 官方源失败/未配 → 落浏览器兜底，offer 标 source=browser
 *   - 降价监控 tick 走同一双通道（监控提级：官方源免 Cookie 可查）
 *   - 失败详情错误消息脱敏（Cookie 不外泄）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ShoppingCompareService } = await import("../src/services/shopping-compare-service.js");
const { OfficialPriceGateway } = await import(
  "../src/services/shopping-platforms/official-price-source.js"
);

type SearchCall = { platform: string; query: string };

function makeOrderStub(opts: { failWithCookieLeak?: boolean } = {}) {
  const calls: SearchCall[] = [];
  return {
    calls,
    service: {
      listSupportedPlatforms: () => ["taobao", "jd", "pdd"],
      searchProduct: async (_ctx: unknown, platform: string, query: string) => {
        calls.push({ platform, query });
        if (opts.failWithCookieLeak) {
          return { ok: false, error: "搜索失败 Cookie: t=leakedcookievalue123" };
        }
        return {
          ok: true,
          products: [
            { title: "浏览器抓到的伊利纯牛奶250ml*12盒", price: 49.9, itemId: "b1", url: "https://b/1" },
          ],
        };
      },
    },
  };
}

function makeGateway(behavior: "ok" | "fail" | "none") {
  const post =
    behavior === "ok"
      ? async (): Promise<string> =>
          JSON.stringify({
            tbk_dg_material_optional_response: {
              result_list: [
                { num_iid: 1, title: "官方API 伊利纯牛奶250ml*12盒", zk_final_price: "52.3", click_url: "https://o/1" },
              ],
            },
          })
      : async (): Promise<string> => {
          throw new Error("HTTP 500");
        };
  return new OfficialPriceGateway({
    taobao: behavior === "none" ? null : { appKey: "K", appSecret: "S", adzoneId: "1" },
    post,
  });
}

const CTX = { sessionId: "s1", userId: "u1" };

test("官方源优先：出结果时不触浏览器，offer 标 official_api + 时效", async (t) => {
  const stub = makeOrderStub();
  const svc = new ShoppingCompareService({
    shoppingOrderService: stub.service,
    officialPriceGateway: makeGateway("ok"),
    dataDir: join(mkdtempSync(join(tmpdir(), "pa-cmp-")), "shopping"),
  } as never);
  const r = await svc.comparePrices(CTX, "伊利纯牛奶", { platforms: ["taobao"] });
  assert.ok(r.ok);
  assert.equal(stub.calls.length, 0, "官方源成功不落浏览器兜底");
  if (r.ok) {
    const offer = r.groups[0]!.offers[0]!;
    assert.equal(offer.source, "official_api");
    assert.ok(offer.fetchedAt);
    assert.ok(r.summary.includes("官方API"), r.summary);
  }
});

test("官方源失败：静默落浏览器兜底，offer 标 browser", async (t) => {
  const stub = makeOrderStub();
  const svc = new ShoppingCompareService({
    shoppingOrderService: stub.service,
    officialPriceGateway: makeGateway("fail"),
    dataDir: join(mkdtempSync(join(tmpdir(), "pa-cmp-")), "shopping"),
  } as never);
  const r = await svc.comparePrices(CTX, "伊利纯牛奶", { platforms: ["taobao"] });
  assert.ok(r.ok);
  assert.equal(stub.calls.length, 1, "官方失败后落兜底");
  if (r.ok) {
    assert.equal(r.groups[0]!.offers[0]!.source, "browser");
  }
});

test("浏览器失败详情脱敏：Cookie 值不进返回值", async (t) => {
  const stub = makeOrderStub({ failWithCookieLeak: true });
  const svc = new ShoppingCompareService({
    shoppingOrderService: stub.service,
    officialPriceGateway: makeGateway("none"),
    dataDir: join(mkdtempSync(join(tmpdir(), "pa-cmp-")), "shopping"),
  } as never);
  const r = await svc.comparePrices(CTX, "伊利纯牛奶", { platforms: ["taobao"] });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(!r.error.includes("leakedcookievalue123"), `须脱敏 → ${r.error}`);
  }
});

test("降价监控走双通道：官方源成功即到价回调（免 Cookie）", async (t) => {
  const stub = makeOrderStub();
  const hits: Array<{ priceCny: number; source?: string }> = [];
  const svc = new ShoppingCompareService({
    shoppingOrderService: stub.service,
    officialPriceGateway: makeGateway("ok"),
    dataDir: join(mkdtempSync(join(tmpdir(), "pa-cmp-")), "shopping"),
    onPriceAlert: (_actor, _watch, hit) => hits.push({ priceCny: hit.priceCny, source: hit.source }),
  } as never);
  await svc.addWatch("u1", "伊利纯牛奶", "taobao", 60);
  const changed = await svc.checkAllWatches();
  assert.equal(stub.calls.length, 0, "监控复查不依赖用户 Cookie");
  assert.equal(changed, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.priceCny, 52.3);
  assert.equal(hits[0]!.source, "official_api");
});
