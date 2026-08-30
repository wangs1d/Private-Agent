/**
 * MemorySalienceFilter 单元测试 — 情绪标记与显著性守门人。
 *
 * 覆盖场景：
 *  1. 高显著性记忆 → accept=true, degraded=false（normal_write）
 *  2. 低显著性记忆 → accept=false（salience_score_too_low）
 *  3. 中等显著性记忆 → accept=true, degraded=true（degraded_to_decay）
 *  4. 情绪调制召回：高匹配度上浮 score（最高 +0.2）
 *  5. 情绪调制召回：低匹配度下浮 score（最低 -0.1）
 *  6. currentEmotion=null 时不调制
 *  7. 阈值可通过环境变量配置
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MemorySalienceFilter } from "../src/brain/memory-cognitive/memory-salience-filter.js";
import type { MemoryItem, EmotionVector } from "../src/brain/types.js";

// ---- helpers ------------------------------------------------------------

function makeMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    actorId: "test-user",
    kind: "fact",
    content: "测试记忆",
    importance: "medium",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEmotion(overrides: Partial<EmotionVector> = {}): EmotionVector {
  return {
    actorId: "test-user",
    valence: 0,
    arousal: 0.5,
    dominance: 0.5,
    label: "中性",
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 临时设置环境变量，测试结束后恢复 */
async function withEnv<T>(key: string, value: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ---- 场景 1: 高显著性记忆 → normal_write --------------------------------

test("场景 1: 高显著性记忆（critical + emotionValence=0.8）→ accept=true, degraded=false", () => {
  const filter = new MemorySalienceFilter();
  const item = makeMemory({
    importance: "critical",
    content: "用户获得重大职业突破",
    metadata: { emotionValence: 0.8 },
  });

  const decision = filter.evaluateSalience(item);

  // score = 0.9*0.4 + 1.0*0.3 + 0.5*0.2 + 0.5*0.1 = 0.36+0.3+0.1+0.05 = 0.81
  assert.equal(decision.accept, true);
  assert.equal(decision.degraded, false);
  assert.equal(decision.reason, "normal_write");
  assert.equal(decision.score, 0.81);
});

// ---- 场景 2: 低显著性记忆 → reject --------------------------------------

test("场景 2: 低显著性记忆（low + 低情绪/低反馈/低新颖）→ accept=false", () => {
  const filter = new MemorySalienceFilter();
  const item = makeMemory({
    importance: "low",
    content: "嗯嗯好的",
    metadata: { emotionValence: -1, userFeedbackScore: 0, novelty: 0 },
  });

  const decision = filter.evaluateSalience(item);

  // score = 0*0.4 + 0.3*0.3 + 0*0.2 + 0*0.1 = 0.09
  assert.equal(decision.accept, false);
  assert.equal(decision.degraded, false);
  assert.equal(decision.reason, "salience_score_too_low");
  assert.equal(decision.score, 0.09);
});

// ---- 场景 3: 中等显著性记忆 → decay -------------------------------------

test("场景 3: 中等显著性记忆（medium + 弱情绪）→ accept=true, degraded=true", () => {
  const filter = new MemorySalienceFilter();
  const item = makeMemory({
    importance: "medium",
    content: "随口提到天气还行",
    metadata: { emotionValence: -0.5, userFeedbackScore: 0.2, novelty: 0.2 },
  });

  const decision = filter.evaluateSalience(item);

  // score = 0.25*0.4 + 0.5*0.3 + 0.2*0.2 + 0.2*0.1 = 0.1+0.15+0.04+0.02 = 0.31
  assert.equal(decision.accept, true);
  assert.equal(decision.degraded, true);
  assert.equal(decision.reason, "degraded_to_decay");
  assert.equal(decision.score, 0.31);
});

// ---- 场景 4: 情绪调制召回 —— 高匹配度上浮 score --------------------------

test("场景 4: 情绪调制召回 —— 高匹配度 score 上浮（最高 +0.2）", () => {
  const filter = new MemorySalienceFilter();
  const items = [{ content: "焦虑事件记忆", score: 0.5, emotionTags: ["焦虑"] }];
  const emotion = makeEmotion({ label: "焦虑" });

  const result = filter.modulateRecallByEmotion(items, emotion);

  // matchDegree = 1 → 0.5 + 0.2*1 - 0.1*0 = 0.7
  assert.equal(result.length, 1);
  assert.ok(result[0].score! > 0.5, "高匹配度应上浮 score");
  assert.equal(result[0].score, 0.7);
});

// ---- 场景 5: 情绪调制召回 —— 低匹配度下浮 score --------------------------

test("场景 5: 情绪调制召回 —— 低匹配度 score 下浮（最低 -0.1）", () => {
  const filter = new MemorySalienceFilter();
  const items = [{ content: "开心事件记忆", score: 0.5, emotionTags: ["开心"] }];
  const emotion = makeEmotion({ label: "焦虑" });

  const result = filter.modulateRecallByEmotion(items, emotion);

  // matchDegree = 0 → 0.5 + 0 - 0.1*1 = 0.4
  assert.equal(result.length, 1);
  assert.ok(result[0].score! < 0.5, "低匹配度应下浮 score");
  assert.equal(result[0].score, 0.4);
});

// ---- 场景 6: currentEmotion=null 时不调制 -------------------------------

test("场景 6: currentEmotion=null → 原样返回，不调制", () => {
  const filter = new MemorySalienceFilter();
  const items = [
    { content: "记忆 A", score: 0.5, emotionTags: ["焦虑"] },
    { content: "记忆 B", score: 0.8 },
  ];

  const result = filter.modulateRecallByEmotion(items, null);

  assert.equal(result, items, "应返回同一引用，不复制不调制");
  assert.equal(result[0].score, 0.5);
  assert.equal(result[1].score, 0.8);
});

// ---- 场景 7: 阈值可通过环境变量配置 -------------------------------------

test("场景 7a: 环境变量覆盖拒绝阈值 → 原 decay 分数变 reject", async () => {
  // score = 0.5*0.4 + 0.5*0.3 + 0*0.2 + 0*0.1 = 0.2+0.15 = 0.35
  // 默认 reject=0.2 → 0.35 落在 decay 区间（accept=true, degraded=true）
  const item = makeMemory({
    importance: "medium",
    content: "中等记忆",
    metadata: { emotionValence: 0, userFeedbackScore: 0, novelty: 0 },
  });

  const filter = new MemorySalienceFilter();
  const defaultDecision = filter.evaluateSalience(item);
  assert.equal(defaultDecision.accept, true);
  assert.equal(defaultDecision.degraded, true);
  assert.equal(defaultDecision.score, 0.35);

  // 覆盖拒绝阈值到 0.4 → 0.35 < 0.4 → reject
  await withEnv("BRAIN_MEMORY_SALIENCE_REJECT_THRESHOLD", "0.4", async () => {
    const overridden = filter.evaluateSalience(item);
    assert.equal(overridden.accept, false, "提高 reject 阈值后应拒绝");
    assert.equal(overridden.degraded, false);
    assert.equal(overridden.reason, "salience_score_too_low");
    assert.equal(overridden.score, 0.35);
  });
});

test("场景 7b: 环境变量覆盖降级阈值 → 原 normal 分数变 decay", async () => {
  // score = 0.5*0.4 + 0.5*0.3 + 0.5*0.2 + 0.5*0.1 = 0.5
  // 默认 decay=0.4 → 0.5 >= 0.4 → normal_write
  const item = makeMemory({
    importance: "medium",
    content: "全默认中等记忆",
    metadata: { emotionValence: 0, userFeedbackScore: 0.5, novelty: 0.5 },
  });

  const filter = new MemorySalienceFilter();
  const defaultDecision = filter.evaluateSalience(item);
  assert.equal(defaultDecision.accept, true);
  assert.equal(defaultDecision.degraded, false);
  assert.equal(defaultDecision.reason, "normal_write");
  assert.equal(defaultDecision.score, 0.5);

  // 覆盖降级阈值到 0.6 → 0.5 < 0.6 → decay
  await withEnv("BRAIN_MEMORY_SALIENCE_DECAY_THRESHOLD", "0.6", async () => {
    const overridden = filter.evaluateSalience(item);
    assert.equal(overridden.accept, true);
    assert.equal(overridden.degraded, true, "提高 decay 阈值后应降级");
    assert.equal(overridden.reason, "degraded_to_decay");
  });
});

// ---- 边界: emotionValence 边界值归一化 ----------------------------------

test("边界: emotionValence 边界值正确归一化到 0..1", () => {
  const filter = new MemorySalienceFilter();

  // valence=1 → norm 1.0；其余默认 0.5
  // score = 1.0*0.4 + 0.5*0.3 + 0.5*0.2 + 0.5*0.1 = 0.4+0.15+0.1+0.05 = 0.7
  const pos = filter.evaluateSalience(
    makeMemory({ importance: "medium", metadata: { emotionValence: 1 } }),
  );
  assert.equal(pos.score, 0.7);

  // valence=-1 → norm 0.0
  // score = 0*0.4 + 0.5*0.3 + 0.5*0.2 + 0.5*0.1 = 0+0.15+0.1+0.05 = 0.3
  const neg = filter.evaluateSalience(
    makeMemory({ importance: "medium", metadata: { emotionValence: -1 } }),
  );
  assert.equal(neg.score, 0.3);
});

// ---- 边界: 缺省 importance 视为 medium ----------------------------------

test("边界: importance 缺省视为 medium (0.5)", () => {
  const filter = new MemorySalienceFilter();
  const decision = filter.evaluateSalience(
    makeMemory({ importance: undefined, metadata: { emotionValence: 0 } }),
  );
  // score = 0.5*0.4 + 0.5*0.3 + 0.5*0.2 + 0.5*0.1 = 0.5
  assert.equal(decision.score, 0.5);
  assert.equal(decision.reason, "normal_write");
});
