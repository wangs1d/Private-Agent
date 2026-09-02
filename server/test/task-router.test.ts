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

// ── 媒体诉求路由回归（2026-09-02「性感一点的女生照片」案例）──
import { shouldUseFastChatLane, determineSegmentable, requiresMediaRetrieval } from "../src/agent/task-router.js";

test("media requests bypass the L0 chat short-circuit", () => {
  // 线上真实案例：短（≤12 字）且不含任何既有硬信号词的找图请求，
  // 被 L0 词法短路判成 chat——聊天语境没有媒体工具，模型只能凭空编
  // 「给你找了几张」。修复：媒体诉求词法信号命中时不允许 L0 短路，
  // 放行给 L1 语义分类（media_retrieval → fast + 媒体工具束 + strict 仲裁）。
  assert.equal(requiresMediaRetrieval("性感一点的女生照片"), true);
  assert.equal(shouldUseFastChatLane("性感一点的女生照片"), false);
  assert.equal(shouldUseFastChatLane("来点性感一点的女生的照片"), false);
  assert.equal(shouldUseFastChatLane("找几张海蓝色亮片薄纱裙的图"), false);
});

test("media request replies are not chat-segmented", () => {
  // 媒体轮是信息性内容（照片墙 + 逐张介绍），不做闲聊式短句分段
  assert.equal(determineSegmentable("性感一点的女生照片", "fast"), false);
  // 纯寒暄仍分段
  assert.equal(determineSegmentable("在吗", "fast"), true);
});
