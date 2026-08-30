/**
 * MemoryInferenceEngine 单元测试。
 *
 * 覆盖 8 个场景：
 *   A. 单条线索不触发推理
 *   B. 两条无关线索不触发推理（无规则匹配）
 *   C. 拼多多场景触发推理（关键测试）
 *   D. 三条线索置信度叠加（+0.1 加成）
 *   E. 推理结论回写（high confidence → ingestInferredNode 调用 + keywords 包含 "推理"）
 *   F. 相同线索不重复推理（FNV-1a hash 去重）
 *   G. 主开关关闭时不推理
 *   H. 自定义规则注册
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryInferenceEngine,
  type HumanLikeMemoryInferenceLike,
  type InferenceRule,
} from "../src/brain/memory-cognitive/memory-inference-engine.js";
import type { InferenceClue, InferenceNode } from "../src/brain/types.js";
import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";

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
};

/** 构造 mock HumanLikeMemoryInferenceLike（追踪 ingestInferredNode 调用） */
function makeMockHumanLike(
  nodes: MockNode[] = [],
  edges: MockEdge[] = [],
): HumanLikeMemoryInferenceLike & {
  ingestCalls: Array<{ actorId: string; node: InferenceNode }>;
} {
  const ingestCalls: Array<{ actorId: string; node: InferenceNode }> = [];
  const mock: HumanLikeMemoryInferenceLike & { ingestCalls: typeof ingestCalls } = {
    ingestCalls,
    getAllNodes: () => nodes,
    getAllEdges: () => edges,
    ingestInferredNode(actorId: string, node: InferenceNode): void {
      ingestCalls.push({ actorId, node });
    },
  };
  return mock;
}

/** 临时设置环境变量，测试结束后恢复 */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
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

// ============================================================
// 场景 A: 单条线索不触发推理
// ============================================================

test("场景 A: 单条线索不触发推理", async () => {
  const humanLike = makeMockHumanLike();
  const engine = new MemoryInferenceEngine({ humanLike });

  const result = await engine.inferFromClues("actor-A", [
    { text: "朋友让我加群", source: "user_input" },
  ]);

  assert.equal(result.inferences.length, 0, "单条线索不应触发推理");
  assert.equal(result.combinedConfidence, 0);
  assert.equal(humanLike.ingestCalls.length, 0, "未触发回写");
});

// ============================================================
// 场景 B: 两条无关线索不触发推理
// ============================================================

test("场景 B: 两条无关线索不触发推理", async () => {
  const humanLike = makeMockHumanLike();
  const engine = new MemoryInferenceEngine({ humanLike });

  const result = await engine.inferFromClues("actor-B", [
    { text: "今天天气不错", source: "user_input" },
    { text: "晚饭吃面条", source: "user_input" },
  ]);

  assert.equal(result.inferences.length, 0, "无关线索不应匹配规则");
  assert.equal(humanLike.ingestCalls.length, 0, "未触发回写");
});

// ============================================================
// 场景 C: 拼多多场景触发推理（关键测试）
// ============================================================

test("场景 C: 拼多多场景触发推理", async () => {
  const humanLike = makeMockHumanLike();
  const engine = new MemoryInferenceEngine({ humanLike });

  const result = await engine.inferFromClues("actor-C", [
    { text: "朋友发消息让我帮他加一个群", source: "user_input" },
    { text: "朋友在朋友圈晒获得了拼多多奖励", source: "user_input" },
  ]);

  assert.ok(result.inferences.length >= 1, "应至少触发 1 条推理");
  const inf = result.inferences[0]!;
  assert.ok(inf.conclusion.includes("拼多多"), `结论应包含 "拼多多"，实际: ${inf.conclusion}`);
  assert.ok(inf.conclusion.includes("助力"), `结论应包含 "助力"，实际: ${inf.conclusion}`);
  assert.ok(
    inf.confidence >= 0.6,
    `置信度应 >= 0.6（规则 base 0.6 + 2 线索 +0.1 = 0.7），实际: ${inf.confidence}`,
  );
  assert.ok(
    inf.evidence.rules.includes("help_purpose_pdd"),
    `evidence.rules 应包含 "help_purpose_pdd"，实际: ${JSON.stringify(inf.evidence.rules)}`,
  );
  assert.ok(
    inf.evidence.clues.length >= 2,
    `evidence.clues 长度应 >= 2，实际: ${inf.evidence.clues.length}`,
  );
  // confidence > 0.6 应触发回写
  assert.ok(
    humanLike.ingestCalls.length >= 1,
    "高置信结论应回写到 humanLike",
  );
  assert.ok(
    humanLike.ingestCalls[0]!.node.confidence > 0.6,
    "回写的节点 confidence 应 > 0.6",
  );
});

// ============================================================
// 场景 D: 三条线索置信度叠加
// ============================================================

test("场景 D: 三条线索置信度叠加（比场景 C 高 +0.1）", async () => {
  const humanLikeC = makeMockHumanLike();
  const engineC = new MemoryInferenceEngine({ humanLike: humanLikeC });
  const resultC = await engineC.inferFromClues("actor-D", [
    { text: "朋友发消息让我帮他加一个群", source: "user_input" },
    { text: "朋友在朋友圈晒获得了拼多多奖励", source: "user_input" },
  ]);

  const humanLikeD = makeMockHumanLike();
  const engineD = new MemoryInferenceEngine({ humanLike: humanLikeD });
  // 三条线索：原 2 条 + 历史经验 1 条
  const resultD = await engineD.inferFromClues("actor-D", [
    { text: "朋友发消息让我帮他加一个群", source: "user_input" },
    { text: "朋友在朋友圈晒获得了拼多多奖励", source: "user_input" },
    { text: "上次帮他点助力他拿到了 100 元红包", source: "memory_recalled" },
  ]);

  assert.ok(resultC.inferences.length >= 1, "场景 C 应触发推理");
  assert.ok(resultD.inferences.length >= 1, "场景 D 应触发推理");

  const confC = resultC.inferences[0]!.confidence;
  const confD = resultD.inferences[0]!.confidence;
  // 2 线索：base 0.6 + 0.1 = 0.7
  // 3 线索：base 0.6 + 0.2 = 0.8
  // 差 0.1
  assert.ok(
    Math.abs((confD - confC) - 0.1) < 1e-9,
    `3 线索应比 2 线索多 +0.1，实际: confC=${confC}, confD=${confD}, diff=${confD - confC}`,
  );
});

// ============================================================
// 场景 E: 推理结论回写（real HumanLikeMemoryService.ingestInferredNode）
// ============================================================

test("场景 E: 推理结论回写 — 回写节点 keywords 包含 '推理'", async () => {
  // 用 mock 推理引擎 + 真实 HumanLikeMemoryService 验证回写
  // 1. 推理引擎用 mock humanLike 捕获 ingestInferredNode 调用
  const humanLikeMock = makeMockHumanLike();
  const engine = new MemoryInferenceEngine({ humanLike: humanLikeMock });

  const result = await engine.inferFromClues("actor-E", [
    { text: "朋友发消息让我帮他加一个群", source: "user_input" },
    { text: "朋友在朋友圈晒获得了拼多多奖励", source: "user_input" },
  ]);

  assert.ok(result.inferences.length >= 1, "应触发推理");
  assert.ok(result.inferences[0]!.confidence > 0.6, "confidence 应 > 0.6");
  assert.ok(
    humanLikeMock.ingestCalls.length >= 1,
    "ingestInferredNode 应被调用",
  );

  // 2. 把捕获的 InferenceNode 喂给真实 HumanLikeMemoryService.ingestInferredNode
  const tmpDir = mkdtempSync(join(tmpdir(), "memory-inference-test-"));
  const memFile = join(tmpDir, "memory.json");
  const policyFile = join(tmpDir, "policy.json");
  const svc = new HumanLikeMemoryService(memFile, policyFile);
  try {
    await svc.load();

    const inferredNode = humanLikeMock.ingestCalls[0]!.node;
    svc.ingestInferredNode("actor-E", inferredNode);

    // 3. 验证回写的节点 keywords 包含 "推理"
    const allNodes = svc.getAllNodes("actor-E");
    const inferredRecord = allNodes.find((n) =>
      n.summary === inferredNode.conclusion,
    );
    assert.ok(inferredRecord, "回写的节点应能在 getAllNodes 中找到");
    assert.ok(
      inferredRecord!.keywords.includes("推理"),
      `回写节点的 keywords 应包含 "推理"，实际: ${JSON.stringify(inferredRecord!.keywords)}`,
    );
    assert.ok(
      Math.abs(inferredRecord!.confidence - inferredNode.confidence) < 1e-9,
      `回写节点 confidence 应等于推理 confidence，实际: ${inferredRecord!.confidence}`,
    );
    assert.equal(
      inferredRecord!.metadata?.inferred,
      true,
      "回写节点应携带 metadata.inferred=true",
    );
  } finally {
    // 先 shutdown 释放 FSWatcher + 等待 persistChain，再删 tmp 目录
    await svc.shutdown().catch(() => {
      /* 静默 */
    });
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// 场景 F: 相同线索不重复推理（去重）
// ============================================================

test("场景 F: 相同线索不重复推理（FNV-1a hash 去重）", async () => {
  const humanLike = makeMockHumanLike();
  const engine = new MemoryInferenceEngine({ humanLike });

  const clues: InferenceClue[] = [
    { text: "朋友发消息让我帮他加一个群", source: "user_input" },
    { text: "朋友在朋友圈晒获得了拼多多奖励", source: "user_input" },
  ];

  // 第一次推理
  const result1 = await engine.inferFromClues("actor-F", clues);
  assert.ok(result1.inferences.length >= 1, "第一次推理应触发");

  // 第二次相同线索推理 → 应去重（返回空）
  const result2 = await engine.inferFromClues("actor-F", clues);
  assert.equal(
    result2.inferences.length,
    0,
    "相同 conclusion 文本不应重复生成",
  );

  // getInferences 应返回第一次的结论
  const allInferences = engine.getInferences("actor-F");
  assert.ok(allInferences.length >= 1, "actor-F 应有缓存的推理结论");
});

// ============================================================
// 场景 G: 主开关关闭时不推理
// ============================================================

test("场景 G: 主开关 BRAIN_MEMORY_INFERENCE_ENABLED=0 时不推理", async () => {
  await withEnv({ BRAIN_MEMORY_INFERENCE_ENABLED: "0" }, async () => {
    const humanLike = makeMockHumanLike();
    const engine = new MemoryInferenceEngine({ humanLike });

    const result = await engine.inferFromClues("actor-G", [
      { text: "朋友发消息让我帮他加一个群", source: "user_input" },
      { text: "朋友在朋友圈晒获得了拼多多奖励", source: "user_input" },
    ]);

    assert.equal(result.inferences.length, 0, "开关关闭时不应推理");
    assert.equal(result.combinedConfidence, 0);
    assert.equal(humanLike.ingestCalls.length, 0, "未触发回写");
  });
});

// ============================================================
// 场景 H: 自定义规则注册
// ============================================================

test("场景 H: 自定义规则注册", async () => {
  const humanLike = makeMockHumanLike();
  const engine = new MemoryInferenceEngine({ humanLike });

  // 注册自定义规则：A 和 B 同时出现 → 推断 "A 配 B"
  const customRule: InferenceRule = {
    id: "custom_ab_inference",
    name: "自定义 AB 推断",
    description: "A + B → A 配 B",
    requiredTags: ["咖啡", "牛奶"],
    patterns: {
      clueAPattern: /咖啡/,
      clueBPattern: /牛奶/,
    },
    template: "咖啡配牛奶就是拿铁",
    baseConfidence: 0.7,
  };
  engine.registerRule(customRule);

  const result = await engine.inferFromClues("actor-H", [
    { text: "今天买了一杯咖啡", source: "user_input" },
    { text: "冰箱里还有一盒牛奶", source: "user_input" },
  ]);

  assert.ok(result.inferences.length >= 1, "自定义规则应触发推理");
  const inf = result.inferences[0]!;
  assert.equal(
    inf.conclusion,
    "咖啡配牛奶就是拿铁",
    `结论应来自自定义模板，实际: ${inf.conclusion}`,
  );
  assert.ok(
    inf.evidence.rules.includes("custom_ab_inference"),
    `evidence.rules 应包含 "custom_ab_inference"，实际: ${JSON.stringify(inf.evidence.rules)}`,
  );
  assert.ok(
    inf.confidence >= 0.7,
    `置信度应 >= 0.7（base 0.7 + 2 线索 +0.1 = 0.8），实际: ${inf.confidence}`,
  );
});
