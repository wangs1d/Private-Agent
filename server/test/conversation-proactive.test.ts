import assert from "node:assert/strict";
import test from "node:test";

// 对话主动钩子已从 agent-core 迁移至 ProactivityHub 模块（新旧替换，行为不变）
import {
  detectConversationProactiveHook,
} from "../src/proactivity/triggers/conversation-triggers.js";
import { SemanticAwarenessInferrerImpl } from "../src/brain/semantic-awareness-inferrer.js";

test("钩子检测：无人称相关强线索时保持静默（返回 null）", () => {
  assert.equal(detectConversationProactiveHook("周末去爬山，山里空气不错"), null);
  assert.equal(detectConversationProactiveHook(undefined), null);
  assert.equal(detectConversationProactiveHook(""), null);
  assert.equal(detectConversationProactiveHook("1+1=2"), null);
});

test("钩子检测：情绪/疲惫类线索 → care，importance=high", () => {
  const hook = detectConversationProactiveHook("今天加班到好累，真的睡不着");
  assert.ok(hook);
  assert.equal(hook.kind, "care");
  assert.equal(hook.importance, "high");
});

test("钩子检测：等待/待办类线索 → followup，importance=medium", () => {
  const hook = detectConversationProactiveHook("那个简历HR说等结果，帮我盯着点");
  assert.ok(hook);
  assert.equal(hook.kind, "followup");
  assert.equal(hook.importance, "medium");
});

test("语义觉察推断：从对话文本推断意图与情绪成因", async () => {
  const inferrer = new SemanticAwarenessInferrerImpl();
  const mental = await inferrer.infer("u1", {
    recentConversationHistory: "用户：改这个模块赶工好累，明天deadline\nAgent：辛苦啦",
    recentActivity: { activity: "busy" } as never,
  });
  assert.equal(mental.intentCategory, "executing");
  assert.equal(mental.emotionCause, "work_pressure");
  assert.ok(mental.evidence.includes("activity=busy"));
});

test("语义觉察推断：无强信号时降级为 unknown/neutral，不编造话题趋势", async () => {
  const inferrer = new SemanticAwarenessInferrerImpl();
  const mental = await inferrer.infer("u1", { recentConversationHistory: "" });
  assert.equal(mental.intentCategory, "unknown");
  assert.equal(mental.emotionCause, "neutral");
  assert.equal(mental.topicTrend, null);
});