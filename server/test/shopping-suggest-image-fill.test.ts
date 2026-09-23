/**
 * shopping.suggest 缺图候选网搜补图测试（不触网，webImageSearch 为注入假端口）。
 *
 * 验证逻辑：
 *   1. 缺图候选被补上图；已有商品库图的候选不被覆盖（一手图优先）
 *   2. 补图结果按 productId 缓存：二次调用不再触发网搜
 *   3. 端口报错/超时 → 候选保持无图，工具照常成功
 *   4. 补图后的回执经 tool-card-registry 直出卡时 sides 带图
 *   5. 未注入端口时行为与旧版一致（缺图保持无图）
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecommendationCatalog } from "../src/recommendation/index.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import { tryAttachToolResultCard } from "../src/services/tool-card-registry.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

type ExecResult = { ok: boolean; result: Record<string, unknown> };

async function makeRegistry(options: {
  webImageSearch?: (query: string, actorId: string) => Promise<string | null>;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "suggest-img-"));
  const registry = new ToolRegistry();
  registerLifeTools(registry, {} as never, {} as never, {
    catalog: createRecommendationCatalog(dataDir),
    webImageSearch: options.webImageSearch,
  });
  return {
    registry,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

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

type Recommendation = {
  candidates: Array<{ productId: string; image?: string }>;
};

test("缺图候选被网搜补图，已有图候选不被覆盖", async () => {
  const searched: string[] = [];
  const { registry, cleanup } = await makeRegistry({
    webImageSearch: async (query) => {
      searched.push(query);
      return `/agent/images/test-user/${encodeURIComponent(query)}.png`;
    },
  });
  try {
    // 「智能手表」「行李箱」「咖啡机」「显示器」对应的候选在种子库里均无 image
    const res = await execute(registry, { item: "智能手表" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as Recommendation;
    assert.ok(rec.candidates.length > 0);
    for (const c of rec.candidates) {
      assert.ok(c.image?.startsWith("/agent/images/test-user/"), `候选 ${c.productId} 应带补图`);
    }
    assert.equal(searched.length, rec.candidates.length);

    // 口红有商品库一手图，不得被网搜图覆盖
    const lip = await execute(registry, { item: "MAC Chili" });
    const lipRec = lip.result.recommendation as Recommendation;
    assert.ok(
      lipRec.candidates.every((c) => c.image === "/api/recommendation/media/lip-redbrick.jpg"),
    );
    assert.equal(searched.length, rec.candidates.length, "有图候选不应触发网搜");
  } finally {
    await cleanup();
  }
});

test("补图结果按 productId 缓存，二次调用零网搜", async () => {
  let calls = 0;
  const { registry, cleanup } = await makeRegistry({
    webImageSearch: async () => {
      calls += 1;
      return "/agent/images/test-user/watch.png";
    },
  });
  try {
    await execute(registry, { item: "智能手表" });
    assert.equal(calls, 1);
    await execute(registry, { item: "智能手表" });
    assert.equal(calls, 1, "命中缓存不应再网搜");
  } finally {
    await cleanup();
  }
});

test("端口报错/返回 null → 保持无图静默降级，工具照常成功", async () => {
  const { registry, cleanup } = await makeRegistry({
    webImageSearch: async () => {
      throw new Error("search provider down");
    },
  });
  try {
    const res = await execute(registry, { item: "智能手表" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as Recommendation;
    assert.ok(rec.candidates.length > 0);
    assert.ok(rec.candidates.every((c) => c.image === undefined));
  } finally {
    await cleanup();
  }
});

test("补图后的回执经 tool-card-registry 出卡时 sides 带图", async () => {
  const { registry, cleanup } = await makeRegistry({
    webImageSearch: async () => "/agent/images/test-user/filled.png",
  });
  try {
    // 种子库中「手表 + 显示器」同时命中需多关键词；这里直接用两个无图品类拼查
    const res = await execute(registry, { item: "智能手表 显示器" });
    const rec = res.result.recommendation as Recommendation;
    assert.ok(rec.candidates.length >= 1);
    const text = tryAttachToolResultCard(
      "前导正文",
      "shopping.suggest",
      res.result,
    );
    assert.ok(text?.includes("[AGENT_RESULT_CARD_START]"));
    const payload = JSON.parse(
      text!.split("[AGENT_RESULT_CARD_START]\n")[1]!.split("\n[AGENT_RESULT_CARD_END]")[0]!,
    ) as { cardType: string; sides: Array<{ image?: string }> };
    assert.equal(payload.cardType, "product_compare");
    assert.ok(payload.sides.length >= 1);
    assert.ok(
      payload.sides.every((s) => Boolean(s.image)),
      `所有分侧都应默认带图：${JSON.stringify(payload.sides)}`,
    );
  } finally {
    await cleanup();
  }
});

test("未注入补图端口时行为与旧版一致（缺图保持无图）", async () => {
  const { registry, cleanup } = await makeRegistry({});
  try {
    const res = await execute(registry, { item: "智能手表" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as Recommendation;
    assert.ok(rec.candidates.length > 0);
    assert.ok(rec.candidates.every((c) => c.image === undefined));
  } finally {
    await cleanup();
  }
});
