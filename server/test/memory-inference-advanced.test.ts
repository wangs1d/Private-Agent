/**
 * 4 项仿人推理能力扩展测试（12 个场景）。
 *
 * 覆盖：
 *   RuleLearner（规则自学习）— 场景 1-3
 *   AnalogyMigrator（类比迁移）— 场景 4-6
 *   InferenceEmotionModulator（情感调制）— 场景 7-9
 *   BrainStemAutoInferer（无意识触发）— 场景 10-12
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryInferenceEngine,
  type HumanLikeMemoryInferenceLike,
} from "../src/brain/memory-cognitive/memory-inference-engine.js";
import {
  RuleLearner,
  type LearnedRule,
} from "../src/brain/memory-cognitive/memory-inference-rule-learner.js";
import {
  AnalogyMigrator,
  type MigratedRule,
} from "../src/brain/memory-cognitive/memory-inference-analogy-migrator.js";
import {
  InferenceEmotionModulator,
  type EmotionState,
} from "../src/brain/memory-cognitive/memory-inference-emotion-modulator.js";
import {
  BrainStemAutoInferer,
} from "../src/brain/memory-cognitive/memory-inference-brain-stem-auto-inferer.js";
import type { InferenceClue, InferenceNode } from "../src/brain/types.js";

// ============================================================
// mock 工厂
// ============================================================

type MockNode = {
  id: string;
  summary: string;
  keywords: string[];
  confidence: number;
  lastAccessedAt?: string;
};

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
  return {
    ingestCalls,
    getAllNodes: () => nodes,
    getAllEdges: () => edges,
    ingestInferredNode(actorId: string, node: InferenceNode): void {
      ingestCalls.push({ actorId, node });
    },
  };
}

// ============================================================
// RuleLearner（规则自学习）— 场景 1-3
// ============================================================

// 场景 1: 从共现关键词学习新规则
test("场景 1: RuleLearner 从共现关键词学习新规则", async () => {
  // 构造 4 个节点，"加班" 和 "咖啡" 在其中 3 个节点中同时出现
  const nodes: MockNode[] = [
    { id: "n1", summary: "今天加班到很晚", keywords: ["加班", "咖啡"], confidence: 0.8 },
    { id: "n2", summary: "加班期间喝了两杯咖啡", keywords: ["加班", "咖啡"], confidence: 0.8 },
    { id: "n3", summary: "又加班了，照例喝咖啡提神", keywords: ["加班", "咖啡"], confidence: 0.8 },
    { id: "n4", summary: "周末休息", keywords: ["休息"], confidence: 0.7 },
  ];
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const learner = new RuleLearner({ humanLike, minCoOccurrence: 3 });

  const learned = await learner.learnRules(engine, "actor-1");

  assert.ok(learned.length >= 1, `应至少学习 1 条规则，实际: ${learned.length}`);
  const rule = learned[0]!;
  assert.ok(rule.learned === true, "学习规则应有 learned=true 标记");
  assert.ok(rule.coOccurrenceCount >= 3, `共现次数应 >= 3，实际: ${rule.coOccurrenceCount}`);
  assert.ok(
    rule.requiredTags.includes("加班") && rule.requiredTags.includes("咖啡"),
    `requiredTags 应包含 "加班" 和 "咖啡"，实际: ${JSON.stringify(rule.requiredTags)}`,
  );
  assert.ok(rule.baseConfidence === 0.4, `未验证规则 baseConfidence 应为 0.4，实际: ${rule.baseConfidence}`);

  // 验证热更新：新规则应已注册到引擎
  const allRules = engine.getRules();
  const found = allRules.find((r) => r.id === rule.id);
  assert.ok(found, "学习规则应已注册到引擎（热更新）");
});

// 场景 2: 已学习规则不重复学习（去重）
test("场景 2: RuleLearner 已学习规则不重复学习（去重）", async () => {
  const nodes: MockNode[] = [
    { id: "n1", summary: "健身后喝蛋白粉", keywords: ["健身", "蛋白粉"], confidence: 0.8 },
    { id: "n2", summary: "健身搭配蛋白粉效果好", keywords: ["健身", "蛋白粉"], confidence: 0.8 },
    { id: "n3", summary: "每天健身后补充蛋白粉", keywords: ["健身", "蛋白粉"], confidence: 0.8 },
  ];
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const learner = new RuleLearner({ humanLike, minCoOccurrence: 3 });

  const firstBatch = await learner.learnRules(engine, "actor-2");
  assert.ok(firstBatch.length >= 1, "首次学习应成功");

  const secondBatch = await learner.learnRules(engine, "actor-2");
  assert.equal(secondBatch.length, 0, "相同关键词对不应重复学习");

  // getLearnedRules 仍返回首次学习的结果
  assert.equal(learner.getLearnedRules().length, firstBatch.length);
});

// 场景 3: 单次学习限流（最多 5 条）
test("场景 3: RuleLearner 单次学习限流（最多 5 条）", async () => {
  // 构造 6 对共现关键词，每对在 3 个节点中出现
  const pairs = [
    ["alpha", "beta"],
    ["gamma", "delta"],
    ["epsilon", "zeta"],
    ["eta", "theta"],
    ["iota", "kappa"],
    ["lambda", "mu"],
  ];
  const nodes: MockNode[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i]!;
    for (let j = 0; j < 3; j++) {
      nodes.push({
        id: `n-${i}-${j}`,
        summary: `${a} and ${b} cooccur ${j}`,
        keywords: [a, b],
        confidence: 0.8,
      });
    }
  }

  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const learner = new RuleLearner({ humanLike, minCoOccurrence: 3 });

  const learned = await learner.learnRules(engine, "actor-3");
  assert.ok(
    learned.length <= 5,
    `单次学习最多 5 条规则，实际: ${learned.length}`,
  );
  assert.ok(learned.length === 5, `应有 5 条规则（6 对中取前 5），实际: ${learned.length}`);
});

// ============================================================
// AnalogyMigrator（类比迁移）— 场景 4-6
// ============================================================

// 场景 4: Jaccard 相似度计算
test("场景 4: AnalogyMigrator Jaccard 相似度计算", () => {
  const migrator = new AnalogyMigrator();

  // 完全相同
  assert.equal(migrator.jaccardSimilarity(["a", "b"], ["a", "b"]), 1.0);
  // 完全不同
  assert.equal(migrator.jaccardSimilarity(["a", "b"], ["c", "d"]), 0.0);
  // 部分重叠：交集 1，并集 3 → 1/3
  const score = migrator.jaccardSimilarity(["a", "b"], ["b", "c"]);
  assert.ok(Math.abs(score - 1 / 3) < 1e-9, `部分重叠 Jaccard 应为 1/3，实际: ${score}`);
  // 空集
  assert.equal(migrator.jaccardSimilarity([], ["a"]), 0);
  assert.equal(migrator.jaccardSimilarity(["a"], []), 0);
  // 大小写不敏感
  assert.equal(migrator.jaccardSimilarity(["Hello"], ["hello"]), 1.0);
});

// 场景 5: 高相似度时迁移规则
test("场景 5: AnalogyMigrator 高相似度时迁移规则", () => {
  // 构造一条已有规则，requiredTags 为 ["拼多多", "加群"]
  // 线索关键词包含 "拼多多" 和 "加群" → Jaccard > threshold
  // 注意：tokenizer 按空格/标点分词，中文需用空格分隔才能正确分词
  const migrator = new AnalogyMigrator({ similarityThreshold: 0.3 });
  const clues: InferenceClue[] = [
    { text: "拼多多 加群 有人拉我", source: "user_input" },
    { text: "拼多多 加群 领奖励", source: "user_input" },
  ];
  const existingRules = [
    {
      id: "test_rule",
      name: "测试规则",
      description: "测试",
      requiredTags: ["拼多多", "加群"],
      patterns: { clueAPattern: /拼多多/, clueBPattern: /加群/ },
      template: "拼多多加群",
      baseConfidence: 0.6,
    },
  ];

  const migrated = migrator.migrateRules(clues, existingRules);
  // 线索中有 "拼多多" 和 "加群" → 与 requiredTags 有交集 → 应迁移
  assert.ok(migrated.length >= 1, `高相似度应迁移规则，实际: ${migrated.length}`);
  const m = migrated[0]!;
  assert.ok(m.migrated === true, "迁移规则应有 migrated=true 标记");
  assert.ok(m.sourceRuleId === "test_rule", `sourceRuleId 应为 "test_rule"，实际: ${m.sourceRuleId}`);
  assert.ok(m.similarity > 0.3, `相似度应 > 0.3，实际: ${m.similarity}`);
  // 迁移损耗：新置信度 = 原置信度 * similarity * 0.8 < 原置信度
  assert.ok(
    m.baseConfidence < existingRules[0]!.baseConfidence,
    `迁移规则置信度应 < 原置信度（迁移损耗），实际: ${m.baseConfidence}`,
  );
});

// 场景 6: 低相似度时不迁移
test("场景 6: AnalogyMigrator 低相似度时不迁移", () => {
  const migrator = new AnalogyMigrator({ similarityThreshold: 0.8 });
  const clues: InferenceClue[] = [
    { text: "今天天气真好", source: "user_input" },
    { text: "出去散步了", source: "user_input" },
  ];
  const existingRules = [
    {
      id: "weather_rule",
      name: "天气规则",
      description: "天气相关",
      requiredTags: ["拼多多", "加群"],
      patterns: { clueAPattern: /拼多多/, clueBPattern: /加群/ },
      template: "拼多多加群",
      baseConfidence: 0.6,
    },
  ];

  const migrated = migrator.migrateRules(clues, existingRules);
  assert.equal(migrated.length, 0, "低相似度不应迁移规则");
});

// ============================================================
// InferenceEmotionModulator（情感调制）— 场景 7-9
// ============================================================

// 场景 7: 高唤醒度加成
test("场景 7: InferenceEmotionModulator 高唤醒度加成", () => {
  const modulator = new InferenceEmotionModulator();
  const highArousal: EmotionState = { arousal: 0.9, valence: 0.0, dominance: 0.5 };
  const adjusted = modulator.modulate(0.6, highArousal);
  // arousal > 0.7 → +0.1
  assert.ok(
    Math.abs(adjusted - 0.7) < 1e-9,
    `高唤醒应 +0.1 → 0.7，实际: ${adjusted}`,
  );

  // 叠加正向情绪
  const happy: EmotionState = { arousal: 0.9, valence: 0.8, dominance: 0.5 };
  const adjustedHappy = modulator.modulate(0.6, happy);
  // +0.1 (arousal) + 0.05 (valence) = 0.75
  assert.ok(
    Math.abs(adjustedHappy - 0.75) < 1e-9,
    `高唤醒+正向应 +0.15 → 0.75，实际: ${adjustedHappy}`,
  );
});

// 场景 8: 负向情绪惩罚
test("场景 8: InferenceEmotionModulator 负向情绪惩罚", () => {
  const modulator = new InferenceEmotionModulator();
  const negative: EmotionState = { arousal: 0.2, valence: -0.6, dominance: 0.3 };
  const adjusted = modulator.modulate(0.7, negative);
  // arousal < 0.3 → -0.05, valence < -0.3 → -0.1
  // 0.7 - 0.05 - 0.1 = 0.55
  assert.ok(
    Math.abs(adjusted - 0.55) < 1e-9,
    `负向情绪应 -0.15 → 0.55，实际: ${adjusted}`,
  );
});

// 场景 9: emotion=null 时不调制 + clamp 到 [0,1]
test("场景 9: InferenceEmotionModulator emotion=null 不调制 + clamp", () => {
  const modulator = new InferenceEmotionModulator();

  // null 不调制
  const noMod = modulator.modulate(0.6, null);
  assert.equal(noMod, 0.6, "emotion=null 时应返回原值");

  // clamp 上限
  const extreme: EmotionState = { arousal: 0.9, valence: 0.9, dominance: 0.9 };
  const clampedHigh = modulator.modulate(0.95, extreme);
  // 0.95 + 0.1 + 0.05 + 0.05 = 1.15 → clamp 到 1.0
  assert.equal(clampedHigh, 1.0, "置信度应 clamp 到 1.0");

  // clamp 下限
  const veryNegative: EmotionState = { arousal: 0.1, valence: -0.9, dominance: 0.1 };
  const clampedLow = modulator.modulate(0.05, veryNegative);
  // 0.05 - 0.05 - 0.1 = -0.1 → clamp 到 0
  assert.equal(clampedLow, 0, "置信度应 clamp 到 0");
});

// ============================================================
// BrainStemAutoInferer（无意识触发）— 场景 10-12
// ============================================================

// 场景 10: 限频 — 首次心跳跳过（interval=2）
test("场景 10: BrainStemAutoInferer 限频 — 首次心跳跳过", async () => {
  const nodes: MockNode[] = [
    { id: "n1", summary: "朋友让我加拼多多群", keywords: ["拼多多", "加群"], confidence: 0.8 },
    { id: "n2", summary: "朋友圈看到拼多多奖励", keywords: ["拼多多", "奖励"], confidence: 0.8 },
  ];
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const autoInferer = new BrainStemAutoInferer({
    inferenceEngine: engine,
    humanLike,
    interval: 2,
  });

  // 第一次心跳：counter=1 < interval=2 → 跳过
  await autoInferer.onHeartbeat("actor-10");

  const stats = autoInferer.getStats();
  assert.equal(stats.totalAutoInferences, 0, "首次心跳不应执行推理");
  assert.equal(stats.totalSkipped, 1, "应记录 1 次跳过");
});

// 场景 11: 达到 interval 时执行推理
test("场景 11: BrainStemAutoInferer 达到 interval 时执行推理", async () => {
  const nodes: MockNode[] = [
    { id: "n1", summary: "朋友让我加拼多多群", keywords: ["拼多多", "加群"], confidence: 0.8, lastAccessedAt: "2026-01-01T00:00:00Z" },
    { id: "n2", summary: "朋友圈看到拼多多助力奖励", keywords: ["拼多多", "助力"], confidence: 0.8, lastAccessedAt: "2026-01-02T00:00:00Z" },
  ];
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const autoInferer = new BrainStemAutoInferer({
    inferenceEngine: engine,
    humanLike,
    interval: 2,
  });

  // 第一次心跳：跳过
  await autoInferer.onHeartbeat("actor-11");
  // 第二次心跳：counter=2 >= interval=2 → 执行
  await autoInferer.onHeartbeat("actor-11");

  const stats = autoInferer.getStats();
  assert.equal(stats.totalAutoInferences, 1, "第二次心跳应执行推理");
  assert.equal(stats.totalSkipped, 1, "首次心跳跳过");

  // 验证推理结果已存入引擎缓存
  const inferences = engine.getInferences("actor-11");
  assert.ok(inferences.length >= 1, "推理结果应存入引擎缓存");
});

// 场景 12: 线索不足时不推理
test("场景 12: BrainStemAutoInferer 线索不足时不推理", async () => {
  // 只有 1 个节点 → extractClues 返回 1 条线索 → < 2 不推理
  const nodes: MockNode[] = [
    { id: "n1", summary: "只有一条记忆", keywords: ["单一"], confidence: 0.8 },
  ];
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const autoInferer = new BrainStemAutoInferer({
    inferenceEngine: engine,
    humanLike,
    interval: 1, // interval=1 确保首次就执行
  });

  await autoInferer.onHeartbeat("actor-12");

  const stats = autoInferer.getStats();
  // totalAutoInferences 统计的是 inferFromClues 调用次数
  // 线索不足 < 2 时 inferFromClues 不会被调用（在 extractClues 后提前 return）
  assert.equal(stats.totalAutoInferences, 0, "线索不足不应触发推理");
});
