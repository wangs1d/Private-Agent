/**
 * 回复信封（reply blocks）单测：确定性拆分 + 降级判定。
 * 端到端（done 载荷下发 blocks）由 WS handler 集成路径保证；此处锁纯函数行为。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildReplyBlocks } from "../src/services/reply-envelope.js";

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
