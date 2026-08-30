/**
 * 记忆模块整体优化（本轮 P0/P1/P2）行为测试：
 * - P1-1 RecallQueryExpander：指代消解补上下文实体、多意图拆分、普通查询不误扩展
 * - P1-3 隐式反馈检测：纠正/认同/换话题 → 正/负/弱负信号
 * - P2-1 MemoryInventory：目录统计、TTL 缓存、同步缓存读（prompt 注入路径）
 * - P0-1 UserProfileAggregator：强信号快速路径真实落盘 USER_PROFILE.md（幂等）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandRecallQuery } from "../src/brain/memory-query-expander.js";
import { detectImplicitFeedback } from "../src/brain/memory-implicit-feedback.js";
import { MemoryInventory } from "../src/brain/memory-inventory.js";
import { UserProfileAggregator } from "../src/brain/user-profile-aggregator.js";

// ── P1-1：召回查询扩展 ──────────────────────────────────────

test("P1-1 指代消解：短 query「它呢」拼上上轮话题实体", () => {
  const r = expandRecallQuery({
    query: "它的新模型呢",
    recentConversationHistory: "用户: Kimi K3 最近发布了\n助手: 是的，Kimi K3 是月之暗面的新模型。",
  });
  assert.ok(r.expanded, "有历史 + 短 query 应触发扩展");
  assert.ok(r.primaryQuery.includes("Kimi") || r.primaryQuery.includes("kimi"), `主 query 应含上轮实体，实际: ${r.primaryQuery}`);
});

test("P1-1 多意图拆分：「A 和 B 的并发性能对比」拆出 2 个子意图", () => {
  const r = expandRecallQuery({ query: "Python 和 Rust 的并发性能对比" });
  assert.ok(r.subQueries.length >= 2, `应拆出 ≥2 个子 query，实际 ${r.subQueries.length}`);
  assert.ok(r.subQueries.some((q) => q.includes("Python")), "子意图应覆盖 Python");
  assert.ok(r.subQueries.some((q) => q.includes("Rust")), "子意图应覆盖 Rust");
});

test("P1-1 普通完整 query 不误扩展", () => {
  const r = expandRecallQuery({ query: "帮我推荐几个适合程序员的机械键盘" });
  assert.equal(r.expanded, false, "无指代、意图单一不应扩展");
  assert.equal(r.primaryQuery, "帮我推荐几个适合程序员的机械键盘");
  assert.equal(r.subQueries.length, 1);
});

test("P1-1 空查询返回空结果", () => {
  const r = expandRecallQuery({ query: "   " });
  assert.equal(r.primaryQuery, "");
  assert.deepEqual(r.subQueries, []);
});

test("P1-1 修复：短 query「好想她」补上历史高频实体「刘浩存」，过滤工具杂讯与当前行", () => {
  const history = [
    "用户：帮我搜一下刘浩存最近的照片",
    "Agent：搜到了，她最近还挺活跃的。",
    "用户：再帮我找找刘浩存的写真",
    "Agent：agent 上一轮工具调用尚未完成即，正在重试搜索",
    "用户：好想她", // 当前 query 行，扩展时应被排除（不得自我扩展）
  ].join("\n");
  const r = expandRecallQuery({ query: "好想她", recentConversationHistory: history });
  assert.ok(r.expanded, "短 query 应触发扩展");
  assert.ok(r.primaryQuery.includes("刘浩存"), `扩展应补入「刘浩存」，实际: ${r.primaryQuery}`);
  assert.ok(!r.primaryQuery.includes("上一轮工具"), `不应拼入工具杂讯，实际: ${r.primaryQuery}`);
  assert.ok(!r.primaryQuery.includes("好想她 好想她"), "不应把当前 query 重复拼接");
});

// ── P1-3：隐式反馈检测 ──────────────────────────────────────

const MEMS = [
  { content: "用户在做 TypeScript 工具搜索项目", score: 0.8 },
  { content: "用户偏好深色模式", score: 0.7 },
];

test("P1-3 纠正：「不是这样」对上轮召回记忆打强负反馈", () => {
  const signals = detectImplicitFeedback({
    actorId: "u1",
    userText: "不是这样，你理解错了",
    recalledMemories: MEMS,
  });
  assert.ok(signals.length > 0, "应产生信号");
  assert.ok(signals.every((s) => s.signal === "negative"), "纠正应为 negative");
  assert.ok(signals.every((s) => s.reason === "user_correction"));
});

test("P1-3 认同：「对」给召回记忆正反馈", () => {
  const signals = detectImplicitFeedback({
    actorId: "u1",
    userText: "对",
    recalledMemories: MEMS,
  });
  assert.ok(signals.some((s) => s.signal === "positive"), `应含 positive，实际 ${JSON.stringify(signals)}`);
});

test("P1-3 换话题：「对了，」弱负反馈（上轮召回可能不相关）", () => {
  const signals = detectImplicitFeedback({
    actorId: "u1",
    userText: "对了，说个别的，周末去哪玩",
    prevUserText: "TypeScript 项目怎么优化",
    prevAssistantText: "可以从索引结构入手……",
    recalledMemories: MEMS,
  });
  const weak = signals.filter((s) => s.signal === "weak_negative");
  assert.ok(weak.length > 0, "换话题应产生 weak_negative");
  assert.ok(weak.every((s) => s.reason.includes("topic_switch")));
});

test("P1-3 无召回记忆时不产生信号", () => {
  const signals = detectImplicitFeedback({
    actorId: "u1",
    userText: "不是这样",
    recalledMemories: [],
  });
  assert.equal(signals.length, 0);
});

// ── P2-1：记忆目录（元认知）─────────────────────────────────

function fakeKv(entries: Record<string, string>) {
  return {
    getSnapshot: (_actorId: string, keys?: string[]) => ({
      revision: 1,
      entries: Object.fromEntries((keys ?? Object.keys(entries)).map((k) => [k, entries[k]])),
    }),
  };
}

test("P2-1 目录统计：规模/分类/时间分布/高频主题", async () => {
  const inv = new MemoryInventory(fakeKv({
    memory_summary: [
      "[今天] 用户在测试记忆目录模块",
      "[昨天] 用户调试了 BM25 索引",
      "[10天前] 用户讨论过工具路由架构",
    ].join("\n"),
    memory_preferences: "[今天] 用户喜欢深色模式\n[今天] 用户喜欢深色模式",
    memory_facts: "[3天前] 用户名字是小李",
  }));
  const report = await inv.getReport("u1");
  assert.equal(report.stats.totalLines, 6, "总行数应为 6");
  assert.equal(report.stats.timeDistribution.today, 3, "今天 3 条");
  assert.equal(report.stats.timeDistribution.yesterday, 1, "昨天 1 条");
  assert.equal(report.stats.timeDistribution.older, 1, "10天前归 older");
  assert.ok(report.summary.includes("我对你现有 6 条记忆"), `摘要应含总条数，实际: ${report.summary}`);
  assert.ok(report.summary.length > 0);
});

test("P2-1 同步缓存读：未命中空串 → getReport 后可读 → invalidate 后失效", async () => {
  const inv = new MemoryInventory(fakeKv({ memory_facts: "[今天] 用户在做记忆模块测试" }));
  assert.equal(inv.getCachedSummary("u1"), "", "未刷新缓存应返回空串");
  await inv.getReport("u1");
  const cached = inv.getCachedSummary("u1");
  assert.ok(cached.includes("1 条记忆"), `缓存摘要应可同步读取，实际: ${cached}`);
  inv.invalidate("u1");
  assert.equal(inv.getCachedSummary("u1"), "", "invalidate 后缓存应失效");
});

test("P2-1 空记忆返回空摘要", async () => {
  const inv = new MemoryInventory(fakeKv({}));
  const report = await inv.getReport("u2");
  assert.equal(report.stats.totalLines, 0);
  assert.equal(report.summary, "");
});

// ── P0-1：画像聚合器强信号快速路径（真实落盘）──────────────

test("P0-1 强信号：observeTurn 立即写入 USER_PROFILE.md 并幂等", async () => {
  const dir = await mkdtemp(join(tmpdir(), "profile-test-"));
  const prevDir = process.env.AGENT_USER_PROFILE_DIR;
  process.env.AGENT_USER_PROFILE_DIR = dir;
  try {
    // synthesisTurnThreshold 拉满：单次 observeTurn 不会触发 LLM 深度合成，
    // 只验证强信号快速路径的真实落盘行为。
    const agg = new UserProfileAggregator({ synthesisTurnThreshold: 1_000_000 });

    agg.observeTurn("test-actor", "我喜欢吃火锅，另外我叫小明", "好的，记住了");
    await new Promise((r) => setTimeout(r, 300)); // 快速路径是 fire-and-forget

    let profile = await readFile(join(dir, "test-actor", "USER_PROFILE.md"), "utf8");
    assert.ok(profile.includes("喜欢：吃火锅"), `【兴趣与习惯】应含喜欢项，实际:\n${profile}`);
    assert.ok(profile.includes("称呼：小明"), `【基本信息】应含称呼，实际:\n${profile}`);

    // 幂等：同一句再来一次不重复追加
    agg.observeTurn("test-actor", "我喜欢吃火锅", "嗯");
    await new Promise((r) => setTimeout(r, 300));
    profile = await readFile(join(dir, "test-actor", "USER_PROFILE.md"), "utf8");
    assert.equal(profile.split("喜欢：吃火锅").length - 1, 1, "相同信号应幂等不重复");
  } finally {
    if (prevDir === undefined) delete process.env.AGENT_USER_PROFILE_DIR;
    else process.env.AGENT_USER_PROFILE_DIR = prevDir;
    await rm(dir, { recursive: true, force: true });
  }
});
