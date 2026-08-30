import assert from "node:assert/strict";
import test from "node:test";

import {
  RecallAnchorStore,
  ANCHOR_KV_KEY,
  type AnchorKvLike,
} from "../src/services/recall-anchor-store.js";

function makeMockKv(): {
  kv: AnchorKvLike;
  persisted: Map<string, { revision: number; entries: Record<string, unknown> }>;
} {
  const persisted = new Map<string, { revision: number; entries: Record<string, unknown> }>();
  const kv: AnchorKvLike = {
    getSnapshot(actorId, keys) {
      const raw = persisted.get(actorId);
      if (!raw) return null;
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw.entries)) {
        if (!keys || keys.includes(k)) entries[k] = v;
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

test("record: 记录召回锚点并裁剪 content", () => {
  const store = new RecallAnchorStore(null);
  store.record("a1", "帮我订票", [
    { content: "用户下周去北京出差三天，需要订回程高铁票", score: 0.9, source: "agentic" },
  ]);
  const records = store.get("a1");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.query, "帮我订票");
  assert.ok(records[0]!.items[0]!.content.length <= 80, "content 应裁剪到 80 字符");
  assert.equal(records[0]!.items[0]!.source, "agentic");
});

test("record: 滚动保留最近 8 条", () => {
  const store = new RecallAnchorStore(null);
  for (let i = 0; i < 12; i++) {
    store.record("a1", `查询${i}`, [{ content: `记忆内容${i}`, score: 0.5 }]);
  }
  const records = store.get("a1");
  assert.equal(records.length, 8, "应滚动保留最近 8 条");
  assert.equal(records[records.length - 1]!.query, "查询11", "最新记录应保留");
});

test("record: 空 items 不记录", () => {
  const store = new RecallAnchorStore(null);
  store.record("a1", "无结果查询", []);
  assert.equal(store.get("a1").length, 0);
});

test("持久化: KV 写入后可重新加载", () => {
  const { kv } = makeMockKv();
  const store = new RecallAnchorStore(kv);
  store.record("a1", "帮我订票", [{ content: "用户下周去北京出差三天", score: 0.9 }]);
  assert.ok(kv.getSnapshot("a1", [ANCHOR_KV_KEY])!.entries[ANCHOR_KV_KEY], "应写入 KV");

  const reloaded = new RecallAnchorStore(kv);
  const records = reloaded.get("a1");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.query, "帮我订票");
});

test("降级: 无 KV 时内存态正常", () => {
  const store = new RecallAnchorStore(null);
  store.record("a1", "q", [{ content: "记忆", score: 0.5 }]);
  assert.equal(store.get("a1").length, 1);
});
