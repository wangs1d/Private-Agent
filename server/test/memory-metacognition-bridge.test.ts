/**
 * MemoryMetacognitionBridge 单元测试。
 *
 * 覆盖 14 个场景：
 *   1. recallWithProvenance：每条 item 附带 provenance 和 confidenceTier
 *   2-6. computeConfidenceTier：各规则分支
 *   7-8. markUnverified：unknown/known 条目的标记行为
 *   9-11. triggerSelfExplorationIfNeeded：触发/不触发/异步不阻塞
 *   12. memoryCortex 为 null 时优雅降级
 *   13. knowledgeGapExecutor 为 null 时不触发探索
 *   14. 降级开关 BRAIN_MEMORY_METACOGNITION_ENABLED=0 时空操作
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryMetacognitionBridge,
  type MemoryCortexLike,
  type KnowledgeVerificationLike,
  type KnowledgeGapExecutorLike,
  type NodeMetaInfo,
} from "../src/brain/memory-cognitive/memory-metacognition-bridge.js";
import type { MemoryRecallItem, MemoryRecallResult } from "../src/brain/types.js";

// ---- helpers ------------------------------------------------------------

/** 临时设置环境变量，测试结束后恢复 */
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env[key];
    else process.env[key] = prev;
  }
}

/** 构造一条 MemoryRecallItem */
function makeItem(overrides: Partial<MemoryRecallItem> = {}): MemoryRecallItem {
  return {
    content: "测试记忆内容",
    domain: "semantic",
    source: "chat",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 构造一个 NodeMetaInfo */
function makeNodeMeta(overrides: Partial<NodeMetaInfo> = {}): NodeMetaInfo {
  return {
    nodeId: "node-test",
    accessCount: 0,
    correctness: "unknown",
    source: "chat",
    sourceType: "chat",
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** mock MemoryCortexLike，记录调用并返回预设结果 */
function makeMockMemoryCortex(items: MemoryRecallItem[]): MemoryCortexLike & {
  calls: number;
  lastOpts: { domain?: string; limit?: number } | undefined;
} {
  const mock = {
    calls: 0,
    lastOpts: undefined as { domain?: string; limit?: number } | undefined,
    async recall(
      actorId: string,
      query: string,
      opts?: { domain?: string; limit?: number },
    ): Promise<MemoryRecallResult> {
      mock.calls++;
      mock.lastOpts = opts;
      return {
        actorId,
        query,
        items,
        domain: "semantic",
        mode: "single_domain",
        recalledAt: new Date().toISOString(),
      };
    },
  };
  return mock;
}

/** 验证状态字面量类型（与 KnowledgeVerificationLike.getStatus 返回类型对齐） */
type MockVerificationStatus =
  | "pending_verification"
  | "verified"
  | "verified_strong"
  | "disputed"
  | "rejected";

/** mock KnowledgeVerificationLike，按 nodeId 返回预设状态 */
function makeMockVerification(
  statusMap: Record<string, MockVerificationStatus> = {},
): KnowledgeVerificationLike & { calls: number } {
  const mock = {
    calls: 0,
    getStatus(knowledgeId: string): MockVerificationStatus | null {
      mock.calls++;
      return statusMap[knowledgeId] ?? null;
    },
  };
  return mock;
}

/** mock KnowledgeGapExecutorLike，记录 executeGapQuery 调用 */
function makeMockGapExecutor(
  result: string | null = "学到的知识",
): KnowledgeGapExecutorLike & {
  calls: number;
  lastQuery: string | undefined;
} {
  const mock = {
    calls: 0,
    lastQuery: undefined as string | undefined,
    executeGapQuery(query: string): Promise<string | null> {
      mock.calls++;
      mock.lastQuery = query;
      return Promise.resolve(result);
    },
  };
  return mock;
}

// ============================================================
// 场景 1: recallWithProvenance：每条 item 附带 provenance 和 confidenceTier
// ============================================================

test("场景 1: recallWithProvenance 为每条 item 附加 provenance 和 confidenceTier", async () => {
  const items = [
    makeItem({ content: "条目 A", source: "chat", timestamp: "2026-01-01T00:00:00.000Z" }),
    makeItem({ content: "条目 B", source: "tool:desktop.http_get", timestamp: "2026-01-02T00:00:00.000Z" }),
  ];
  const mockCortex = makeMockMemoryCortex(items);
  const bridge = new MemoryMetacognitionBridge({
    memoryCortex: mockCortex,
    knowledgeVerification: makeMockVerification(),
    knowledgeGapExecutor: makeMockGapExecutor(),
  });

  const result = await bridge.recallWithProvenance("user-1", "测试查询", { limit: 5 });

  assert.equal(mockCortex.calls, 1, "memoryCortex.recall 应被调用一次");
  assert.equal(result.items.length, 2, "应返回 2 条 item");
  for (const item of result.items) {
    assert.ok(item.provenance, "每条 item 应附带 provenance");
    assert.ok(item.confidenceTier, "每条 item 应附带 confidenceTier");
    assert.ok(
      item.confidenceTier === "known" || item.confidenceTier === "uncertain" || item.confidenceTier === "unknown",
      `confidenceTier 应为合法值，实际: ${item.confidenceTier}`,
    );
    assert.ok(item.provenance.source, "provenance.source 不应为空");
    assert.ok(item.provenance.sourceType, "provenance.sourceType 不应为空");
    assert.ok(item.provenance.capturedAt, "provenance.capturedAt 不应为空");
  }
  // 第二条 source="tool:xxx" → sourceType="tool"
  assert.equal(result.items[1].provenance?.sourceType, "tool", "tool: 前缀应派生为 tool 类型");
});

// ============================================================
// 场景 2: computeConfidenceTier：verified → known
// ============================================================

test("场景 2: computeConfidenceTier — verified → known", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const tier = bridge.computeConfidenceTier(makeNodeMeta({ verificationStatus: "verified" }));
  assert.equal(tier, "known", "verified 应映射为 known");

  const tier2 = bridge.computeConfidenceTier(makeNodeMeta({ verificationStatus: "verified_strong" }));
  assert.equal(tier2, "known", "verified_strong 应映射为 known");
});

// ============================================================
// 场景 3: computeConfidenceTier：pending → uncertain
// ============================================================

test("场景 3: computeConfidenceTier — pending_verification → uncertain", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const tier = bridge.computeConfidenceTier(
    makeNodeMeta({ verificationStatus: "pending_verification" }),
  );
  assert.equal(tier, "uncertain", "pending_verification 应映射为 uncertain");
});

// ============================================================
// 场景 4: computeConfidenceTier：accessCount<3 且 unknown → unknown
// ============================================================

test("场景 4: computeConfidenceTier — accessCount<3 且 correctness=unknown → unknown", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const tier = bridge.computeConfidenceTier(
    makeNodeMeta({ verificationStatus: undefined, correctness: "unknown", accessCount: 2 }),
  );
  assert.equal(tier, "unknown", "correctness=unknown 且 accessCount<3 应为 unknown");
});

// ============================================================
// 场景 5: computeConfidenceTier：accessCount>=3 且 confirmed → known
// ============================================================

test("场景 5: computeConfidenceTier — accessCount>=3 且 confirmed → known", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const tier = bridge.computeConfidenceTier(
    makeNodeMeta({ verificationStatus: undefined, correctness: "confirmed", accessCount: 3 }),
  );
  assert.equal(tier, "known", "correctness=confirmed 且 accessCount>=3 应为 known");

  // accessCount=5 也应为 known
  const tier2 = bridge.computeConfidenceTier(
    makeNodeMeta({ verificationStatus: undefined, correctness: "confirmed", accessCount: 5 }),
  );
  assert.equal(tier2, "known", "correctness=confirmed 且 accessCount=5 应为 known");
});

// ============================================================
// 场景 6: computeConfidenceTier：suspected_error → unknown
// ============================================================

test("场景 6: computeConfidenceTier — suspected_error → unknown", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const tier = bridge.computeConfidenceTier(
    makeNodeMeta({ verificationStatus: undefined, correctness: "suspected_error", accessCount: 10 }),
  );
  assert.equal(tier, "unknown", "suspected_error 应为 unknown（即使 accessCount 高）");

  const tier2 = bridge.computeConfidenceTier(
    makeNodeMeta({ verificationStatus: undefined, correctness: "rejected", accessCount: 10 }),
  );
  assert.equal(tier2, "unknown", "rejected 应为 unknown");

  // disputed/rejected 验证状态也应为 unknown
  const tier3 = bridge.computeConfidenceTier(makeNodeMeta({ verificationStatus: "disputed" }));
  assert.equal(tier3, "unknown", "disputed 应为 unknown");
});

// ============================================================
// 场景 7: markUnverified：unknown 条目前附加"未经证实"标记
// ============================================================

test("场景 7: markUnverified — unknown 条目附加标记，不改原数组", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const original: MemoryRecallItem[] = [
    makeItem({ content: "未证实内容", confidenceTier: "unknown" }),
    makeItem({ content: "已证实内容", confidenceTier: "known" }),
  ];
  const marked = bridge.markUnverified(original);

  // unknown 条目应被附加标记
  assert.ok(
    marked[0].content.startsWith("【此信息未经证实，可能不准确】\n"),
    `unknown 条目应在 content 前附加标记，实际: ${marked[0].content}`,
  );
  assert.ok(
    marked[0].content.includes("未证实内容"),
    "原始 content 应保留在标记之后",
  );

  // 原数组不应被修改
  assert.equal(original[0].content, "未证实内容", "原数组不应被修改");
  assert.equal(original[1].content, "已证实内容", "原数组不应被修改");
});

// ============================================================
// 场景 8: markUnverified：known 条目不附加标记
// ============================================================

test("场景 8: markUnverified — known 条目不附加标记", () => {
  const bridge = new MemoryMetacognitionBridge({});
  const items: MemoryRecallItem[] = [
    makeItem({ content: "已证实内容", confidenceTier: "known" }),
    makeItem({ content: "待证实内容", confidenceTier: "uncertain" }),
  ];
  const marked = bridge.markUnverified(items);

  assert.equal(marked[0].content, "已证实内容", "known 条目不应附加标记");
  assert.equal(marked[1].content, "待证实内容", "uncertain 条目也不应附加标记");
  assert.equal(marked.length, 2, "不应删除任何条目");
});

// ============================================================
// 场景 9: triggerSelfExplorationIfNeeded：unknown 占比 > 50% 触发 executeGapQuery
// ============================================================

test("场景 9: triggerSelfExplorationIfNeeded — unknown 占比 > 50% 触发 executeGapQuery", async () => {
  const mockGap = makeMockGapExecutor();
  const bridge = new MemoryMetacognitionBridge({
    knowledgeGapExecutor: mockGap,
  });

  // 4 条中 3 条 unknown → 75% > 50%
  const items: MemoryRecallItem[] = [
    makeItem({ content: "A", confidenceTier: "unknown" }),
    makeItem({ content: "B", confidenceTier: "unknown" }),
    makeItem({ content: "C", confidenceTier: "unknown" }),
    makeItem({ content: "D", confidenceTier: "known" }),
  ];

  await bridge.triggerSelfExplorationIfNeeded("user-9", items, "查询词");

  assert.equal(mockGap.calls, 1, "executeGapQuery 应被调用一次");
  assert.equal(mockGap.lastQuery, "查询词", "query 应透传");
});

// ============================================================
// 场景 10: triggerSelfExplorationIfNeeded：unknown 占比 ≤ 50% 不触发
// ============================================================

test("场景 10: triggerSelfExplorationIfNeeded — unknown 占比 ≤ 50% 不触发", async () => {
  const mockGap = makeMockGapExecutor();
  const bridge = new MemoryMetacognitionBridge({
    knowledgeGapExecutor: mockGap,
  });

  // 4 条中 2 条 unknown → 50% = 阈值（不大于）→ 不触发
  const items: MemoryRecallItem[] = [
    makeItem({ content: "A", confidenceTier: "unknown" }),
    makeItem({ content: "B", confidenceTier: "unknown" }),
    makeItem({ content: "C", confidenceTier: "known" }),
    makeItem({ content: "D", confidenceTier: "known" }),
  ];

  await bridge.triggerSelfExplorationIfNeeded("user-10", items, "查询词");

  assert.equal(mockGap.calls, 0, "unknown 占比=50% 应不触发 executeGapQuery");

  // 0 条 unknown 也应不触发
  const items2: MemoryRecallItem[] = [
    makeItem({ content: "A", confidenceTier: "known" }),
    makeItem({ content: "B", confidenceTier: "uncertain" }),
  ];
  await bridge.triggerSelfExplorationIfNeeded("user-10b", items2, "查询词");
  assert.equal(mockGap.calls, 0, "0% unknown 应不触发");
});

// ============================================================
// 场景 11: triggerSelfExplorationIfNeeded：异步触发不阻塞
// ============================================================

test("场景 11: triggerSelfExplorationIfNeeded — 异步触发不阻塞调用方", async () => {
  // 用一个可控的 deferred promise，模拟 executeGapQuery 慢返回
  let resolveGap: (v: string | null) => void = () => {};
  let gapCalled = 0;
  const slowPromise = new Promise<string | null>((resolve) => {
    resolveGap = resolve;
  });
  const mockGap: KnowledgeGapExecutorLike = {
    executeGapQuery(_query: string): Promise<string | null> {
      gapCalled++;
      return slowPromise;
    },
  };
  const bridge = new MemoryMetacognitionBridge({
    knowledgeGapExecutor: mockGap,
  });

  const items: MemoryRecallItem[] = [
    makeItem({ content: "A", confidenceTier: "unknown" }),
    makeItem({ content: "B", confidenceTier: "unknown" }),
  ]; // 100% unknown

  const start = Date.now();
  await bridge.triggerSelfExplorationIfNeeded("user-11", items, "查询");
  const elapsed = Date.now() - start;

  // 应在 50ms 内返回（executeGapQuery 还在 pending）
  assert.ok(elapsed < 50, `triggerSelfExplorationIfNeeded 不应被 executeGapQuery 阻塞，实际 elapsed=${elapsed}ms`);
  assert.equal(gapCalled, 1, "executeGapQuery 应已被调用（同步触发）");

  // 释放 deferred，避免悬挂 promise
  resolveGap("学到的知识");
  // 等待一个微任务让 .then() 完成
  await Promise.resolve();
});

// ============================================================
// 场景 12: memoryCortex 为 null 时优雅降级
// ============================================================

test("场景 12: memoryCortex 为 null 时 recallWithProvenance 优雅降级", async () => {
  const bridge = new MemoryMetacognitionBridge({
    memoryCortex: null,
    knowledgeVerification: makeMockVerification(),
    knowledgeGapExecutor: makeMockGapExecutor(),
  });

  const result = await bridge.recallWithProvenance("user-12", "查询");

  assert.equal(result.items.length, 0, "memoryCortex 为 null 时应返回空 items");
  assert.equal(result.actorId, "user-12", "actorId 应透传");
  assert.equal(result.query, "查询", "query 应透传");
  assert.ok(result.recalledAt, "recalledAt 应填充");
});

// ============================================================
// 场景 13: knowledgeGapExecutor 为 null 时不触发探索
// ============================================================

test("场景 13: knowledgeGapExecutor 为 null 时高 unknown 占比也不报错", async () => {
  const bridge = new MemoryMetacognitionBridge({
    knowledgeGapExecutor: null,
  });

  const items: MemoryRecallItem[] = [
    makeItem({ content: "A", confidenceTier: "unknown" }),
    makeItem({ content: "B", confidenceTier: "unknown" }),
  ]; // 100% unknown

  // 不应抛错
  await bridge.triggerSelfExplorationIfNeeded("user-13", items, "查询");
});

// ============================================================
// 场景 14: 降级开关 BRAIN_MEMORY_METACOGNITION_ENABLED=0 时空操作
// ============================================================

test("场景 14: BRAIN_MEMORY_METACOGNITION_ENABLED=0 时所有方法空操作", async () => {
  await withEnv("BRAIN_MEMORY_METACOGNITION_ENABLED", "0", async () => {
    const mockCortex = makeMockMemoryCortex([makeItem({ content: "A" })]);
    const mockGap = makeMockGapExecutor();
      const bridge = new MemoryMetacognitionBridge({
      memoryCortex: mockCortex,
        knowledgeGapExecutor: mockGap,
    });

    // recallWithProvenance 应返回空结果（不调 memoryCortex.recall）
    const result = await bridge.recallWithProvenance("user-14", "查询");
    assert.equal(mockCortex.calls, 0, "禁用时 memoryCortex.recall 不应被调用");
    assert.equal(result.items.length, 0, "禁用时返回空 items");

    // computeConfidenceTier 应统一返回 uncertain（保守）
    const tier = bridge.computeConfidenceTier(makeNodeMeta({ verificationStatus: "verified" }));
    assert.equal(tier, "uncertain", "禁用时 computeConfidenceTier 应返回 uncertain");

    // markUnverified 应原样返回（不附加标记）
    const items: MemoryRecallItem[] = [
      makeItem({ content: "A", confidenceTier: "unknown" }),
    ];
    const marked = bridge.markUnverified(items);
    assert.equal(marked[0].content, "A", "禁用时 markUnverified 不应附加标记");
    assert.equal(marked.length, 1, "禁用时不应删除条目");

    // triggerSelfExplorationIfNeeded 应空操作
    const unknownItems: MemoryRecallItem[] = [
      makeItem({ content: "A", confidenceTier: "unknown" }),
      makeItem({ content: "B", confidenceTier: "unknown" }),
    ];
    await bridge.triggerSelfExplorationIfNeeded("user-14", unknownItems, "查询");
    assert.equal(mockGap.calls, 0, "禁用时 executeGapQuery 不应被调用");
  });
});

// ============================================================
// 额外场景: 配置环境变量 BRAIN_MEMORY_METACOGNITION_EXPLORE_THRESHOLD
// ============================================================

test("额外: BRAIN_MEMORY_METACOGNITION_EXPLORE_THRESHOLD 可调整触发阈值", async () => {
  await withEnv("BRAIN_MEMORY_METACOGNITION_EXPLORE_THRESHOLD", "0.3", async () => {
    const mockGap = makeMockGapExecutor();
    const bridge = new MemoryMetacognitionBridge({ knowledgeGapExecutor: mockGap });

    // 2 条中 1 条 unknown → 50% > 30%（自定义阈值）→ 触发
    const items: MemoryRecallItem[] = [
      makeItem({ content: "A", confidenceTier: "unknown" }),
      makeItem({ content: "B", confidenceTier: "known" }),
    ];
    await bridge.triggerSelfExplorationIfNeeded("user-x", items, "q");
    assert.equal(mockGap.calls, 1, "阈值=0.3 时 50% unknown 应触发");
  });
});

// ============================================================
// 额外场景: 配置环境变量 BRAIN_MEMORY_METACOGNITION_CONFIRM_THRESHOLD
// ============================================================

test("额外: BRAIN_MEMORY_METACOGNITION_CONFIRM_THRESHOLD 可调整确认阈值", () => {
  // confirmThreshold=5，accessCount=3 < 5 → uncertain（不是 known）
  return withEnv("BRAIN_MEMORY_METACOGNITION_CONFIRM_THRESHOLD", "5", async () => {
    const bridge = new MemoryMetacognitionBridge({});
    const tier = bridge.computeConfidenceTier(
      makeNodeMeta({ correctness: "confirmed", accessCount: 3 }),
    );
    assert.equal(tier, "uncertain", "confirmThreshold=5 时 accessCount=3 应为 uncertain");

    const tier2 = bridge.computeConfidenceTier(
      makeNodeMeta({ correctness: "confirmed", accessCount: 5 }),
    );
    assert.equal(tier2, "known", "confirmThreshold=5 时 accessCount=5 应为 known");
  });
});
