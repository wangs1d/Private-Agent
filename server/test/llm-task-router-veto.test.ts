/**
 * L1 意图分类 + L2 路由决策（2026-09-02 classify-then-route）行为测试。
 *
 * 架构契约：
 *   L0 规则短路：高精度寒暄零 LLM 成本直判 chat；
 *   L1 结构化分类：provider 只输出 {"intent","confidence"} JSON；
 *   L2 代码裁决：路由表映射车道 + 置信度 fail-safe + 词法硬底线（只能升不能降）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
const { parseIntentJson, routePlanForIntent, INTENT_LABELS } = await import(
  "../src/agent/intent-router.js"
);

/** 假 L1 分类器：返回指定意图 JSON，并记录被调用次数（供 L0 短路断言）。 */
function fakeProvider(intent: string, confidence = 0.9) {
  const calls = { count: 0 };
  const provider = {
    isEnabled: () => true,
    streamCompletion: async () => {
      calls.count += 1;
      return JSON.stringify({ intent, confidence });
    },
  };
  return { provider: provider as never, calls };
}

test("L0 规则短路：寒暄零 LLM 成本直判 chat", async () => {
  const { provider, calls } = fakeProvider("chat");
  const decision = await routeTurnByLlm(provider, "sess-l0-1", "在吗");
  assert.equal(decision.mode, "fast");
  assert.equal(decision.intent, "chat");
  assert.ok(
    decision.reasons.some((r) => r.startsWith("l0_short_circuit")),
    `应命中 L0 短路，实际: ${decision.reasons.join(",")}`,
  );
  assert.equal(calls.count, 0, "L0 短路不应调用 LLM");
});

test("L1+L2：realtime_lookup 按路由表映射 fast，无词法硬信号时不否决", async () => {
  // 文本不含 查/搜/最新 等词法硬信号，纯靠 L1 语义标签定车道
  const { provider } = fakeProvider("realtime_lookup");
  const decision = await routeTurnByLlm(provider, "sess-l1-1", "帮我扒扒景甜");
  assert.equal(decision.mode, "fast");
  assert.equal(decision.intent, "realtime_lookup");
  assert.ok(decision.reasons.some((r) => r.includes("route_table:fast/search")));
});

test("L1+L2：media_retrieval → fast/search 束", async () => {
  const { provider } = fakeProvider("media_retrieval");
  const decision = await routeTurnByLlm(provider, "sess-l1-2", "给我几张景甜的美照");
  assert.equal(decision.mode, "fast");
  assert.equal(decision.intent, "media_retrieval");
});

test("L2 词法硬底线：LLM 判 chat 但消息含时效信号 → 否决升 complex", async () => {
  // 「刘浩存最近的消息」线上真实案例：语义判错 chat 时词法兜住
  const { provider } = fakeProvider("chat", 0.92);
  const decision = await routeTurnByLlm(provider, "sess-veto-1", "刘浩存最近的消息");
  assert.equal(decision.mode, "complex", `应被词法硬底线否决，实际 ${decision.mode}`);
  assert.ok(decision.reasons.some((r) => r.includes("lexical_veto")));
});

test("L2 词法硬底线：明确搜索请求被判 chat → 否决升 complex", async () => {
  const { provider } = fakeProvider("chat", 0.9);
  const decision = await routeTurnByLlm(provider, "sess-veto-2", "帮我搜索景甜的照片");
  assert.equal(decision.mode, "complex");
  assert.ok(decision.reasons.some((r) => r.includes("lexical_veto")));
});

test("L2 置信度 fail-safe：低置信 chat 不放回 fast", async () => {
  // 文本长度 > 12 且无词法硬信号：确保走 L1 分类器而非 L0 短路/词法否决
  const { provider } = fakeProvider("chat", 0.3);
  const decision = await routeTurnByLlm(provider, "sess-failsafe-1", "我跟你讲哦今天遇到的事情有点多啊");
  assert.equal(decision.mode, "complex");
  assert.ok(decision.reasons.some((r) => r.includes("low_confidence_fail_safe")));
});

test("L2 路由表：action_write / multi_step_task 直判 complex", async () => {
  const write = await routeTurnByLlm(
    fakeProvider("action_write").provider,
    "sess-table-1",
    "明天早上八点提醒我开会",
  );
  assert.equal(write.mode, "complex");
  assert.equal(write.intent, "action_write");

  const task = await routeTurnByLlm(
    fakeProvider("multi_step_task").provider,
    "sess-table-2",
    "用电脑帮我把这批照片整理到新建文件夹",
  );
  assert.equal(task.mode, "complex");
  assert.equal(task.intent, "multi_step_task");
});

test("解析容错：旧二值输出（fast/complex 文本）仍可降级解析", async () => {
  const legacyFast = parseIntentJson("fast");
  assert.equal(legacyFast?.intent, "chat");
  const legacyComplex = parseIntentJson("complex");
  assert.equal(legacyComplex?.intent, "multi_step_task");
});
