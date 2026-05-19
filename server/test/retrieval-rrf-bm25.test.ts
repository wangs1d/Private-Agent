import test from "node:test";
import assert from "node:assert/strict";

import { Bm25LiteIndex, tokenizeForBm25 } from "../src/agent/retrieval/bm25-lite.js";
import { reciprocalRankFusion } from "../src/agent/retrieval/rrf.js";

test("tokenizeForBm25 handles Chinese and latin", () => {
  const t = tokenizeForBm25("北京 weather Tokyo");
  assert.ok(t.includes("北"));
  assert.ok(t.includes("京"));
  assert.ok(t.includes("weather"));
  assert.ok(t.includes("tokyo"));
});

test("BM25 returns ranked docs", () => {
  const idx = new Bm25LiteIndex(100);
  idx.upsert("a", "猫 喜欢 吃鱼");
  idx.upsert("b", "狗 跑步");
  const hits = idx.search("猫 鱼", 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.id, "a");
});

test("RRF merges two rankings", () => {
  const merged = reciprocalRankFusion(
    [
      [{ id: "x" }, { id: "y" }],
      [{ id: "y" }, { id: "z" }],
    ],
    60,
    10,
  );
  assert.ok(merged.length >= 2);
  const top = merged[0]!.id;
  assert.ok(top === "y" || top === "x");
});
