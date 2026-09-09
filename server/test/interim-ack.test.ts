import test from "node:test";
import assert from "node:assert/strict";

import { shouldEmitInterimAck } from "../src/agent/interim-ack.js";

test("emits interim ack for fast mode (双模式下 fast 也发垫词)", () => {
  // 双模式下 fast 和 complex 都发垫词；文本需 ≥4 字符
  assert.equal(shouldEmitInterimAck("帮我看一下今天的新闻"), true);
  assert.equal(shouldEmitInterimAck("你好呀，在吗"), true);
  assert.equal(shouldEmitInterimAck("帮我查一下天气"), true);
});

test("does not emit interim ack for noise/troll messages", () => {
  assert.equal(shouldEmitInterimAck("hi"), false);
  assert.equal(shouldEmitInterimAck(""), false);
  assert.equal(shouldEmitInterimAck("ok"), false);
  assert.equal(shouldEmitInterimAck("你好", "fast"), false); // <4 chars
});
