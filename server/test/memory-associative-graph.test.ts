/**
 * MemoryAssociativeGraph 单元测试。
 *
 * 覆盖 9 个场景：
 *   1. spread 单跳扩散：seed → 邻居，激活值正确衰减
 *   2. spread 多跳扩散：seed → A → B，B 的激活值 = 1.0 * weight * decay^2
 *   3. spread 跳过 hopCost > maxHops 的边
 *   4. spread 只返回激活值 > threshold 的节点
 *   5. predictAssociation：predictedOutcome 由 summary 拼接
 *   6. triggerExplorationIfNeeded：低置信占比 > 30% 时调用 markShouldExplore
 *   7. triggerExplorationIfNeeded：异步触发 executeGapQuery 不阻塞
 *   8. humanLike 为 null 时优雅降级返回空结果
 *   9. 降级开关：BRAIN_MEMORY_ASSOCIATIVE_ENABLED=0 时方法空操作
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryAssociativeGraph,
  type HumanLikeMemoryAssociativeLike,
  type KnowledgeGapExecutorLike,
} from "../src/brain/memory-cognitive/memory-associative-graph.js";
import type { SpreadingActivationResult } from "../src/brain/types.js";

// ============================================================
// mock 工厂
// ============================================================

type MockNode = { id: string; summary: string; keywords: string[]; confidence: number };
type MockEdge = {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
  decayFactor: number;
  hopCost: number;
};

/** 构造 mock HumanLikeMemoryAssociativeLike */
function makeMockHumanLike(nodes: MockNode[], edges: MockEdge[]): HumanLikeMemoryAssociativeLike {
  return {
    getAllNodes: () => nodes,
    getAllEdges: () => edges,
  };
}

/** 构造 mock KnowledgeGapExecutorLike（追踪调用，可选延迟） */
function makeMockGapExecutor(opts: { delayMs?: number; result?: string | null } = {}):
  KnowledgeGapExecutorLike & { calls: string[] } {
  const calls: string[] = [];
  const mock: KnowledgeGapExecutorLike & { calls: typeof calls } = {
    calls,
    async executeGapQuery(query: string): Promise<string | null> {
      calls.push(query);
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return opts.result ?? null;
    },
  };
  return mock;
}

/** 临时设置环境变量，测试结束后恢复 */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 构造一条 mock 边 */
function edge(from: string, to: string, w = 1.0, hopCost = 1): MockEdge {
  return {
    id: `e-${from}-${to}`,
    from,
    to,
    relation: "semantic",
    weight: w,
    decayFactor: 1.0,
    hopCost,
  };
}

/** 构造一个 mock 节点 */
function node(id: string, summary: string, keywords: string[] = [], confidence = 0.8): MockNode {
  return { id, summary, keywords, confidence };
}

/** 构造一个 spread 结果（用于 triggerExplorationIfNeeded 测试） */
function makeSpreadResult(
  seedNodeIds: string[],
  activated: Array<{ nodeId: string; activationValue: number; hopCount: number }>,
): SpreadingActivationResult {
  return {
    seedNodeIds,
    activatedNodes: activated,
    maxHopsReached: activated.reduce((m, a) => Math.max(m, a.hopCount), 0),
    spreadAt: new Date().toISOString(),
  };
}

// ============================================================
// 场景 1: spread 单跳扩散
// ============================================================

test("场景 1: spread 单跳扩散 — seed → 邻居，激活值正确衰减", async () => {
  // seed → A (weight=0.8)，单跳 maxHops=1, decay=0.5
  // 期望 A 激活值 = 1.0 * 0.8 * 0.5 = 0.4
  const humanLike = makeMockHumanLike(
    [node("seed", "种子节点"), node("A", "邻居 A")],
    [edge("seed", "A", 0.8, 1)],
  );
  const graph = new MemoryAssociativeGraph({ humanLike });

  const result = await graph.spread("actor-1", ["seed"], { maxHops: 1, decay: 0.5 });

  assert.equal(result.seedNodeIds.length, 1);
  assert.equal(result.seedNodeIds[0], "seed");
  assert.equal(result.activatedNodes.length, 1, "应激活 1 个邻居节点");
  const aNode = result.activatedNodes.find((n) => n.nodeId === "A");
  assert.ok(aNode, "A 应在激活列表中");
  assert.equal(aNode!.hopCount, 1, "A 的 hopCount 应为 1");
  // 激活值 = 1.0 * 0.8 * 0.5 = 0.4
  assert.ok(
    Math.abs(aNode!.activationValue - 0.4) < 1e-9,
    `A 激活值应为 0.4，实际: ${aNode!.activationValue}`,
  );
});

// ============================================================
// 场景 2: spread 多跳扩散
// ============================================================

test("场景 2: spread 多跳扩散 — seed → A → B，B = 1.0 * weight * decay^2", async () => {
  // seed → A (w=1.0) → B (w=1.0)，maxHops=2, decay=0.5
  // 期望：
  //   A = 1.0 * 1.0 * 0.5 = 0.5  (hop 1)
  //   B = 0.5 * 1.0 * 0.5 = 0.25 = 1.0 * 1.0 * decay^2  (hop 2)
  const humanLike = makeMockHumanLike(
    [node("seed", "种子"), node("A", "邻居 A"), node("B", "邻居 B")],
    [edge("seed", "A", 1.0, 1), edge("A", "B", 1.0, 1)],
  );
  const graph = new MemoryAssociativeGraph({ humanLike });

  // B = 0.25 < 默认 threshold 0.3，故显式传 activationThreshold=0.1 确保 B 通过
  const result = await graph.spread("actor-1", ["seed"], {
    maxHops: 2,
    decay: 0.5,
    activationThreshold: 0.1,
  });

  const bNode = result.activatedNodes.find((n) => n.nodeId === "B");
  assert.ok(bNode, "B 应在激活列表中");
  assert.equal(bNode!.hopCount, 2, "B 的 hopCount 应为 2");
  // B = 1.0 * 1.0 * 0.5^2 = 0.25
  assert.ok(
    Math.abs(bNode!.activationValue - 0.25) < 1e-9,
    `B 激活值应为 0.25 (= 1.0 * weight * decay^2)，实际: ${bNode!.activationValue}`,
  );
  assert.equal(result.maxHopsReached, 2, "maxHopsReached 应为 2");
});

// ============================================================
// 场景 3: spread 跳过 hopCost > maxHops 的边
// ============================================================

test("场景 3: spread 跳过 hopCost > maxHops 的边", async () => {
  // seed → A (hopCost=1, 正常), seed → B (hopCost=5, 应跳过), maxHops=2
  const humanLike = makeMockHumanLike(
    [node("seed", "种子"), node("A", "邻居 A"), node("B", "邻居 B")],
    [edge("seed", "A", 1.0, 1), edge("seed", "B", 1.0, 5)],
  );
  const graph = new MemoryAssociativeGraph({ humanLike });

  const result = await graph.spread("actor-1", ["seed"], { maxHops: 2, decay: 0.5 });

  const aNode = result.activatedNodes.find((n) => n.nodeId === "A");
  assert.ok(aNode, "A (hopCost=1 <= maxHops) 应被激活");
  const bNode = result.activatedNodes.find((n) => n.nodeId === "B");
  assert.equal(bNode, undefined, "B (hopCost=5 > maxHops) 应被跳过");
});

// ============================================================
// 场景 4: spread 只返回激活值 > threshold 的节点
// ============================================================

test("场景 4: spread 只返回激活值 > threshold 的节点", async () => {
  // seed → A (w=1.0 → 激活 0.5), seed → B (w=0.1 → 激活 0.05)
  // threshold=0.3 → 只有 A 通过
  const humanLike = makeMockHumanLike(
    [node("seed", "种子"), node("A", "邻居 A"), node("B", "邻居 B")],
    [edge("seed", "A", 1.0, 1), edge("seed", "B", 0.1, 1)],
  );
  const graph = new MemoryAssociativeGraph({ humanLike });

  const result = await graph.spread("actor-1", ["seed"], {
    maxHops: 1,
    decay: 0.5,
    activationThreshold: 0.3,
  });

  const aNode = result.activatedNodes.find((n) => n.nodeId === "A");
  assert.ok(aNode, "A (激活值 0.5 > 0.3) 应在结果中");
  const bNode = result.activatedNodes.find((n) => n.nodeId === "B");
  assert.equal(bNode, undefined, "B (激活值 0.05 <= 0.3) 应被过滤");
});

// ============================================================
// 场景 5: predictAssociation — predictedOutcome 由 summary 拼接
// ============================================================

test("场景 5: predictAssociation — predictedOutcome 由 summary 拼接", async () => {
  // seed1 关键词匹配 "alpha"，扩散到 neighbor1 / neighbor2
  const humanLike = makeMockHumanLike(
    [
      node("seed1", "种子 alpha", ["alpha"], 0.9),
      node("neighbor1", "邻居一的摘要", [], 0.8),
      node("neighbor2", "邻居二的摘要", [], 0.6),
    ],
    [edge("seed1", "neighbor1", 1.0, 1), edge("seed1", "neighbor2", 1.0, 1)],
  );
  const graph = new MemoryAssociativeGraph({ humanLike });

  const result = await graph.predictAssociation("actor-1", "alpha");

  assert.ok(result.seedNodes.includes("seed1"), "seed1 应作为种子");
  assert.equal(result.activatedNodes.length, 2, "应激活 2 个邻居");
  // predictedOutcome 应包含两个邻居的 summary
  assert.ok(
    result.predictedOutcome.includes("邻居一的摘要"),
    `predictedOutcome 应包含 neighbor1 的 summary，实际: ${result.predictedOutcome}`,
  );
  assert.ok(
    result.predictedOutcome.includes("邻居二的摘要"),
    `predictedOutcome 应包含 neighbor2 的 summary，实际: ${result.predictedOutcome}`,
  );
  // confidence = (0.8 + 0.6) / 2 = 0.7
  assert.ok(
    Math.abs(result.confidence - 0.7) < 1e-9,
    `confidence 应为 0.7 (两节点平均)，实际: ${result.confidence}`,
  );
});

// ============================================================
// 场景 6: triggerExplorationIfNeeded — 低置信占比 > 30% 时调用 markShouldExplore
// ============================================================

test("场景 6: triggerExplorationIfNeeded — 低置信占比 > 30% 触发 markShouldExplore", async () => {
  // 4 个激活节点，2 个 confidence < 0.4 → 占比 50% > 30%
  const humanLike = makeMockHumanLike(
    [
      node("seed", "种子"),
      node("n1", "高置信 1", [], 0.9),
      node("n2", "高置信 2", [], 0.8),
      node("n3", "低置信 1", [], 0.2), // < 0.4
      node("n4", "低置信 2", [], 0.3), // < 0.4
    ],
    [],
  );
  const graph = new MemoryAssociativeGraph({
    humanLike,
    knowledgeGapExecutor: null,
  });

  const result = makeSpreadResult(
    ["seed"],
    [
      { nodeId: "n1", activationValue: 0.5, hopCount: 1 },
      { nodeId: "n2", activationValue: 0.5, hopCount: 1 },
      { nodeId: "n3", activationValue: 0.5, hopCount: 1 },
      { nodeId: "n4", activationValue: 0.5, hopCount: 1 },
    ],
  );

  await graph.triggerExplorationIfNeeded("actor-1", result, "test query");

});

test("场景 6b: triggerExplorationIfNeeded — 低置信占比 <= 30% 不触发", async () => {
  // 3 个激活节点，1 个 confidence < 0.4 → 占比 33%... 调整为 3 个中 0 个低置信 = 0%
  const humanLike = makeMockHumanLike(
    [
      node("seed", "种子"),
      node("n1", "高置信 1", [], 0.9),
      node("n2", "高置信 2", [], 0.8),
      node("n3", "高置信 3", [], 0.7),
    ],
    [],
  );
  const graph = new MemoryAssociativeGraph({
    humanLike,
    knowledgeGapExecutor: null,
  });

  const result = makeSpreadResult(
    ["seed"],
    [
      { nodeId: "n1", activationValue: 0.5, hopCount: 1 },
      { nodeId: "n2", activationValue: 0.5, hopCount: 1 },
      { nodeId: "n3", activationValue: 0.5, hopCount: 1 },
    ],
  );

  await graph.triggerExplorationIfNeeded("actor-1", result, "test query");

});

// ============================================================
// 场景 7: triggerExplorationIfNeeded — 异步触发 executeGapQuery 不阻塞
// ============================================================

test("场景 7: triggerExplorationIfNeeded — 异步触发 executeGapQuery 不阻塞", async () => {
  // 2 个激活节点都低置信 → 占比 100% > 30%
  const humanLike = makeMockHumanLike(
    [node("seed", "种子"), node("n1", "低置信 1", [], 0.2), node("n2", "低置信 2", [], 0.3)],
    [],
  );
  const gapExecutor = makeMockGapExecutor({ delayMs: 100, result: "学习结果" });
  const graph = new MemoryAssociativeGraph({
    humanLike,
    knowledgeGapExecutor: gapExecutor,
  });

  const result = makeSpreadResult(
    ["seed"],
    [
      { nodeId: "n1", activationValue: 0.5, hopCount: 1 },
      { nodeId: "n2", activationValue: 0.5, hopCount: 1 },
    ],
  );

  const start = Date.now();
  await graph.triggerExplorationIfNeeded("actor-1", result, "gap query");
  const elapsed = Date.now() - start;

  // 不阻塞：函数应在远小于 100ms 内返回（executeGapQuery 延迟 100ms）
  assert.ok(
    elapsed < 50,
    `triggerExplorationIfNeeded 不应阻塞，elapsed=${elapsed}ms 应 < 50ms（executeGapQuery 延迟 100ms）`,
  );
  // 等待异步 executeGapQuery 完成
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(gapExecutor.calls.length, 1, "executeGapQuery 应在异步完成后被调用 1 次");
  assert.equal(gapExecutor.calls[0], "gap query", "executeGapQuery 应收到原始 query");
});

// ============================================================
// 场景 8: humanLike 为 null 时优雅降级返回空结果
// ============================================================

test("场景 8: humanLike 为 null 时优雅降级返回空结果", async () => {
  const graph = new MemoryAssociativeGraph({
    humanLike: null,
    knowledgeGapExecutor: null,
  });

  // spread 降级
  const spreadResult = await graph.spread("actor-1", ["seed-1"]);
  assert.deepEqual(spreadResult.seedNodeIds, ["seed-1"], "seedNodeIds 应原样返回");
  assert.equal(spreadResult.activatedNodes.length, 0, "activatedNodes 应为空");
  assert.equal(spreadResult.maxHopsReached, 0, "maxHopsReached 应为 0");

  // predictAssociation 降级
  const predictResult = await graph.predictAssociation("actor-1", "query");
  assert.equal(predictResult.seedNodes.length, 0, "seedNodes 应为空");
  assert.equal(predictResult.predictedOutcome, "", "predictedOutcome 应为空字符串");
  assert.equal(predictResult.confidence, 0, "confidence 应为 0");

  // triggerExplorationIfNeeded 降级（不报错）
  const fakeResult = makeSpreadResult(["seed"], [
    { nodeId: "n1", activationValue: 0.5, hopCount: 1 },
  ]);
  await graph.triggerExplorationIfNeeded("actor-1", fakeResult, "query");
  // 不抛错即通过
});

// ============================================================
// 场景 9: 降级开关 BRAIN_MEMORY_ASSOCIATIVE_ENABLED=0 时方法空操作
// ============================================================

test("场景 9: 降级开关 BRAIN_MEMORY_ASSOCIATIVE_ENABLED=0 时方法空操作", async () => {
  await withEnv({ BRAIN_MEMORY_ASSOCIATIVE_ENABLED: "0" }, async () => {
    const humanLike = makeMockHumanLike(
      [node("seed", "种子"), node("A", "邻居 A")],
      [edge("seed", "A", 1.0, 1)],
    );
      const gapExecutor = makeMockGapExecutor({ result: "不应被调用" });
    const graph = new MemoryAssociativeGraph({
      humanLike,
        knowledgeGapExecutor: gapExecutor,
    });

    // spread 空操作
    const spreadResult = await graph.spread("actor-1", ["seed"]);
    assert.equal(spreadResult.activatedNodes.length, 0, "禁用时 spread 应返回空 activatedNodes");
    assert.deepEqual(spreadResult.seedNodeIds, ["seed"], "seedNodeIds 应原样返回");

    // predictAssociation 空操作
    const predictResult = await graph.predictAssociation("actor-1", "query");
    assert.equal(predictResult.seedNodes.length, 0, "禁用时 predictAssociation 应返回空 seedNodes");
    assert.equal(predictResult.predictedOutcome, "", "禁用时 predictedOutcome 应为空");

    // triggerExplorationIfNeeded 空操作
    const fakeResult = makeSpreadResult(["seed"], [
      { nodeId: "n1", activationValue: 0.5, hopCount: 1 },
    ]);
    await graph.triggerExplorationIfNeeded("actor-1", fakeResult, "query");
    await new Promise((r) => setTimeout(r, 10)); // 等待可能的异步调用

    assert.equal(gapExecutor.calls.length, 0, "禁用时不应调用 executeGapQuery");
  });
});

// ============================================================
// 附加: spread 空种子列表时返回空结果
// ============================================================

test("附加: spread 空种子列表时返回空结果", async () => {
  const humanLike = makeMockHumanLike([node("A", "A")], []);
  const graph = new MemoryAssociativeGraph({ humanLike });

  const result = await graph.spread("actor-1", []);
  assert.equal(result.activatedNodes.length, 0, "空种子列表应返回空 activatedNodes");
  assert.equal(result.seedNodeIds.length, 0, "seedNodeIds 应为空");
});

// ============================================================
// 附加: predictAssociation 无关键词匹配时返回空
// ============================================================

test("附加: predictAssociation 无关键词匹配时返回空", async () => {
  const humanLike = makeMockHumanLike(
    [node("n1", "摘要 1", ["alpha"], 0.8), node("n2", "摘要 2", ["beta"], 0.7)],
    [],
  );
  const graph = new MemoryAssociativeGraph({ humanLike });

  const result = await graph.predictAssociation("actor-1", "gamma");
  assert.equal(result.seedNodes.length, 0, "无匹配时 seedNodes 应为空");
  assert.equal(result.predictedOutcome, "", "无匹配时 predictedOutcome 应为空");
});
