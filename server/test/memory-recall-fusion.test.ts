/**
 * 召回融合评测与回归基准（P0/P1 混合检索改造）。
 *
 * 三部分：
 *   1. fuseRankLists 单测：RRF 共识融合的语义（单列表恒等/共识上浮/cap 保护）
 *   2. golden 评测：固定语料 + 分级标注，向量为「词面 overlap 弱代理」路 +
 *      真实 FtsStore 关键词路，走生产 bridge.searchFused 融合，算
 *      MRR@8 / Recall@5 / NDCG@5——作为后续检索/精排改动的回归基线
 *   3. bridge 第三路接线：FTS-only 命中以 channels=["fts"] 进入融合结果
 *
 * 向量路用 overlap 弱代理（离线无 embedding；真实语义路的短板由精排补，
 * 见 test/memory-reranker.test.ts 与 AGENT_MEMORY_RERANKER）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fuseRankLists } from "../src/brain/memory-arbitrator.js";
import { AgenticMemoryFtsStore } from "../src/agentic-memory/fts-store.js";
import { MemoryBridgeService } from "../src/agentic-memory/memory-bridge-service.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import type { AgenticMemoryCandidate } from "../src/agentic-memory/retrieval.js";
import { contentTokenSet, tokenOverlapRatio } from "../src/services/memory-record-utils.js";
import { GOLDEN_CORPUS, GOLDEN_QUERIES } from "./fixtures/recall-golden.js";

// ============================================================
// 1. fuseRankLists：RRF 共识融合语义
// ============================================================

test("fuseRankLists：单列表融合恒等（consensus=1，分数不变，保持降序）", () => {
  const items = [
    { content: "a", score: 0.9 },
    { content: "b", score: 0.6 },
    { content: "c", score: 0.3 },
  ];
  const fused = fuseRankLists([items]);
  assert.deepEqual(
    fused.map((e) => e.item.content),
    ["a", "b", "c"],
  );
  for (const entry of fused) {
    assert.ok(
      Math.abs(entry.consensusScore - (entry.item.score ?? 0)) < 1e-9,
      "单列表 consensus 应等于原始分",
    );
    assert.equal(entry.listsHit, 1);
  }
});

test("fuseRankLists：多列表一致命中按共识上浮", () => {
  const listA = [
    { content: "solo", score: 0.9 },
    { content: "consensus", score: 0.75 },
  ];
  const listB = [{ content: "consensus", score: 0.7 }];
  const fused = fuseRankLists([listA, listB]);
  assert.equal(fused[0]!.item.content, "consensus", "双列表命中的 0.75 应上浮过单列表 0.9");
  assert.equal(fused[0]!.listsHit, 2);
});

test("fuseRankLists：cap 保护——悬殊语义差不被共识翻转", () => {
  const listA = [
    { content: "strong", score: 0.95 },
    { content: "weak-consensus", score: 0.4 },
  ];
  const listB = [{ content: "weak-consensus", score: 0.35 }];
  const fused = fuseRankLists([listA, listB]);
  assert.equal(fused[0]!.item.content, "strong", "0.95 vs 0.4 的悬殊差距不应被 35% cap 翻转");
});

test("fuseRankLists：空列表输入返回空；代表条目取最高原始分者", () => {
  assert.equal(fuseRankLists<number[][]>([]).length, 0);
  assert.equal(fuseRankLists([[]]).length, 0);
  const fused = fuseRankLists([
    [{ content: "dup", score: 0.5, tag: "low" }],
    [{ content: "dup", score: 0.8, tag: "high" }],
  ]);
  assert.equal(fused.length, 1);
  assert.equal((fused[0]!.item as { tag: string }).tag, "high", "代表条目应为高分版本");
});

// ============================================================
// 2. golden 评测：MRR@8 / Recall@5 / NDCG@5 回归基线
// ============================================================

function mrrAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(rankedIds.length, k); i++) {
    if (relevant.has(rankedIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function recallAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  const top = new Set(rankedIds.slice(0, k));
  let hits = 0;
  for (const id of relevant) if (top.has(id)) hits++;
  return relevant.size === 0 ? 0 : hits / relevant.size;
}

/** 分级 NDCG@k（rel 2/1，IDCG 按理想排序） */
function ndcgAtK(rankedIds: string[], relMap: Map<string, number>, k: number): number {
  const dcg = (ids: string[]): number =>
    ids.reduce((sum, id, i) => sum + (relMap.get(id) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...relMap.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg(rankedIds.slice(0, k)) / idcg;
}

interface ContentChannel {
  candidates: AgenticMemoryCandidate[];
}

async function withFusionHarness(
  fn: (ctx: {
    fts: AgenticMemoryFtsStore;
    buildFusedRanking: (query: string) => Promise<string[]>;
    vectorRanking: (query: string) => string[];
    ftsRanking: (query: string) => string[];
    idOf: (content: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "recall-fusion-"));
  const db = openAgenticSqlite(join(dir, "fusion.db"));
  const fts = new AgenticMemoryFtsStore(db);
  try {
    fts.indexMemories(
      "user-1",
      GOLDEN_CORPUS.map((m) => ({ id: m.id, memory: m.content, metadata: { context: "main" } })),
    );

    const idOf = (content: string): string =>
      GOLDEN_CORPUS.find((m) => m.content === content)?.id ?? `?${content.slice(0, 12)}`;

    // 向量弱代理：词面 overlap（min-侧 Jaccard），确定性、无 embedding
    const vectorRanking = (query: string): string[] => {
      const qTokens = contentTokenSet(query);
      return GOLDEN_CORPUS.map((m) => ({
        id: m.id,
        score: tokenOverlapRatio(qTokens, contentTokenSet(m.content)),
      }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .map((m) => m.id);
    };

    const ftsRanking = (query: string): string[] =>
      fts.search("user-1", query, { context: "main", topK: 12 }).map((c) => idOf(c.content));

    // 生产融合路径：fake mem0/graph/ingest + 真实 FTS，走 bridge.searchFused
    const buildFusedRanking = async (query: string): Promise<string[]> => {
      const channel: ContentChannel = {
        candidates: (await Promise.resolve(vectorRanking(query))).map((id) => ({
          content: GOLDEN_CORPUS.find((m) => m.id === id)!.content,
          score: 0.5,
          highSignal: false,
        })),
      };
      const fakeRetrieval = {
        async searchStructured() {
          return channel.candidates;
        },
      };
      const fakeGraph = {
        async buildRecall() {
          return { recalledNodeIds: [], confidence: 0, text: "" };
        },
        getNodeSummariesByIds() {
          return [];
        },
        async ingest() {
          return null;
        },
        getAllNodes() {
          return [];
        },
        attachNodeMetadata(): boolean {
          return true;
        },
      };
      const fakeMemory = {
        async delete() {},
        async getAll() {
          return { results: [] };
        },
      };
      const fakeIngest = {
        async writeDecidedDetailed() {
          return [];
        },
      };
      const bridge = new MemoryBridgeService(
        fakeMemory as never,
        fakeGraph as never,
        fakeIngest as never,
        fakeRetrieval as never,
        db,
        fts,
      );
      try {
        const fused = await bridge.searchFused("user-1", query, { context: "main" });
        return fused.map((c) => idOf(c.content));
      } finally {
        // bridge 共享 db 与 fts（构造时传入），不 close——由外层统一回收
        bridge.stopForgettingSync();
      }
    };

    await fn({ fts, buildFusedRanking, vectorRanking, ftsRanking, idOf });
  } finally {
    fts.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("golden 评测：融合召回的 MRR@8 / Recall@5 / NDCG@5 基线", async () => {
  await withFusionHarness(async ({ buildFusedRanking, vectorRanking, ftsRanking }) => {
    const agg = {
      fusion: { mrr: 0, recall: 0, ndcg: 0 },
      vector: { mrr: 0, recall: 0, ndcg: 0 },
      fts: { mrr: 0, recall: 0, ndcg: 0 },
    };
    const lines: string[] = [];
    for (const gq of GOLDEN_QUERIES) {
      const relevant = new Set(Object.keys(gq.relevance));
      const relMap = new Map(Object.entries(gq.relevance).map(([id, rel]) => [id, rel]));
      const rankings = {
        fusion: await buildFusedRanking(gq.query),
        vector: vectorRanking(gq.query),
        fts: ftsRanking(gq.query),
      };
      const scores = {
        fusion: {
          mrr: mrrAtK(rankings.fusion, relevant, 8),
          recall: recallAtK(rankings.fusion, relevant, 5),
          ndcg: ndcgAtK(rankings.fusion, relMap, 5),
        },
        vector: {
          mrr: mrrAtK(rankings.vector, relevant, 8),
          recall: recallAtK(rankings.vector, relevant, 5),
          ndcg: ndcgAtK(rankings.vector, relMap, 5),
        },
        fts: {
          mrr: mrrAtK(rankings.fts, relevant, 8),
          recall: recallAtK(rankings.fts, relevant, 5),
          ndcg: ndcgAtK(rankings.fts, relMap, 5),
        },
      };
      agg.fusion.mrr += scores.fusion.mrr;
      agg.fusion.recall += scores.fusion.recall;
      agg.fusion.ndcg += scores.fusion.ndcg;
      agg.vector.mrr += scores.vector.mrr;
      agg.vector.recall += scores.vector.recall;
      agg.vector.ndcg += scores.vector.ndcg;
      agg.fts.mrr += scores.fts.mrr;
      agg.fts.recall += scores.fts.recall;
      agg.fts.ndcg += scores.fts.ndcg;
      lines.push(
        `[${gq.query}] fusion=${scores.fusion.ndcg.toFixed(3)} vector=${scores.vector.ndcg.toFixed(3)} fts=${scores.fts.ndcg.toFixed(3)}`,
      );
    }
    const n = GOLDEN_QUERIES.length;
    for (const key of ["fusion", "vector", "fts"] as const) {
      agg[key].mrr /= n;
      agg[key].recall /= n;
      agg[key].ndcg /= n;
    }
    console.log(`[recall-golden] 基线（n=${n}）`);
    for (const line of lines) console.log(`  ${line}`);
    console.log(
      `  fusion: MRR@8=${agg.fusion.mrr.toFixed(3)} Recall@5=${agg.fusion.recall.toFixed(3)} NDCG@5=${agg.fusion.ndcg.toFixed(3)}`,
    );
    console.log(
      `  vector: MRR@8=${agg.vector.mrr.toFixed(3)} Recall@5=${agg.vector.recall.toFixed(3)} NDCG@5=${agg.vector.ndcg.toFixed(3)}`,
    );
    console.log(
      `  fts:    MRR@8=${agg.fts.mrr.toFixed(3)} Recall@5=${agg.fts.recall.toFixed(3)} NDCG@5=${agg.fts.ndcg.toFixed(3)}`,
    );

    // 回归基线：融合不劣于任一单路（共识 RRF 的鲁棒性），且有绝对质量下限。
    // Recall@5 基线 ~0.875：q4/q7 的 rel=1 背景条目（m11/m09）与 query 零词面
    // 重叠，落在弱代理向量路的零分尾部——这正是精排（reranker）要补的部分。
    assert.ok(agg.fusion.mrr >= 0.9, `fusion MRR@8 ${agg.fusion.mrr} < 0.9`);
    assert.ok(agg.fusion.recall >= 0.8, `fusion Recall@5 ${agg.fusion.recall} < 0.8`);
    assert.ok(agg.fusion.ndcg >= 0.75, `fusion NDCG@5 ${agg.fusion.ndcg} < 0.75`);
    assert.ok(
      agg.fusion.mrr >= Math.min(agg.vector.mrr, agg.fts.mrr) - 1e-9,
      "融合 MRR 不应显著差于单路",
    );
  });
});

// ============================================================
// 3. bridge 第三路接线：FTS-only 命中进入融合结果
// ============================================================

test("bridge.searchFused：FTS 作为第三路参与 RRF（mem0/graph 缺席时 fts 通道可见）", async () => {
  await withFusionHarness(async ({ fts, ftsRanking }) => {
    assert.ok(ftsRanking("布丁").includes("m03"), "前置：FTS 路可命中");

    const fakeRetrieval = {
      async searchStructured() {
        return [] as AgenticMemoryCandidate[];
      },
    };
    const fakeGraph = {
      async buildRecall() {
        return { recalledNodeIds: [], confidence: 0, text: "" };
      },
      getNodeSummariesByIds() {
        return [];
      },
      async ingest() {
        return null;
      },
      getAllNodes() {
        return [];
      },
      attachNodeMetadata(): boolean {
        return true;
      },
    };
    const fakeMemory = {
      async delete() {},
      async getAll() {
        return { results: [] };
      },
    };
    const fakeIngest = {
      async writeDecidedDetailed() {
        return [];
      },
    };
    const dir = join(tmpdir(), `recall-fusion-links-${Date.now()}`);
    const db = openAgenticSqlite(join(dir, "links.db"));
    const bridge = new MemoryBridgeService(
      fakeMemory as never,
      fakeGraph as never,
      fakeIngest as never,
      fakeRetrieval as never,
      db,
      fts,
    );
    try {
      const fused = await bridge.searchFused("user-1", "布丁是什么猫", { context: "main" });
      assert.ok(fused.length > 0, "FTS 命中应进入融合结果");
      assert.ok(
        fused.every((c) => c.channels.includes("fts")),
        "mem0/graph 缺席时来源应标记为 fts 通道",
      );
      assert.ok(fused.some((c) => c.content.includes("布丁")));
    } finally {
      bridge.stopForgettingSync();
      bridge.close();
    }
  });
});
