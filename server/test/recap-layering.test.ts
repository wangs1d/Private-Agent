import assert from "node:assert/strict";
import test from "node:test";

import {
  layerRecapLines,
  flattenRecapLayers,
  layerRecapLinesByBudget,
  bucketRecapLine,
  readRecapTimeTag,
} from "../src/services/conversation-rolling-summarizer.js";

// ── 时间标签解析 ─────────────────────────────────────────────

test("readRecapTimeTag: 识别 [今天]/[昨天]/[N天前] 并保留整标签", () => {
  assert.equal(readRecapTimeTag("[今天] 用户买了咖啡"), "[今天]");
  assert.equal(readRecapTimeTag("[昨天] 用户出差"), "[昨天]");
  assert.equal(readRecapTimeTag("[3天前] 用户爬山"), "[3天前]");
  assert.equal(readRecapTimeTag("[2周前] 用户搬家"), "[2周前]");
  assert.equal(readRecapTimeTag("无标签行"), null);
});

test("bucketRecapLine: 正确归桶", () => {
  assert.equal(bucketRecapLine("[今天] x"), "today");
  assert.equal(bucketRecapLine("[昨天] x"), "yesterday");
  assert.equal(bucketRecapLine("[2天前] x"), "thisWeek");
  assert.equal(bucketRecapLine("[6天前] x"), "thisWeek");
  assert.equal(bucketRecapLine("[7天前] x"), "older");
  assert.equal(bucketRecapLine("[2周前] x"), "older");
  assert.equal(bucketRecapLine("[1个月前] x"), "older");
  assert.equal(bucketRecapLine("无标签"), "untagged");
});

// ── 分层与拍平 ─────────────────────────────────────────────

test("layerRecapLines: 按时间桶分层且保留行内容", () => {
  const layers = layerRecapLines([
    "[3天前] 用户爬山",
    "[今天] 用户买了咖啡",
    "[昨天] 用户出差",
    "无标签事实",
  ]);
  assert.deepEqual(layers.today, ["[今天] 用户买了咖啡"]);
  assert.deepEqual(layers.yesterday, ["[昨天] 用户出差"]);
  assert.deepEqual(layers.thisWeek, ["[3天前] 用户爬山"]);
  assert.deepEqual(layers.older, []);
  assert.deepEqual(layers.untagged, ["无标签事实"]);
});

test("flattenRecapLayers: 时间线顺序 today → yesterday → thisWeek → older → untagged", () => {
  const layers = layerRecapLines([
    "[3天前] 爬山",
    "无标签",
    "[今天] 咖啡",
    "[昨天] 出差",
  ]);
  assert.deepEqual(flattenRecapLayers(layers), ["[今天] 咖啡", "[昨天] 出差", "[3天前] 爬山", "无标签"]);
});

test("layerRecapLinesByBudget: 近层优先，远层超配额压缩", () => {
  const lines = [
    "[今天] a",
    "[今天] b",
    "[昨天] c",
    "[昨天] d",
    "[2天前] e",
    "[3天前] f",
    "[4天前] g",
    "[5天前] h",
    "[6天前] i",
    "[30天前] j",
  ];
  const result = layerRecapLinesByBudget(lines, 14);
  // 今天/昨天全量在前，本周超 4 条触发压缩提示
  assert.ok(result[0]!.startsWith("[今天]"));
  assert.ok(result.some((l) => l.includes("压缩")), "远层超配额应输出压缩提示行");
  assert.ok(result.some((l) => l.includes("30天前")), "更早层仍保留头部关键行");
  // 总行数不超过预算
  assert.ok(result.length <= 14);
});

test("layerRecapLinesByBudget: maxLines 限制总行数", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `[今天] 事实${i}`);
  const result = layerRecapLinesByBudget(lines, 5);
  assert.equal(result.length, 5);
});

test("layerRecapLinesByBudget: maxLines<=0 不裁剪只排序", () => {
  const lines = ["[昨天] x", "[今天] y", "[3天前] z"];
  const result = layerRecapLinesByBudget(lines, 0);
  assert.equal(result.length, 3);
  assert.equal(result[0], "[今天] y");
});
