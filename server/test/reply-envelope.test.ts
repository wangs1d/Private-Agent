/**
 * 回复信封（reply blocks）单测：确定性拆分 + 降级判定。
 * 端到端（done 载荷下发 blocks）由 WS handler 集成路径保证；此处锁纯函数行为。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReplyBlocks,
  normalizeReplyCardLayout,
  stripRenderHintDeclarations,
} from "../src/services/reply-envelope.js";

const weekendCard = JSON.stringify({
  title: "本周末行程已为你规划：",
  items: [{ type: "num", text: "周六上午探店" }],
  footer: "需要调整吗？",
  cardType: "",
});

test("envelope: 前导 + 卡片 + 追问 → 三段块", () => {
  const text = [
    "好的，耳机已下单，预计周六送达。",
    "",
    "[AGENT_RESULT_CARD_START]",
    weekendCard,
    "[AGENT_RESULT_CARD_END]",
    "",
    "需要调整吗？",
  ].join("\n");
  const blocks = buildReplyBlocks(text);
  assert.ok(blocks);
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "card", "text"],
  );
  if (blocks[0].type === "text") assert.equal(blocks[0].text, "好的，耳机已下单，预计周六送达。");
  if (blocks[1].type === "card") {
    assert.equal((blocks[1].card as { title?: string }).title, "本周末行程已为你规划：");
  }
  if (blocks[2].type === "text") assert.equal(blocks[2].text, "需要调整吗？");
});

test("envelope: 卡片紧贴正文（无前导/追问）→ 单卡块", () => {
  const text = `[AGENT_RESULT_CARD_START]\n${weekendCard}\n[AGENT_RESULT_CARD_END]`;
  const blocks = buildReplyBlocks(text);
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "card");
});

test("envelope: 多卡交错 → text/card 交替序列", () => {
  const other = JSON.stringify({ title: "第二张卡", items: [], footer: "" });
  const text = [
    "先说结论。",
    "[AGENT_RESULT_CARD_START]",
    weekendCard,
    "[AGENT_RESULT_CARD_END]",
    "再看这张。",
    "[AGENT_RESULT_CARD_START]",
    other,
    "[AGENT_RESULT_CARD_END]",
  ].join("\n\n");
  const blocks = buildReplyBlocks(text);
  assert.ok(blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "card", "text", "card"],
  );
});

test("envelope: 纯文本（无卡片标记）→ null（省字节，前端走既有路径）", () => {
  assert.equal(buildReplyBlocks("普通回复，没有任何标记。"), null);
});

test("envelope: 含 v1 未支持标记 → null（整体降级）", () => {
  const cases = [
    `[RENDER_AS:brief]\n正文`,
    `[DATA_BRIEF_START]{}[DATA_BRIEF_END]`,
    `[VIDEO_MEDIA_START]{}[VIDEO_MEDIA_END]`,
    `[CHAT_MEDIA_START]{}[CHAT_MEDIA_END]`,
    `[CONTENT_SUMMARY_V2_START]{}[CONTENT_SUMMARY_V2_END]`,
    `前导。[AGENT_RESULT_CARD_START]\n${weekendCard}\n[AGENT_RESULT_CARD_END]\n[RENDER_AS:image_result]`,
  ];
  for (const text of cases) {
    assert.equal(buildReplyBlocks(text), null, `应降级: ${text.slice(0, 40)}`);
  }
});

test("envelope: 卡片 JSON 不可解析 → null（不 partially 下发）", () => {
  const text = `前导。[AGENT_RESULT_CARD_START]\n{broken json\n[AGENT_RESULT_CARD_END]`;
  assert.equal(buildReplyBlocks(text), null);
});

test("envelope: 残缺标记（缺 END）→ null", () => {
  const text = `前导。[AGENT_RESULT_CARD_START]\n${weekendCard}`;
  assert.equal(buildReplyBlocks(text), null);
});

test("envelope: 卡 JSON 是数组/标量 → null（防御非对象）", () => {
  const text = `[AGENT_RESULT_CARD_START]\n[1,2,3]\n[AGENT_RESULT_CARD_END]`;
  assert.equal(buildReplyBlocks(text), null);
});

// ---- 卡片版式归一化（normalizeReplyCardLayout）：总览卡置首、行程卡置尾 ----

const travelCard = JSON.stringify({
  title: "巴厘岛5日游·海景/泳池/休闲",
  items: [{ type: "num", text: "Day 1 · 2026-09-16：AYANA Resort 等" }],
  footer: "共 5 天 · 28 项安排",
  cardType: "travel_itinerary",
  autoOpen: false,
});

test("normalize: 含行程卡 → 总览卡置首、正文居中、行程卡收尾", () => {
  const text = [
    "大哥，5天就钉在巴厘岛，行程排好了，卡在最后。",
    "[AGENT_RESULT_CARD_START]",
    weekendCard,
    "[AGENT_RESULT_CARD_END]",
    "## 🏨 住哪儿",
    "预算充足的话先乌布后海景，节奏刚好。",
    "[AGENT_RESULT_CARD_START]",
    travelCard,
    "[AGENT_RESULT_CARD_END]",
  ].join("\n\n");
  const out = normalizeReplyCardLayout(text);
  const blocks = buildReplyBlocks(out);
  assert.ok(blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["card", "text", "card"],
  );
  if (blocks[0].type === "card") {
    assert.equal((blocks[0].card as { title?: string }).title, "本周末行程已为你规划：");
  }
  if (blocks[2].type === "card") {
    assert.equal((blocks[2].card as { cardType?: string }).cardType, "travel_itinerary");
  }
});

test("normalize: 无行程卡 → 总览卡同样置首", () => {
  const text = [
    "好的，耳机已下单，预计周六送达。",
    "[AGENT_RESULT_CARD_START]",
    weekendCard,
    "[AGENT_RESULT_CARD_END]",
    "需要调整吗？",
  ].join("\n\n");
  const blocks = buildReplyBlocks(normalizeReplyCardLayout(text));
  assert.ok(blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["card", "text"],
  );
  if (blocks[0].type === "card") {
    assert.equal((blocks[0].card as { title?: string }).title, "本周末行程已为你规划：");
  }
});

test("normalize: 行程卡已在末尾 → 原样返回（幂等）", () => {
  const text = [
    "[AGENT_RESULT_CARD_START]",
    weekendCard,
    "[AGENT_RESULT_CARD_END]",
    "行程给你排好了。",
    "[AGENT_RESULT_CARD_START]",
    travelCard,
    "[AGENT_RESULT_CARD_END]",
  ].join("\n\n");
  assert.equal(normalizeReplyCardLayout(text), text);
});

test("normalize: 多张总览卡保持相对顺序置首，行程卡置尾", () => {
  const other = JSON.stringify({ title: "第二张卡", items: [], footer: "" });
  const text = [
    "先说结论。",
    "[AGENT_RESULT_CARD_START]",
    weekendCard,
    "[AGENT_RESULT_CARD_END]",
    "再看这张。",
    "[AGENT_RESULT_CARD_START]",
    other,
    "[AGENT_RESULT_CARD_END]",
    "[AGENT_RESULT_CARD_START]",
    travelCard,
    "[AGENT_RESULT_CARD_END]",
  ].join("\n\n");
  const blocks = buildReplyBlocks(normalizeReplyCardLayout(text));
  assert.ok(blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["card", "card", "text", "card"],
  );
});

test("normalize: 无卡片 / 残缺标记 / JSON 不可解析 → 原样返回", () => {
  assert.equal(
    normalizeReplyCardLayout("普通回复，没有任何标记。"),
    "普通回复，没有任何标记。",
  );
  const broken = `前导。[AGENT_RESULT_CARD_START]\n${weekendCard}`;
  assert.equal(normalizeReplyCardLayout(broken), broken);
  const badJson = `前导。[AGENT_RESULT_CARD_START]\n{broken json\n[AGENT_RESULT_CARD_END]\n[AGENT_RESULT_CARD_START]\n${travelCard}\n[AGENT_RESULT_CARD_END]`;
  assert.equal(normalizeReplyCardLayout(badJson), badJson);
});

// ---- RENDER_HINT 声明剥除（根源收口）：内部信号绝不下发到用户屏幕 ----

test("hint-strip: 开头/中段/行内的 RENDER_HINT 声明全部剥除", () => {
  // 独占行（开头）→ 整行删除
  assert.equal(
    stripRenderHintDeclarations("[RENDER_HINT:structured]\n\n正文开始。"),
    "正文开始。",
  );
  // 独占行（中段）→ 整行删除
  assert.equal(
    stripRenderHintDeclarations("第一段。\n[RENDER_HINT:structured]\n第二段。"),
    "第一段。\n第二段。",
  );
  // 行内嵌 → 就地剥离保留其余文本
  assert.equal(
    stripRenderHintDeclarations("前缀 [RENDER_HINT:brief] 后缀"),
    "前缀  后缀",
  );
  // 无声明 → 原样返回
  assert.equal(
    stripRenderHintDeclarations("普通回复。"),
    "普通回复。",
  );
});

test("hint-strip: normalize 出口统一剥除（无卡文本也生效）", () => {
  const text = "[RENDER_HINT:structured]\n帮我排好了杭州 3 天行程。";
  assert.equal(normalizeReplyCardLayout(text), "帮我排好了杭州 3 天行程。");
});

test("hint-strip: 只剥 RENDER_HINT，不碰权威 RENDER_AS（客户端路由依赖）", () => {
  const text = "[RENDER_AS:brief]\n今日简报正文。";
  assert.equal(normalizeReplyCardLayout(text), text);
});
