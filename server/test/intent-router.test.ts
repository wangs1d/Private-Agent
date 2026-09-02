/**
 * intent-router（意图路由表 + JSON 解析）单元测试。
 * 路由表是"模型提案、代码裁决"架构的权威数据——每个标签的执行契约在此锁定。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { parseIntentJson, routePlanForIntent, isIntentLabel, INTENT_LABELS } = await import(
  "../src/agent/intent-router.js"
);

test("路由表：每个意图标签都有确定的执行契约", () => {
  for (const label of INTENT_LABELS) {
    const plan = routePlanForIntent(label);
    assert.ok(plan, `标签 ${label} 必须在路由表中`);
    assert.ok(["fast", "complex"].includes(plan.lane));
    assert.ok(["light", "search", "media", "full"].includes(plan.toolset));
    assert.ok(["strict", "standard"].includes(plan.arbiter));
  }
});

test("路由表：实时查询/媒体检索走 fast+严格仲裁，写数据/多步走 complex", () => {
  assert.deepEqual(routePlanForIntent("realtime_lookup"), {
    lane: "fast",
    toolset: "search",
    arbiter: "strict",
  });
  assert.deepEqual(routePlanForIntent("media_retrieval"), {
    lane: "fast",
    toolset: "media",
    arbiter: "strict",
  });
  assert.equal(routePlanForIntent("action_write").lane, "complex");
  assert.equal(routePlanForIntent("multi_step_task").lane, "complex");
  assert.equal(routePlanForIntent("chat").lane, "fast");
  assert.equal(routePlanForIntent("chat").arbiter, "standard");
});

test("parseIntentJson：规范 JSON 输出", () => {
  const parsed = parseIntentJson('{"intent":"realtime_lookup","confidence":0.87}');
  assert.deepEqual(parsed, { intent: "realtime_lookup", confidence: 0.87 });
});

test("parseIntentJson：剥 [ts:] 前缀 + 夹带噪声仍可解析", () => {
  const parsed = parseIntentJson('[ts:2026-09-02 00:00:00|周二] {"intent":"media_retrieval","confidence":0.8} 以上。');
  assert.equal(parsed?.intent, "media_retrieval");
  assert.equal(parsed?.confidence, 0.8);
});

test("parseIntentJson：confidence 越界钳制与字符串数字", () => {
  assert.equal(parseIntentJson('{"intent":"chat","confidence":1.7}')?.confidence, 1);
  assert.equal(parseIntentJson('{"intent":"chat","confidence":"0.6"}')?.confidence, 0.6);
  assert.equal(parseIntentJson('{"intent":"chat"}')?.confidence, 0.75, "缺省置信度取中性默认");
});

test("parseIntentJson：JSON 失败时降级全文标签词扫描（含旧二值兼容）", () => {
  assert.equal(parseIntentJson("realtime_lookup")?.intent, "realtime_lookup");
  assert.equal(parseIntentJson("fast")?.intent, "chat");
  assert.equal(parseIntentJson("complex")?.intent, "multi_step_task");
  // 降级扫描置信度打折（触发上游 fail-safe）
  assert.equal(parseIntentJson("fast")?.confidence, 0.5);
});

test("parseIntentJson：完全无法解析 → null（调用方降级词法层）", () => {
  assert.equal(parseIntentJson(""), null);
  assert.equal(parseIntentJson(undefined), null);
  assert.equal(parseIntentJson("嗯嗯好的"), null);
});

test("isIntentLabel：封闭集校验", () => {
  assert.equal(isIntentLabel("chat"), true);
  assert.equal(isIntentLabel("nope"), false);
  assert.equal(isIntentLabel(42), false);
});
