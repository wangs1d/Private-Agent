/**
 * task-router（2026-09-05 双面架构）单元测试。
 *
 * 本模块只承担两件事：
 *   1. 类型与执行计划派生（planFieldsForMode）；
 *   2. 高精度纯闲聊短路（isHighPrecisionChatText）——锚定全文匹配，
 *      不含任何话题关键词（价格/天气/新闻词表已删除，工具需求由 L1 语义分类判定）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isHighPrecisionChatText,
  determineSegmentable,
  planFieldsForMode,
} from "../src/agent/task-router.js";

test("高精度闲聊：寒暄/口头禅/应答词整句命中", () => {
  for (const t of ["在吗", "还在吗", "哈哈", "好的", "收到", "晚安", "你好", "thanks"]) {
    assert.equal(isHighPrecisionChatText(t), true, `「${t}」应为高精度闲聊`);
  }
  // 带标点/空白尾巴仍命中（锚定匹配允许尾随标点）
  assert.equal(isHighPrecisionChatText("在吗？"), true);
  assert.equal(isHighPrecisionChatText("哈哈！"), true);
});

test("高精度闲聊：任何携带诉求/任务的句子都不得命中（无话题词表，靠锚定全文匹配保证）", () => {
  for (const t of [
    "现在比特币多少钱一个", // 未出现过的价格表达——不需要价格词表也不会误判闲聊
    "今天天气怎么样",
    "帮我订明天上午的机票",
    "刘浩存最近的消息",
    "在吗帮我查个东西", // 寒暄前缀 + 诉求拼接（非整句寒暄）
    "好的，另外把明天的提醒改到八点",
    "嗯嗯，那你帮我看看这个月的账单",
  ]) {
    assert.equal(isHighPrecisionChatText(t), false, `「${t}」不得被闲聊短路吞掉`);
  }
});

test("高精度闲聊：超长文本不短路（防拼接绕过）", () => {
  assert.equal(isHighPrecisionChatText("在吗".repeat(20)), false);
});

test("分段判定：对话面分段，任务面不分段", () => {
  assert.equal(determineSegmentable("chat"), true);
  assert.equal(determineSegmentable("task"), false);
});

test("执行计划派生：fast=对话面零工具；complex=任务面保守预算", () => {
  const chat = planFieldsForMode("fast");
  assert.deepEqual(chat, { plane: "chat", capabilities: [], budget: 0, tier: "fast" });

  const task = planFieldsForMode("complex");
  assert.equal(task.plane, "task");
  assert.deepEqual(task.capabilities, ["full"]);
  assert.ok(task.budget >= 1);
});
