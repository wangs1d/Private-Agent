import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryStrengthModel,
  strengthFingerprint,
  STRENGTH_KV_KEY,
  type StrengthKvLike,
  type MemoryFeedbackRecord,
} from "../src/brain/memory-strength-model.js";

const DAY = 86_400_000;

/** 内存 KV 适配器 mock：与 KvSummaryLike.getSnapshot/setEntry 同形状。 */
function makeMockKv(): {
  kv: StrengthKvLike;
  persisted: Map<string, { revision: number; entries: Record<string, unknown> }>;
} {
  const persisted = new Map<
    string,
    { revision: number; entries: Record<string, unknown> }
  >();
  const kv: StrengthKvLike = {
    getSnapshot(actorId, keys) {
      const raw = persisted.get(actorId);
      if (!raw) return null;
      const entries: Record<string, unknown> = {};
      if (!keys) {
        for (const [k, v] of Object.entries(raw.entries)) entries[k] = v;
      } else {
        for (const k of keys) {
          if (k in raw.entries) entries[k] = raw.entries[k];
        }
      }
      return { revision: raw.revision, entries };
    },
    setEntry(actorId, key, value) {
      const raw = persisted.get(actorId) ?? { revision: 0, entries: {} };
      raw.revision += 1;
      raw.entries[key] = value;
      persisted.set(actorId, raw);
    },
  };
  return { kv, persisted };
}

// ── 指纹一致性 ─────────────────────────────────────────────

test("strengthFingerprint: 相同语义文本产生相同指纹", () => {
  assert.equal(
    strengthFingerprint("用户喜欢喝美式咖啡"),
    strengthFingerprint("用户喜欢喝美式咖啡"),
  );
  assert.notEqual(
    strengthFingerprint("用户喜欢喝美式咖啡"),
    strengthFingerprint("用户讨厌喝美式咖啡"),
  );
});

// ── 反馈记录与分数累计 ─────────────────────────────────────────────

test("recordFeedback: relevant 累加正分并 clamp 到 1", () => {
  const model = new MemoryStrengthModel(null);
  const r1 = model.recordFeedback({ actorId: "a1", content: "用户喜欢素食", outcome: "relevant" });
  const r2 = model.recordFeedback({ actorId: "a1", content: "用户喜欢素食", outcome: "relevant" });
  const r3 = model.recordFeedback({ actorId: "a1", content: "用户喜欢素食", outcome: "relevant" });
  assert.ok(r1!.score > 0, "首次 relevant 应得到正分");
  assert.ok(r2!.score > r1!.score, "第二次累计应更高");
  assert.ok(r3!.score > r2!.score, "第三次累计应更高");
  assert.ok(r3!.score <= 1, "score 应 clamp 到 1");
  assert.equal(r3!.hits, 3);
});

test("recordFeedback: correction 施加负分并 clamp 到 -1", () => {
  const model = new MemoryStrengthModel(null);
  for (let i = 0; i < 5; i++) {
    model.recordFeedback({ actorId: "a1", content: "用户喜欢素食", outcome: "correction" });
  }
  const snapshot = model.snapshot("a1");
  const record = Object.values(snapshot.entries)[0]!;
  assert.ok(record.score < 0, "correction 应为负分");
  assert.ok(record.score >= -1, "score 应 clamp 到 -1");
});

// ── 统一加成/惩罚 ─────────────────────────────────────────────

test("boostFactor: 正反馈加成 >1", () => {
  const model = new MemoryStrengthModel(null);
  model.recordFeedback({ actorId: "a1", content: "用户住在北京", outcome: "relevant" });
  model.recordFeedback({ actorId: "a1", content: "用户住在北京", outcome: "relevant" });
  const factor = model.boostFactor("a1", "用户住在北京");
  assert.ok(factor > 1, "正反馈应加成（>1）");
  assert.ok(factor < 1.5, "总加成受上限约束（反馈25% + 加固20%）");
});

test("boostFactor: 负反馈惩罚 <1 且不低于 0.05", () => {
  const model = new MemoryStrengthModel(null);
  model.recordFeedback({ actorId: "a1", content: "用户住在北京", outcome: "correction" });
  model.recordFeedback({ actorId: "a1", content: "用户住在北京", outcome: "correction" });
  const factor = model.boostFactor("a1", "用户住在北京");
  assert.ok(factor < 1, "负反馈应惩罚（<1）");
  assert.ok(factor >= 0.05, "惩罚下限 0.05");
});

test("boostFactor: 无反馈无命中内容返回 1（不调整）", () => {
  const model = new MemoryStrengthModel(null);
  assert.equal(model.boostFactor("a1", "从未反馈过的记忆"), 1);
});

// ── 间隔重复 / 遗忘曲线（新增能力）─────────────────────────────────────────

test("recordHits: 高频命中提升加固加成（fresh 时间）", () => {
  const model = new MemoryStrengthModel(null);
  const T = Date.UTC(2026, 7, 1);
  for (let i = 0; i < 6; i++) model.recordHits("a1", ["用户喜欢猫"], T + i * DAY);
  const factor = model.boostFactor("a1", "用户喜欢猫", T + 6 * DAY);
  assert.ok(factor > 1, "命中应带来加固加成");
});

test("遗忘曲线: 久未命中加成量显著衰减，多次命中衰减更慢", () => {
  const T = Date.UTC(2026, 7, 1);

  // 只命中一次 → 半衰期短，30 天后"超出 1 的那部分加成量"明显衰减（朝中性回落）
  const once = new MemoryStrengthModel(null);
  once.recordHits("a1", ["备忘A"], T);
  const onceFresh = once.boostFactor("a1", "备忘A", T);
  const onceAged = once.boostFactor("a1", "备忘A", T + 30 * DAY);
  assert.ok(onceAged < onceFresh, "久未命中应衰减");
  assert.ok(
    onceAged - 1 < (onceFresh - 1) * 0.4,
    "单次命中半衰期短，30 天后加固加成量应衰减到 40% 以下",
  );

  // 命中 8 次 → 半衰期随 hits 变长，同样 30 天剩余强度显著更高
  const many = new MemoryStrengthModel(null);
  for (let i = 0; i < 8; i++) many.recordHits("a1", ["备忘B"], T + i * DAY);
  const manyAged = many.boostFactor("a1", "备忘B", T + 30 * DAY);
  assert.ok(
    manyAged - 1 > onceAged - 1,
    "命中越多衰减越慢（间隔重复）：备忘B 剩余加成应显著高于只命中一次的备忘A",
  );
});

// ── KV 持久化 ─────────────────────────────────────────────

test("持久化: recordFeedback 后写入 KV，新实例可重新加载", () => {
  const { kv } = makeMockKv();
  const model = new MemoryStrengthModel(kv);
  model.recordFeedback({ actorId: "a1", content: "用户喜欢猫", outcome: "relevant" });

  const reloaded = new MemoryStrengthModel(kv);
  const factor = reloaded.boostFactor("a1", "用户喜欢猫");
  assert.ok(factor > 1, "重新加载后应恢复反馈分数");
});

test("持久化: KV 快照结构包含 revision 与 entries", () => {
  const { kv, persisted } = makeMockKv();
  const model = new MemoryStrengthModel(kv);
  model.recordFeedback({ actorId: "a1", content: "用户喜欢猫", outcome: "relevant" });

  const raw = persisted.get("a1")!.entries[STRENGTH_KV_KEY] as {
    revision: number;
    entries: Record<string, MemoryFeedbackRecord>;
  };
  assert.ok(typeof raw.revision === "number");
  assert.ok(Object.keys(raw.entries).length === 1);
  const record = Object.values(raw.entries)[0]!;
  assert.equal(typeof record.score, "number");
  assert.equal(typeof record.updatedAt, "string");
});

// ── 降级兼容 ─────────────────────────────────────────────

test("降级: 无 KV 适配器时 recordFeedback 与 boostFactor 正常（内存态）", () => {
  const model = new MemoryStrengthModel(null);
  const record = model.recordFeedback({
    actorId: "a1",
    content: "无持久化记忆",
    outcome: "relevant",
  });
  assert.ok(record, "无 KV 也应能记录");
  assert.ok(model.boostFactor("a1", "无持久化记忆") > 1, "无 KV 也应能查询加成");
});

test("降级: 空 content 记录返回 null", () => {
  const model = new MemoryStrengthModel(null);
  assert.equal(
    model.recordFeedback({ actorId: "a1", content: "   ", outcome: "relevant" }),
    null,
  );
});

// ── attach 动态绑定 ─────────────────────────────────────────────

test("attach: 动态绑定 KV 后可持久化", () => {
  const { kv, persisted } = makeMockKv();
  const model = new MemoryStrengthModel(null);
  model.recordFeedback({ actorId: "a1", content: "先记录（内存）", outcome: "relevant" });
  model.attach(kv);
  model.recordFeedback({ actorId: "a1", content: "后记录（持久化）", outcome: "relevant" });

  assert.ok(persisted.has("a1"), "attach 后应写入 KV");
  const reloaded = new MemoryStrengthModel(kv);
  assert.ok(reloaded.boostFactor("a1", "后记录（持久化）") > 1);
});