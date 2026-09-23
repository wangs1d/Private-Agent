// SemanticTriggerMatcher（语义触发匹配器）单测：
// 特征提取、指纹、种子范例泛化命中、learn 在线扩充、去重与统计。
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  detectSemanticHook,
  exemplarStats,
  extractTextFeatures,
  fingerprintText,
  learnExemplar,
  resetExemplars,
} from "../src/proactivity/semantic-trigger-matcher.js";
import { detectConversationProactiveHook } from "../src/proactivity/triggers/conversation-triggers.js";

beforeEach(() => resetExemplars());

test("extractTextFeatures：中文 2-gram + 英文 token 小写化", () => {
  const feats = extractTextFeatures("我好累 stress out");
  assert.ok(feats.includes("我好"));
  assert.ok(feats.includes("好累"));
  assert.ok(feats.includes("stress"));
  assert.ok(feats.includes("out"));
  assert.ok(!feats.includes("Stress"));
});

test("fingerprintText：词序无关（同内容同指纹）", () => {
  assert.equal(fingerprintText("今天加班 好累"), fingerprintText("好累 今天加班"));
  assert.notEqual(fingerprintText("今天加班"), fingerprintText("今天摸鱼"));
});

test("泛化命中：换说法的待办表达（正则写不完的）命中 followup", () => {
  // 正则层不命中（无关键词），语义层靠范例覆盖命中
  const m = detectSemanticHook("这事儿先放放，过两天再说");
  assert.ok(m);
  assert.equal(m.kind, "followup");
  assert.ok(m.coverage >= 0.35);
});

test("无关文本不命中（爬山/算术/闲聊/情绪表达）", () => {
  assert.equal(detectSemanticHook("周末去爬山，山里空气不错"), null);
  assert.equal(detectSemanticHook("1+1=2"), null);
  assert.equal(detectSemanticHook("在忙一个新模块的设计"), null);
  assert.equal(detectSemanticHook("最近加班快撑不住了"), null); // care 类已下线，不再命中
});

test("短文本（<2 特征）不命中语义层", () => {
  assert.equal(detectSemanticHook("等"), null); // 语义层需 ≥2 重叠特征
});

test("learnExemplar：学习后新说法可命中 + 去重", () => {
  const text = "回头帮我把那封邮件再催一下";
  assert.equal(detectSemanticHook(text), null); // 学习前不命中
  assert.equal(learnExemplar("followup", text), true);
  const m = detectSemanticHook(text);
  assert.ok(m);
  assert.equal(m.kind, "followup");
  // 同文本重复学习：指纹去重
  assert.equal(learnExemplar("followup", text), false);
  assert.equal(exemplarStats().followup.learned, 1);
});

test("learnExemplar：过短文本拒学", () => {
  assert.equal(learnExemplar("followup", "等"), false);
  assert.equal(learnExemplar("followup", "  "), false);
});

test("learnExemplar：范例滚动上限（防无限膨胀）", () => {
  for (let i = 0; i < 45; i++) {
    learnExemplar("followup", `第${i}条不一样的跟进安排编号${i}`);
  }
  assert.ok(exemplarStats().followup.total <= 40);
});

test("conversation-triggers 集成：学习后的文本走语义层触发 followup 钩子", () => {
  const text = "那件小事先搁着，回头咱们再谈";
  assert.equal(detectConversationProactiveHook(text), null); // 学习前：正则+种子都不命中
  learnExemplar("followup", text);
  const hook = detectConversationProactiveHook(text);
  assert.ok(hook);
  assert.equal(hook.kind, "followup");
  assert.equal(hook.importance, "medium");
});

test("conversation-triggers 集成：正则关键词仍直判（高精度种子层优先）", () => {
  const hook = detectConversationProactiveHook("那个简历HR说等结果，帮我盯着点");
  assert.ok(hook);
  assert.equal(hook.kind, "followup");
  assert.equal(hook.importance, "medium");
});
