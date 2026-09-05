import assert from "node:assert/strict";
import test from "node:test";

import {
  layerRecapLines,
  flattenRecapLayers,
  layerRecapLinesByBudget,
  bucketRecapLine,
  readRecapTimeTag,
  readRecapAbsoluteTag,
  migrateRecapLineLabel,
  migrateRecapContentLabels,
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

// ── 绝对时间标签（滑动窗口+增量摘要新契约）──────────────────

test("readRecapAbsoluteTag: 解析 [YYYY/MM/DD 周X HH:MM] 标签（周几/时刻可省略）", () => {
  const d = readRecapAbsoluteTag("[2026/09/04 周五 14:32] 用户确认方案")!;
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth() + 1, 9);
  assert.equal(d.getDate(), 4);
  assert.equal(d.getHours(), 14);
  assert.ok(readRecapAbsoluteTag("[2026/09/04] 只写日期") !== null);
  assert.equal(readRecapAbsoluteTag("[今天] 相对词不是绝对标签"), null);
});

test("bucketRecapLine: 绝对标签按真实日期对 now 分桶（跨天自动归位）", () => {
  // now 注入为固定时刻，模拟「折叠次日再读」：昨天的绝对标签仍归 yesterday，不产生漂移
  const now = new Date("2026-09-05T12:00:00");
  assert.equal(bucketRecapLine("[2026/09/05 10:00] 今天的事", now), "today");
  assert.equal(bucketRecapLine("[2026/09/04 18:00] 昨天的事", now), "yesterday");
  assert.equal(bucketRecapLine("[2026/09/01 09:00] 本周的事", now), "thisWeek");
  assert.equal(bucketRecapLine("[2026/08/20 09:00] 更早的事", now), "older");
  // 旧数据的相对标签保持兼容
  assert.equal(bucketRecapLine("[今天] 旧相对行", now), "today");
  assert.equal(bucketRecapLine("[3天前] 旧相对行", now), "thisWeek");
});

test("layerRecapLinesByBudget: 绝对标签行按日期排序与预算裁剪", () => {
  const now = new Date("2026-09-05T12:00:00");
  const lines = [
    "[2026/08/20 09:00] 更早事实",
    "[2026/09/05 09:00] 今早事件",
    "[2026/09/04 20:00] 昨晚事件",
    "[2026/09/02 08:00] 本周事件",
  ];
  const result = layerRecapLinesByBudget(lines, 14, true, now);
  // 时间线顺序：today → yesterday → thisWeek → older
  assert.ok(result[0]!.includes("2026/09/05"));
  assert.ok(result[1]!.includes("2026/09/04"));
  assert.ok(result[result.length - 1]!.includes("2026/08/20"));
});

// ── 存量相对标签迁移（时间感知：跨天不再产生错误相对词）──────

test("migrateRecapLineLabel: 相对标签按锚点确定性换算为绝对日期", () => {
  // 锚点 = recap 块旧 [ts:] 帧时刻（≈折叠/整理日 2026-09-03）
  const anchor = new Date("2026-09-03T14:32:00");
  const today = migrateRecapLineLabel("[今天] 用户要出差杭州", anchor);
  assert.ok(today.startsWith("[2026/09/03"), `今天→锚点当天，实际: ${today}`);
  assert.ok(today.endsWith("用户要出差杭州"));
  const yesterday = migrateRecapLineLabel("[昨天] 买了新手机", anchor);
  assert.ok(yesterday.startsWith("[2026/09/02"), `昨天→锚点-1天，实际: ${yesterday}`);
  const daysAgo = migrateRecapLineLabel("[3天前] 完成V1交付", anchor);
  assert.ok(daysAgo.startsWith("[2026/08/31"), `N天前→锚点-N天，实际: ${daysAgo}`);
  const weeksAgo = migrateRecapLineLabel("[2周前] 项目立项", anchor);
  assert.ok(weeksAgo.startsWith("[2026/08/20"), `N周前→锚点-7N天，实际: ${weeksAgo}`);
});

test("migrateRecapLineLabel: 绝对标签原样保留、[历史]→[早期]、无锚点不动", () => {
  const anchor = new Date("2026-09-03T14:32:00");
  assert.equal(migrateRecapLineLabel("[2026/09/04 周五 14:32] 已是绝对标签", anchor), "[2026/09/04 周五 14:32] 已是绝对标签");
  assert.ok(migrateRecapLineLabel("[历史] 早期事实", anchor).startsWith("[早期]"));
  // 无锚点（recap 无 [ts:] 帧）时无法换算，原样返回避免错误标注
  assert.equal(migrateRecapLineLabel("[今天] 无锚点行", null), "[今天] 无锚点行");
});

test("migrateRecapContentLabels: 整块迁移，标题/标记行不动，幂等", () => {
  const anchor = new Date("2026-09-03T14:32:00");
  const content = [
    "[session-recap]",
    "Earlier conversation recap:",
    "- [今天] 用户要出差杭州",
    "- [2026/09/01 10:00] 已是绝对标签",
    "[unsummarized]",
    "- [昨天] 买了新手机",
  ].join("\n");
  const once = migrateRecapContentLabels(content, anchor);
  assert.ok(once.includes("[2026/09/03 周四] 用户要出差杭州"));
  assert.ok(once.includes("[2026/09/02 周三] 买了新手机"));
  assert.ok(!once.includes("[今天]"));
  assert.ok(!once.includes("[昨天]"));
  assert.ok(once.includes("[2026/09/01 10:00] 已是绝对标签"), "绝对标签行不被改动");
  assert.ok(once.includes("[unsummarized]"), "标记行保留");
  // 幂等：二次迁移无变化
  assert.equal(migrateRecapContentLabels(once, anchor), once);
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
