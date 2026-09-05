/**
 * L1 语义意图分类 + L2 路由决策（2026-09-05 双面架构，根源化设计）行为测试。
 *
 * 架构契约：
 *   L0 高精度闲聊短路：锚定全文的寒暄零 LLM 成本直判 chat；
 *   L1 语义分类：provider 只输出 {"intent","confidence"} JSON——"需不需要工具"
 *      由语义理解判定，不做任何话题关键词枚举（价格/天气词表已删除）；
 *   L2 代码裁决：路由表映射 plane/capabilities/budget/tier + 置信度 fail-safe；
 *   降级：provider 失败/输出不可解析 → 保守落任务面（高精度闲聊除外）。
 *
 * 判错的纠错不在路由层：任务面由 TurnOutcomeGate 续波兜底，
 * 对话面误判由 agent-core 的意图感知转换兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
const { parseIntentJson, routePlanForIntent, INTENT_LABELS } = await import(
  "../src/agent/intent-router.js"
);

/** 假 L1 分类器：返回指定意图 JSON，并记录被调用次数与收到的 prompt。 */
function fakeProvider(intent: string, confidence = 0.9) {
  const calls = { count: 0, prompts: [] as string[] };
  const provider = {
    isEnabled: () => true,
    streamCompletion: async (_sid: string, turn: { text: string }) => {
      calls.count += 1;
      calls.prompts.push(turn.text);
      return JSON.stringify({ intent, confidence });
    },
  };
  return { provider: provider as never, calls };
}

/** 假 L1 分类器：provider 调用直接失败（降级路径用）。 */
function brokenProvider() {
  const provider = {
    isEnabled: () => true,
    streamCompletion: async () => {
      throw new Error("provider down");
    },
  };
  return provider as never;
}

test("L0 短路：寒暄零 LLM 成本直判 chat", async () => {
  const { provider, calls } = fakeProvider("chat");
  const decision = await routeTurnByLlm(provider, "sess-l0-1", "在吗");
  assert.equal(decision.mode, "fast");
  assert.equal(decision.plane, "chat");
  assert.equal(decision.intent, "chat");
  assert.ok(decision.reasons.some((r) => r.startsWith("l0_short_circuit")));
  assert.equal(calls.count, 0, "L0 短路不应调用 LLM");
});

test("L0 短路不吞掉带诉求的句子：比特币价格句必须进 L1 语义分类", async () => {
  // 线上教训：≤12 字 + 无话题词的诉求句曾被长度兜底吞成闲聊。
  // 根源修复后：L0 只认锚定全文的寒暄，此句必须交给 L1 语义判定。
  const { provider, calls } = fakeProvider("realtime_lookup");
  const decision = await routeTurnByLlm(provider, "sess-l0-2", "现在比特币多少钱一个");
  assert.equal(calls.count, 1, "应进入 L1 语义分类");
  assert.equal(decision.plane, "task");
  assert.deepEqual(decision.capabilities, ["search"]);
});

test("L1+L2：realtime_lookup 按路由表映射任务面（轻预算 Flash 档）", async () => {
  const { provider } = fakeProvider("realtime_lookup");
  const decision = await routeTurnByLlm(provider, "sess-l1-1", "帮我扒扒景甜");
  assert.equal(decision.plane, "task");
  assert.equal(decision.mode, "complex");
  assert.deepEqual(decision.capabilities, ["search"]);
  assert.equal(decision.budget, 2);
  assert.equal(decision.tier, "fast");
  assert.ok(decision.reasons.some((r) => r.includes("route_table:task/search")));
});

test("L1+L2：media_retrieval → 任务面 media+search 束", async () => {
  const { provider } = fakeProvider("media_retrieval");
  const decision = await routeTurnByLlm(provider, "sess-l1-2", "给我几张景甜的美照");
  assert.equal(decision.plane, "task");
  assert.equal(decision.intent, "media_retrieval");
  assert.deepEqual(decision.capabilities, ["media", "search"]);
});

test("L1+L2：chat 直判对话面（零工具零预算）", async () => {
  const { provider, calls } = fakeProvider("chat", 0.9);
  const decision = await routeTurnByLlm(provider, "sess-l1-3", "今天忙了一天真的好累啊不想动了");
  assert.equal(decision.plane, "chat");
  assert.equal(decision.mode, "fast");
  assert.deepEqual(decision.capabilities, []);
  assert.equal(decision.budget, 0);
  assert.equal(calls.count, 1, "L1 分类恰好调用一次");
});

test("L2 fail-safe：低置信 chat 不放回对话面", async () => {
  const { provider } = fakeProvider("chat", 0.3);
  const decision = await routeTurnByLlm(provider, "sess-failsafe-1", "我跟你讲哦今天遇到的事情有点多啊");
  assert.equal(decision.plane, "task");
  assert.ok(decision.reasons.some((r) => r.includes("low_confidence_fail_safe")));
});

test("L2 路由表：action_write / multi_step_task 直判任务面", async () => {
  const write = await routeTurnByLlm(
    fakeProvider("action_write").provider,
    "sess-table-1",
    "明天早上八点提醒我开会",
  );
  assert.equal(write.plane, "task");
  assert.equal(write.intent, "action_write");
  assert.equal(write.tier, "complex");

  const task = await routeTurnByLlm(
    fakeProvider("multi_step_task").provider,
    "sess-table-2",
    "用电脑帮我把这批照片整理到新建文件夹",
  );
  assert.equal(task.plane, "task");
  assert.equal(task.intent, "multi_step_task");
});

test("保守降级：provider 失败时，非闲聊句一律落任务面（不再依赖话题词表）", async () => {
  const decision = await routeTurnByLlm(brokenProvider(), "sess-fallback-1", "刘浩存最近有什么消息");
  assert.equal(decision.plane, "task", "无法语义判定时应保守落任务面");
  assert.ok(decision.reasons.some((r) => r.includes("conservative_task_plane")));
});

test("保守降级：provider 失败时，高精度寒暄仍落对话面（零成本）", async () => {
  const decision = await routeTurnByLlm(brokenProvider(), "sess-fallback-2", "在吗");
  assert.equal(decision.plane, "chat");
});

test("保守降级：不可解析输出 → 任务面（不缓存，恢复后立即回到语义路由）", async () => {
  const provider = {
    isEnabled: () => true,
    streamCompletion: async () => "这不是JSON",
  } as never;
  const decision = await routeTurnByLlm(provider, "sess-fallback-3", "帮我查一下京东的股价");
  assert.equal(decision.plane, "task");
  assert.ok(decision.reasons.some((r) => r.includes("unparseable_output")));
});

test("上下文注入：活跃任务摘要与最近对话进入路由 prompt（语义挂接的根）", async () => {
  const { provider, calls } = fakeProvider("multi_step_task");
  await routeTurnByLlm(
    provider,
    "sess-ctx-1",
    "改成明天下午吧",
    ["帮我订明天上午去上海的机票"],
    "1. [running] 帮我订明天上午去上海的机票 已运行 2 分钟",
  );
  const prompt = calls.prompts[0] ?? "";
  assert.ok(prompt.includes("订明天上午去上海的机票"), "活跃任务摘要应注入 prompt");
  assert.ok(prompt.includes("帮我订明天上午去上海的机票"), "最近对话应注入 prompt");
});

test("解析容错：JSON 噪声/近似词仍可解析", async () => {
  assert.equal(parseIntentJson("realtime_lookup")?.intent, "realtime_lookup");
  assert.equal(parseIntentJson('[ts:x] {"intent":"media_retrieval","confidence":0.8}')?.intent, "media_retrieval");
});

test("路由效率：同文本命中 5 分钟缓存，不重复调用 LLM", async () => {
  const { provider, calls } = fakeProvider("realtime_lookup");
  await routeTurnByLlm(provider, "sess-cache", "今天黄金价格多少");
  await routeTurnByLlm(provider, "sess-cache", "今天黄金价格多少");
  assert.equal(calls.count, 1);
});
