/**
 * 记忆架构优化（P0-P5）行为测试：
 * - P0 时间感知：freshness 解析、时间衰减打分、注入相对时间标注
 * - P1 指纹升级：不同长事件不误合并、同义重述仍合并
 * - P2 防串台：query 与记忆词重叠过低时降权
 * - P3 epitome 生命周期：TTL 过滤、完成检测、旧 KV 格式兼容
 * - P4 分类配额：单 domain 不占满 topN
 * - P5 间隔重复强化：命中计数加成、滚动淘汰
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  arbitrateMemories,
  DEFAULT_ARBITRATOR_CONFIG,
  type ChannelRecallResult,
} from "../src/brain/memory-arbitrator.js";
import type { MemoryRecallItem } from "../src/brain/types.js";
import {
  semanticFingerprint,
  describeMemoryAge,
  tokenOverlapRatio,
} from "../src/services/memory-record-utils.js";
import { SessionEpitomeStore } from "../src/services/session-epitome.js";
import { MemoryStrengthModel } from "../src/brain/memory-strength-model.js";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function makeItem(
  content: string,
  opts: { score?: number; timestamp?: string; domain?: MemoryRecallItem["domain"] } = {},
): MemoryRecallItem {
  const item: MemoryRecallItem = { content, domain: opts.domain ?? "semantic" };
  if (opts.score !== undefined) item.score = opts.score;
  if (opts.timestamp) item.timestamp = opts.timestamp;
  return item;
}

// ── P0：时间衰减打分 ─────────────────────────────────────────

test("P0 时间衰减：同分记忆，新的 episodic 排在旧的之前", () => {
  const channels: ChannelRecallResult[] = [
    {
      channel: "agentic",
      items: [
        makeItem("昨天讨论了部署方案", { score: 0.8, timestamp: iso(20), domain: "episodic" }),
        makeItem("三个月前讨论过部署方案", { score: 0.8, timestamp: iso(24 * 90), domain: "episodic" }),
      ],
    },
  ];
  const result = arbitrateMemories(channels, DEFAULT_ARBITRATOR_CONFIG);
  assert.equal(result[0]!.content, "昨天讨论了部署方案", "近的记忆应排前");
});

test("P0 时间衰减：旧 semantic 事实只被软压制，不被清零", () => {
  const old = arbitrateMemories(
    [{ channel: "agentic", items: [makeItem("用户生日是 5 月 3 日", { score: 0.8, timestamp: iso(24 * 365) })] }],
    DEFAULT_ARBITRATOR_CONFIG,
  );
  assert.equal(old.length, 1, "一年前的 semantic 记忆不应被阈值丢弃");
  assert.ok(old[0]!.score! > 0.5, "一年前的高分事实仍应保持较高分数");
});

test("P0 注入标注：describeMemoryAge 输出人类可读相对时间", () => {
  assert.equal(describeMemoryAge(iso(0.5), NOW), "刚刚");
  assert.equal(describeMemoryAge(iso(5), NOW), "5小时前");
  assert.equal(describeMemoryAge(iso(24 * 3), NOW), "3天前");
  assert.equal(describeMemoryAge(iso(24 * 14), NOW), "2周前");
  assert.equal(describeMemoryAge(iso(24 * 60), NOW), "2个月前");
  assert.equal(describeMemoryAge(undefined), "", "无时间戳返回空");
});

// ── P1：指纹升级 ─────────────────────────────────────────────

test("P1 指纹：同话题不同事件（前缀相似）不再被合并", () => {
  const a = "项目A的评审会议定在周三下午，参会人包括后端和前端负责人";
  const b = "项目A的评审会议已经结束，结论是方案需要再改一版";
  assert.notEqual(semanticFingerprint(a), semanticFingerprint(b), "不同事件指纹应不同");
});

test("P1 指纹：同义重述（词集相同、顺序不同）仍可合并", () => {
  assert.equal(semanticFingerprint("dark mode user prefers"), semanticFingerprint("user prefers dark mode"));
});

test("P1 指纹：中文经 bigram 切分，完全相同文本同指纹", () => {
  assert.equal(semanticFingerprint("用户喜欢深色模式"), semanticFingerprint("用户喜欢深色模式"));
  assert.notEqual(semanticFingerprint("用户喜欢深色模式"), semanticFingerprint("用户讨厌深色模式"));
});

// ── P2：防串台一致性 ─────────────────────────────────────────

test("P2 防串台：聊 A 话题时 B 话题的高分记忆被降权", () => {
  const query = "周末去哪里爬山比较好 带什么装备";
  const channels: ChannelRecallResult[] = [
    {
      channel: "agentic",
      items: [
        makeItem("用户周末喜欢户外爬山运动", { score: 0.9 }),
        makeItem("用户在做一个 TypeScript 的工具搜索引擎项目", { score: 0.75 }),
      ],
    },
  ];
  const result = arbitrateMemories(channels, DEFAULT_ARBITRATOR_CONFIG, { query });
  assert.equal(result[0]!.content, "用户周末喜欢户外爬山运动", "话题一致的记忆应排第一");
  assert.ok(!result.some((it) => it.content.includes("TypeScript")), "话题无关记忆应被强降权出局");
});

test("P2 防串台：query 太短时一致性因子不启用", () => {
  const result = arbitrateMemories(
    [{ channel: "agentic", items: [makeItem("用户喜欢咖啡", { score: 0.9 })] }],
    DEFAULT_ARBITRATOR_CONFIG,
    { query: "咖啡" },
  );
  assert.ok(result[0]!.score! > 0.7, "短 query 不应触发降权");
});

test("P2 tokenOverlapRatio：相同文本重叠 1，无关文本接近 0", () => {
  assert.equal(tokenOverlapRatio(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(tokenOverlapRatio(new Set(["a", "b"]), new Set(["x", "y"])), 0);
});

// ── P4：分类配额 ─────────────────────────────────────────────

test("P4 分类配额：semantic 溢出让位，低分 episodic 挤进前排", () => {
  const semanticItems = Array.from({ length: 6 }, (_, i) =>
    makeItem(`事实记忆${i}号内容各不相同`, { score: 0.9 - i * 0.01 }),
  );
  const channels: ChannelRecallResult[] = [
    { channel: "agentic", items: [...semanticItems, makeItem("昨天发生了一次事件回忆", { score: 0.5, domain: "episodic" })] },
  ];
  const result = arbitrateMemories(channels, DEFAULT_ARBITRATOR_CONFIG);
  const episodicIdx = result.findIndex((it) => it.domain === "episodic");
  assert.ok(episodicIdx >= 0 && episodicIdx < 4, `低分 episodic 应挤进前 4（实际第 ${episodicIdx + 1} 位）`);
});

// ── P3：epitome 生命周期 ─────────────────────────────────────

test("P3 TTL：超过 7 天的 open loop 不再出现在快照", () => {
  const store = new SessionEpitomeStore(null);
  store.record("u1", { openLoops: ["帮用户分析股票持仓数据"], commitments: [], preferences: [] });
  // 手动把缓存内时间戳拨回 8 天前
  const raw = (store as unknown as { cache: Map<string, { openLoops: Array<{ text: string; createdAt: string }> }> }).cache.get("u1")!;
  raw.openLoops[0]!.createdAt = iso(24 * 8);
  assert.equal(store.get("u1").openLoops.length, 0, "过期 loop 应被过滤");
});

test("P3 完成检测：用户说搞定了，对应 loop 被关闭", () => {
  const store = new SessionEpitomeStore(null);
  store.record("u1", { openLoops: ["帮我优化数据库索引性能"], commitments: [], preferences: [] });
  store.record("u1", { openLoops: [], commitments: [], preferences: [] }, {
    turnText: "数据库索引性能优化搞定了，不用再管了",
  });
  const loops = store.get("u1").openLoops;
  assert.ok(!loops.some((l) => l.includes("数据库索引")), "已完成的 loop 应被关闭");
});

test("P3 完成检测：无关的完成语不误关闭其他 loop", () => {
  const store = new SessionEpitomeStore(null);
  store.record("u1", { openLoops: ["帮我优化数据库索引性能"], commitments: [], preferences: [] });
  store.record("u1", { openLoops: [], commitments: [], preferences: [] }, {
    turnText: "周末的电影看完了，挺好看的",
  });
  assert.equal(store.get("u1").openLoops.length, 1, "词重叠不足时 loop 应保留");
});

test("P3 KV 兼容：旧格式 string[] 可正常加载", () => {
  const kv = {
    getSnapshot: () => ({
      revision: 1,
      entries: {
        session_epitome: {
          openLoops: ["旧格式的待办事项条目"],
          commitments: ["旧格式承诺"],
          preferences: [],
          updatedAt: "2026-08-01T00:00:00.000Z",
          revision: 1,
        },
      },
    }),
  };
  const store = new SessionEpitomeStore(kv);
  const snap = store.get("u1");
  assert.deepEqual(snap.openLoops, ["旧格式的待办事项条目"], "旧格式条目应保留（createdAt 空不过滤）");
});

// ── P5：间隔重复强化 ─────────────────────────────────────────

test("P5 强化：反复命中的记忆获得递增加成并封顶", () => {
  const store = new MemoryStrengthModel(null);
  const content = "用户偏好深色模式和静音环境";
  assert.equal(store.boostFactor("u1", content), 1, "未命中时无加成");
  for (let i = 0; i < 12; i++) store.recordHits("u1", [content]);
  const boost = store.boostFactor("u1", content);
  assert.ok(boost > 1 && boost <= 1.2, `加成应在 (1, 1.2] 区间，实际 ${boost}`);
  assert.ok(store.boostFactor("u1", "完全无关的另一条记忆内容") === 1, "未命中记忆不受影响");
});

test("P5 强化：KV 持久化后新实例可加载", () => {
  const bag: Record<string, unknown> = {};
  const kv = {
    getSnapshot: (_a: string, keys: string[]) => ({ revision: 1, entries: Object.fromEntries(keys.map((k) => [k, bag[k]])) }),
    setEntry: (_a: string, k: string, v: unknown) => void (bag[k] = v),
  };
  const s1 = new MemoryStrengthModel(kv);
  s1.recordHits("u1", ["反复被召回的一条记忆内容"]);
  const s2 = new MemoryStrengthModel(kv);
  assert.ok(s2.boostFactor("u1", "反复被召回的一条记忆内容") > 1, "新实例应能读到强化计数");
});

// ── P1 合并保留 variants（内容不丢）─────────────────────────

test("P1 合并：同指纹跨通道命中，高分者作为代表且内容合并不丢", () => {
  // 同文本双通道命中（现实中 agentic 与 narrative 存了同一条记忆）
  const channels: ChannelRecallResult[] = [
    { channel: "agentic", items: [makeItem("用户住在上海静安区", { score: 0.5 })] },
    { channel: "narrative", items: [makeItem("用户住在上海静安区", { score: 0.9 })] },
  ];
  const result = arbitrateMemories(channels, DEFAULT_ARBITRATOR_CONFIG);
  assert.equal(result.length, 1, "同指纹合并为一条");
  assert.ok(result[0]!.source!.includes("agentic") && result[0]!.source!.includes("narrative"), "source 合并双通道");
});
