import test from "node:test";
import assert from "node:assert/strict";

import { shouldUsePhasedAsyncConversation } from "../src/agent/interim-ack.js";
import { routeLlmExecution } from "../src/agent/task-router.js";

const config = {
  masterDelegation: { enabled: true },
} as Parameters<typeof routeLlmExecution>[1];

test("routes greetings to fast", () => {
  const result = routeLlmExecution("你好", config);
  assert.equal(result.mode, "fast");
});

test("routes explanatory requests to fast (主 Agent 自处理)", () => {
  const result = routeLlmExecution("请简单解释一下什么是向量数据库", config);
  assert.equal(result.mode, "fast");
});

test("routes code explanation requests to fast (主 Agent 自处理)", () => {
  const result = routeLlmExecution("帮我解释一下 Python 里列表推导式和 for 循环的区别", config);
  assert.equal(result.mode, "fast");
});

test("routes multi-step research to complex (requires sub-agent)", () => {
  const result = routeLlmExecution("帮我调研对比一下三款主流向量数据库的优缺点", config);
  assert.equal(result.mode, "complex");
});

test("routes shopping/orders to complex", () => {
  const result = routeLlmExecution("帮我在京东下单买一个蓝牙耳机", config);
  assert.equal(result.mode, "complex");
});

test("uses phased async conversation for complex mode (垫词 enabled for all modes)", () => {
  const text = "帮我看看今天的新闻";
  const result = routeLlmExecution(text, config);
  assert.equal(result.mode, "complex");
  assert.equal(shouldUsePhasedAsyncConversation(text, result.mode), true);
});

test("uses phased async conversation for complex mode", () => {
  const text = "帮我调研对比一下三款主流向量数据库的优缺点";
  const result = routeLlmExecution(text, config);
  assert.equal(result.mode, "complex");
  assert.equal(shouldUsePhasedAsyncConversation(text, result.mode), true);
});
