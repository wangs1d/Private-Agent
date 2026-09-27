/**
 * 官方联盟 API 比价数据源测试（2026-09-24）。
 *
 * 契约：
 *   - 签名：secret + 按键升序 k/v 拼接 + secret，MD5 大写（三平台同口径）
 *   - 请求：POST 表单、空值参剔除、sign 最后注入且不参与自身签名计算
 *   - 解析：淘宝客/京东联盟/多多进宝三家响应容错映射为 ProductSummary
 *   - 网关：未配凭据 notConfigured 静默；HTTP 失败 → 脱敏错误；凭据不外泄
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

const m = await import("../src/services/shopping-platforms/official-price-source.js");
const { signParams, OfficialPriceGateway, parseTaobaoTbkResponse, parseJdUnionResponse, parsePddDdkResponse } = m;

test("signParams：确定性与口径（secret 夹持、按键升序、MD5 大写）", () => {
  const params = { b: "2", a: "1", c: "3" };
  const s1 = signParams(params, "SECRET");
  const s2 = signParams({ c: "3", a: "1", b: "2" }, "SECRET");
  assert.equal(s1, s2, "键序无关");
  assert.match(s1, /^[0-9A-F]{32}$/);
  // 手工口径复算：SECRET + a1b2c3 + SECRET 的 MD5 大写
  const expect = createHash("md5").update("SECRETa1b2c3SECRET", "utf8").digest("hex").toUpperCase();
  assert.equal(s1, expect);
});

test("淘宝客响应解析：zk_final_price 优先、字段缺失容错", () => {
  const raw = JSON.stringify({
    tbk_dg_material_optional_response: {
      result_list: [
        { num_iid: 123, title: "伊利纯牛奶250ml*12盒", zk_final_price: "52.30", click_url: "https://s.click.taobao.com/x", shop_title: "伊利官方" },
        { title: "无价格商品", reserve_price: "99.00" },
        { num_iid: 456 }, // 无 title → 过滤
      ],
    },
  });
  const items = parseTaobaoTbkResponse(raw);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.price, 52.3);
  assert.equal(items[0]!.itemId, "123");
  assert.equal(items[1]!.price, 99);
});

test("京东联盟响应解析：priceInfo 容错", () => {
  const raw = JSON.stringify({
    jd_union_open_goods_query_response: {
      result: [
        { data: { skuName: "美的电水壶", skuId: 10001, priceInfo: { price: 129 }, materialUrl: "https://item.jd.com/1.html", shopInfo: { shopName: "美的自营" } } },
        { data: { skuName: "无价格", priceInfo: {} } },
      ],
    },
  });
  const items = parseJdUnionResponse(raw);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.price, 129);
  assert.equal(items[1]!.price, undefined);
});

test("多多进宝响应解析：分为元、券后价优先", () => {
  const raw = JSON.stringify({
    goods_search_response: {
      goods_list: [
        { goods_name: "纸巾抽纸整箱", goods_sign: "G_abcd", min_group_price: 2990, min_normal_price: 3990, shop_name: "某旗舰店" },
        { goods_name: "无价格商品" },
      ],
    },
  });
  const items = parsePddDdkResponse(raw);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.price, 29.9);
  assert.equal(items[0]!.itemId, "G_abcd");
});

function collectPosts() {
  const posts: Array<{ url: string; params: Record<string, string> }> = [];
  const post = async (url: string, params: Record<string, string>): Promise<string> => {
    posts.push({ url, params });
    return "{}";
  };
  return { posts, post };
}

test("网关：未配凭据 → notConfigured，上层静默兜底", async () => {
  const gw = new OfficialPriceGateway({ taobao: null, jd: null, pdd: null });
  assert.equal(gw.configuredPlatforms().length, 0);
  assert.equal(gw.isConfiguredFor("taobao"), false);
  const r = await gw.search("taobao", "牛奶", 5);
  assert.equal(r.ok, false);
  assert.equal(r.notConfigured, true);
});

test("网关：请求注入 sign、空值参剔除（access_token 未配置不参与）", async () => {
  const { posts, post } = collectPosts();
  const gw = new OfficialPriceGateway({
    taobao: { appKey: "K1", appSecret: "S1", adzoneId: "123" },
    jd: { appKey: "K2", appSecret: "S2" },
    post,
  });
  assert.deepEqual(gw.configuredPlatforms(), ["taobao", "jd"]);
  await gw.search("taobao", "牛奶", 5);
  await gw.search("jd", "牛奶", 5);
  assert.equal(posts[0]!.url, "https://gw.api.taobao.com/router/rest");
  {
    const { sign, ...rest } = posts[0]!.params;
    assert.equal(sign, signParams(rest, "S1"));
    assert.equal(posts[0]!.params.q, "牛奶");
  }
  assert.equal(posts[1]!.url, "https://api.jd.com/routerjson");
  // access_token 未配置 → 空值参被剔除，不参与签名
  assert.equal(posts[1]!.params.access_token, undefined);
  {
    const { sign, ...rest } = posts[1]!.params;
    assert.equal(sign, signParams(rest, "S2"));
  }
  // 360buy_param_json 携带关键词
  const biz = JSON.parse(posts[1]!.params["360buy_param_json"]!) as { goodsReqDTO: { keyword: string } };
  assert.equal(biz.goodsReqDTO.keyword, "牛奶");
});

test("网关：HTTP 失败 → ok=false + 错误脱敏（凭据不外泄）", async () => {
  const post = async (): Promise<string> => {
    throw new Error(`HTTP 400 at https://gw.api.taobao.com?app_key=K1&sign=SECRETVALUE99 Cookie: t=leakedcookievalue`);
  };
  const gw = new OfficialPriceGateway({ taobao: { appKey: "K1", appSecret: "S1", adzoneId: "1" }, post });
  const r = await gw.search("taobao", "牛奶", 5);
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.ok(!r.error.includes("leakedcookievalue"), `错误须脱敏 → ${r.error}`);
});

test("网关：响应解析落 ProductSummary（端到端打通假上游）", async () => {
  const post = async (): Promise<string> =>
    JSON.stringify({
      tbk_dg_material_optional_response: {
        result_list: [{ num_iid: 1, title: "官方 API 牛奶", zk_final_price: "39.9", click_url: "https://x.taobao.com/1" }],
      },
    });
  const gw = new OfficialPriceGateway({ taobao: { appKey: "K1", appSecret: "S1", adzoneId: "1" }, post });
  const r = await gw.search("taobao", "牛奶", 5);
  assert.equal(r.ok, true);
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0]!.price, 39.9);
});
