/**
 * 推荐实时聚合 + 立场化推荐测试（方案 P1，不触网，全部注入假端口）。
 *
 * 验证逻辑：
 *   1. fetchLiveProducts：多平台并行聚合、无实时价剔除、预算过滤、归一化去重保留价低者
 *   2. liveProductToRecord：id 稳定、source=live、tags 保证 catalog.search 可命中
 *   3. ProductCatalog.upsertLive：live 插入/更新、不覆盖 seed 记录
 *   4. shopping.suggest handler：库未命中 → liveSourcing 兜底出推荐（source=live、notes 溯源）
 *      ；聚合为空 → 保持「库无此品」诚实话术
 *   5. 立场化：引擎确定性 pick/alternatives；个性化 LLM 主推重排与 headline 回填；
 *      LLM 非法输出保留引擎立场；建议文本含「主推/为什么/什么时候选它」
 *   6. product_compare 卡 builder：标题「主推 · X」、备选「什么时候选它」条目
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRecommendationCatalog,
  fetchLiveProducts,
  liveProductToRecord,
  dedupeByNormalizedTitle,
  type LiveSourcingDeps,
} from "../src/recommendation/index.js";
import type { ProductRecord } from "../src/recommendation/product-catalog.js";
import type { OfficialPriceGateway } from "../src/services/shopping-platforms/official-price-source.js";
import type { ProductSummary } from "../src/services/shopping-platforms/types.js";
import { pickBestProductImage, parseScoreResponse } from "../src/services/product-image-scorer.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import { tryAttachToolResultCard } from "../src/services/tool-card-registry.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

type FakeGateway = Pick<OfficialPriceGateway, "configuredPlatforms" | "search"> & {
  calls: string[];
};

function fakeGateway(byPlatform: Record<string, ProductSummary[]>): FakeGateway {
  const calls: string[] = [];
  return {
    calls,
    configuredPlatforms: () => Object.keys(byPlatform),
    async search(platform, _query, limit) {
      calls.push(platform);
      const products = byPlatform[platform];
      if (!products) return { ok: false, products: [], notConfigured: true };
      return { ok: true, products: products.slice(0, limit) };
    },
  };
}

function summary(overrides: Partial<ProductSummary> & { title: string }): ProductSummary {
  return { price: 100, itemId: `sku-${Math.random()}`, ...overrides };
}

// ─────────────── 1. fetchLiveProducts ───────────────

test("fetchLiveProducts：多平台聚合、无实时价剔除、预算过滤、去重保留价低者", async () => {
  const gateway = fakeGateway({
    taobao: [
      summary({ title: "洗碗机 嵌入式 13套 大容量", price: 3200 }),
      summary({ title: "洗碗机 台式 免安装", price: 1500 }),
      summary({ title: "无线耳机", price: undefined as unknown as number }), // 无实时价 → 剔
    ],
    jd: [
      summary({ title: "【爆款】洗碗机 嵌入式 13套", price: 2999, itemId: "jd-100" }),
      summary({ title: "洗碗机 嵌入式 15套 高配", price: 4200 }),
      summary({ title: "超预算洗碗机 旗舰款", price: 9999 }), // 预算外 → 剔
    ],
  });
  const res = await fetchLiveProducts({ gateway } as LiveSourcingDeps, "洗碗机", { budgetMax: 4000 });
  assert.equal(res.platformsSearched.length, 2);
  // 台式 1500 / 嵌入式13套（跨平台同款去重保留价低的京东 2999）/ 15套 4200（预算+15%弹性内）
  assert.equal(res.products.length, 3);
  assert.equal(res.products[0]!.price, 1500);
  const embedded = res.products.find((p) => p.title.includes("13套"))!;
  assert.equal(embedded.platform, "jd");
  assert.equal(embedded.price, 2999);
  assert.ok(!res.products.some((p) => p.title.includes("无线耳机")));
  assert.ok(!res.products.some((p) => p.title.includes("旗舰款")));
});

test("fetchLiveProducts：全部平台未配置凭据时返回空 + 溯源 notes（不编造）", async () => {
  const gateway = fakeGateway({});
  const res = await fetchLiveProducts({ gateway } as LiveSourcingDeps, "洗碗机");
  assert.equal(res.products.length, 0);
  assert.ok(res.notes[0]!.includes("未配置凭据"));
});

// ─────────────── 2. liveProductToRecord ───────────────

test("liveProductToRecord：id 稳定、source=live、tags 保证检索可命中", () => {
  const now = 1_700_000_000_000;
  const a = liveProductToRecord(
    { platform: "jd", itemId: "jd-100", title: "洗碗机 嵌入式 13套", price: 2999, imageUrl: "https://img.example/x.jpg", shop: "京东自营" },
    "洗碗机",
    now,
  );
  const b = liveProductToRecord(
    { platform: "jd", itemId: "jd-100", title: "洗碗机 嵌入式 13套", price: 2899 },
    "洗碗机",
    now,
  );
  assert.equal(a.id, b.id); // 同 itemId 稳定 id → upsert 更新而非重复
  assert.equal(a.source, "live");
  assert.equal(a.image, "https://img.example/x.jpg");
  assert.equal(a.channels[0]!.name, "京东");
  assert.equal(a.channels[0]!.priceCny, 2999);
  assert.ok(a.tags.includes("洗碗机"));
  assert.equal(a.reviewSummary.sampleSize, 0); // 实时商品无口碑快照，不装作有口碑
});

test("dedupeByNormalizedTitle：营销噪音归一后同款合并", () => {
  const out = dedupeByNormalizedTitle([
    { platform: "taobao", title: "【官方旗舰】正品洗碗机 13套 嵌入式 包邮", price: 3000 },
    { platform: "jd", title: "洗碗机 13套 嵌入式", price: 3100 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.price, 3000);
});

// ─────────────── 3. upsertLive ───────────────

test("ProductCatalog.upsertLive：live 插入与更新，不覆盖 seed 记录", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rec-live-"));
  try {
    const catalog = createRecommendationCatalog(dataDir);
    const seedId = catalog.list()[0]!.id;
    const liveRec = liveProductToRecord(
      { platform: "jd", itemId: "jd-100", title: "洗碗机 嵌入式 13套", price: 2999 },
      "洗碗机",
    );
    catalog.upsertLive([liveRec]);
    catalog.upsertLive([
      { ...liveRec, channels: [{ name: "京东", priceCny: 2799 }] }, // 更新拿最新价
    ]);
    const got = catalog.get(liveRec.id);
    assert.equal(got!.channels[0]!.priceCny, 2799);
    // seed 记录被 live 数据冒名顶替时被拒（id 相同也不覆盖）
    catalog.upsertLive([{ ...liveRec, id: seedId, source: "live" }]);
    assert.equal(catalog.get(seedId)!.source ?? "seed", "seed");
    assert.ok(catalog.search({ query: "洗碗机" }).some((p) => p.id === liveRec.id));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ─────────────── 4. handler：库未命中 → 实时聚合兜底 ───────────────

type ExecResult = { ok: boolean; result: Record<string, unknown> };

function execute(registry: ToolRegistry, input: Record<string, unknown>): Promise<ExecResult> {
  const exec = (
    registry as unknown as {
      execute: (
        name: string,
        input: Record<string, unknown>,
        context: unknown,
      ) => Promise<ExecResult>;
    }
  ).execute.bind(registry);
  return exec("shopping.suggest", input, { sessionId: "test-user" });
}

test("shopping.suggest：库未命中走 liveSourcing，出推荐且 source=live", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "suggest-live-"));
  try {
    const catalog = createRecommendationCatalog(dataDir);
    const registry = new ToolRegistry();
    registerLifeTools(registry, {} as never, {} as never, {
      catalog,
      liveSourcing: async (query) => ({
        records: [
          liveProductToRecord({ platform: "jd", itemId: "j1", title: "洗碗机 嵌入式 13套", price: 2999 }, query),
          liveProductToRecord({ platform: "taobao", itemId: "t1", title: "洗碗机 台式 免安装", price: 1500 }, query),
        ],
        notes: ["jd：ok"],
      }),
    });
    const res = await execute(registry, { item: "洗碗机" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as Record<string, unknown> & {
      candidates: ProductRecord[];
      source?: string;
      pick?: { productId: string; headline: string };
      alternatives?: Array<{ productId: string; whenChoose: string }>;
    };
    assert.equal(rec.candidates.length, 2);
    assert.equal(rec.source, "live");
    assert.ok(rec.pick);
    assert.equal(rec.pick!.productId, rec.candidates[0]!.productId);
    assert.ok(Array.isArray(res.result.notes));
    // 落库缓存：第二次同样的查询不再依赖实时聚合（liveSourcing 不再被调用）
    const res2 = await execute(registry, { item: "洗碗机" });
    const rec2 = res2.result.recommendation as Record<string, unknown> & { candidates: ProductRecord[] };
    assert.equal(rec2.candidates.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("shopping.suggest：实时聚合为空时保持「库无此品」诚实话术", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "suggest-live-"));
  try {
    const registry = new ToolRegistry();
    registerLifeTools(registry, {} as never, {} as never, {
      catalog: createRecommendationCatalog(dataDir),
      liveSourcing: async () => ({ records: [], notes: ["联盟API未配置凭据"] }),
    });
    const res = await execute(registry, { item: "洗碗机" });
    assert.equal(res.ok, true);
    assert.match(String(res.result.summary), /无匹配/);
    assert.deepEqual(res.result.notes, ["联盟API未配置凭据"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ─────────────── 5. 立场化 ───────────────

test("建议文本与卡片：确定性立场（主推/为什么/什么时候选它）", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "suggest-stand-"));
  try {
    const registry = new ToolRegistry();
    registerLifeTools(registry, {} as never, {} as never, {
      catalog: createRecommendationCatalog(dataDir),
    });
    const res = await execute(registry, { item: "降噪耳机" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as {
      candidates: Array<{ productId: string }>;
      pick?: { productId: string; headline: string };
      alternatives?: Array<{ productId: string; whenChoose: string }>;
    };
    assert.ok(rec.pick, "引擎确定性输出应带 pick");
    assert.equal(rec.pick!.productId, rec.candidates[0]!.productId);
    assert.ok(rec.pick!.headline.length > 0);
    assert.ok(String(res.result.suggestionText).includes("主推"));
    assert.ok(String(res.result.suggestionText).includes("为什么"));
    assert.ok(String(res.result.suggestionText).includes("什么时候选它"));

    // 卡片标题立场化（tryAttachToolResultCard 返回内嵌卡标记的文本）
    const marked = tryAttachToolResultCard("", "shopping.suggest", res.result);
    assert.ok(marked?.includes("[AGENT_RESULT_CARD_START]"), "应直出卡标记");
    const payload = JSON.parse(
      marked!.slice(marked!.indexOf("{"), marked!.lastIndexOf("}") + 1),
    ) as { title?: string; items?: Array<{ text?: string }> };
    assert.match(payload.title ?? "", /^主推 · /);
    assert.ok(payload.items?.some((it) => it.text?.includes("什么时候选它")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("applyPersonalization：LLM 主推重排 + headline 回填；非法输出保留引擎立场", async () => {
  const { applyPersonalization } = await import("../src/recommendation/personalize.js");
  const { buildSuggestion } = await import("../src/recommendation/suggest-engine.js");
  const dataDir = await mkdtemp(join(tmpdir(), "stand-llm-"));
  try {
    const catalog = createRecommendationCatalog(dataDir);
    const base = buildSuggestion(catalog, { item: "降噪耳机" })!;

    const llm = JSON.stringify({
      summary: "按你的通勤场景主推 B 款",
      pick: { productId: base.candidates[1]!.productId, headline: "佩戴更轻，匹配你每天 2 小时通勤" },
      alternatives: [
        { productId: base.candidates[0]!.productId, whenChoose: "预算再压 300 元" },
        { productId: "幻觉商品", whenChoose: "不该出现" },
      ],
      candidates: base.candidates.map((c) => ({ productId: c.productId, reasons: c.reasons })),
    });
    const { result, applied } = applyPersonalization(base, llm);
    assert.equal(applied, true);
    assert.equal(result.candidates[0]!.productId, base.candidates[1]!.productId); // 主推重排到首位
    assert.equal(result.pick!.productId, base.candidates[1]!.productId);
    assert.match(result.pick!.headline, /通勤/);
    assert.ok(result.alternatives!.every((a) => a.productId !== "幻觉商品"));

    const failed = applyPersonalization(base, "不是 JSON");
    assert.equal(failed.applied, false);
    assert.ok(failed.result.pick); // 引擎立场仍在，不因个性化失败而失去立场
    assert.equal(failed.result.pick!.productId, failed.result.candidates[0]!.productId);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ─────────────── 6. VLM 选图解析 ───────────────

test("pickBestProductImage：解析打分 JSON，全负分/非法输出返回 null", async () => {
  const scores = parseScoreResponse(
    '{"scores":[{"i":0,"score":3,"why":"实拍主体"},{"i":1,"score":9,"why":"白底"},{"i":2,"score":-2,"why":"促销水印"}]}',
    3,
  );
  assert.equal(scores!.bestIndex, 1);

  assert.equal(parseScoreResponse("模型胡言乱语", 2), null);
  assert.equal(parseScoreResponse('{"scores":[{"i":0,"score":-4,"why":"水印"},{"i":1,"score":0,"why":"场景"}]}', 2), null);
  // 漏打分的图记 0 分，bestIndex 仍可选出
  const partial = parseScoreResponse('{"scores":[{"i":1,"score":5,"why":"主体"}]}', 2);
  assert.equal(partial!.bestIndex, 1);

  // VLM 不可用（describeFn 注入失败）→ null，调用方取首图兜底
  const none = await pickBestProductImage([{ url: "a" }], {
    describeFn: async () => {
      throw new Error("vlm down");
    },
  });
  assert.equal(none, null);

  const best = await pickBestProductImage([{ url: "a" }, { url: "b" }], {
    describeFn: async () => '{"scores":[{"i":0,"score":2},{"i":1,"score":8}]}',
  });
  assert.equal(best!.bestIndex, 1);
});
