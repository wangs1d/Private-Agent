import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeNormalizedStream,
  createStreamThinkSanitizer,
  stripInlineThinkBlocks,
  type NormalChatChunk,
} from "../src/external-model/stream-chat-helpers.js";

test("stripInlineThinkBlocks removes paired think blocks including content", () => {
  const input = '<think>用户问了"几点了"，我通过 clock 拿到了结果。</think>晚上 11 点 25 分，星期六。';
  assert.equal(stripInlineThinkBlocks(input), "晚上 11 点 25 分，星期六。");
});

test("stripInlineThinkBlocks handles thinking/reasoning variants and stray close tags", () => {
  assert.equal(stripInlineThinkBlocks("<thinking>推理</thinking>答案"), "答案");
  assert.equal(stripInlineThinkBlocks("<reasoning>推理</reasoning>答案"), "答案");
  assert.equal(stripInlineThinkBlocks("答案A</think>答案B"), "答案A答案B");
  assert.equal(stripInlineThinkBlocks("<think>被截断的思考"), "");
  assert.equal(stripInlineThinkBlocks("先答。<think>未闭合"), "先答。");
  // 无标签正文原样返回
  assert.equal(stripInlineThinkBlocks("1 < 2 是对的"), "1 < 2 是对的");
});

test("createStreamThinkSanitizer drops think content split across chunks", () => {
  const sanitizer = createStreamThinkSanitizer();
  const chunks = ["<th", "ink>用户问了几", "点，我查一下 clock。", "</think>", "晚上 11 点", " 25 分。"];
  let out = "";
  for (const c of chunks) out += sanitizer.feed(c);
  out += sanitizer.flush();
  assert.equal(out, "晚上 11 点 25 分。");
});

test("createStreamThinkSanitizer passes through normal text with angle brackets", () => {
  const sanitizer = createStreamThinkSanitizer();
  let out = "";
  out += sanitizer.feed("比较 a < b 且 c <");
  out += sanitizer.feed("= d 的写法");
  out += sanitizer.flush();
  assert.equal(out, "比较 a < b 且 c <= d 的写法");
});

test("createStreamThinkSanitizer drops everything when think never closes", () => {
  const sanitizer = createStreamThinkSanitizer();
  let out = "";
  out += sanitizer.feed("前面正文<think>思考一");
  out += sanitizer.feed("思考二");
  out += sanitizer.flush();
  assert.equal(out, "前面正文");
});

test("consumeNormalizedStream strips inline think blocks from content and deltas", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { content: "<think>用户问了" };
    yield { content: "\u201c几点了\u201d。</think>晚上 11 点 25 分，星期六。", finishReason: "stop" };
  }

  const deltas: string[] = [];
  const result = await consumeNormalizedStream(source(), {
    onContentDelta: (d) => deltas.push(d),
  });

  assert.equal(result.content, "晚上 11 点 25 分，星期六。");
  assert.equal(deltas.join("").includes("think"), false);
  assert.equal(deltas.join(""), "晚上 11 点 25 分，星期六。");
});

test("consumeNormalizedStream keeps separate reasoning field behavior intact", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { reasoning: "思考过程", content: "正式回复", finishReason: "stop" };
  }

  const result = await consumeNormalizedStream(source());

  assert.equal(result.content, "正式回复");
  assert.equal(result.reasoning, "思考过程");
});
