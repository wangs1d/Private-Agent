/**
 * L1 语义意图分类 + L2 路由决策（2026-09-07 前置路由门）行为测试。
 *
 * 架构契约：
 *   前置路由门（默认，取代 2026-09-05/06 前台自决）：routeTurnByLlm **每轮必跑**
 *      ——「要不要办事」由 L1 语义分类判定，plane=task 的派发触发由程序层
 *      （agent-core）确定性执行，不再依赖前台模型自觉调 task.dispatch。
 *   L1 语义分类：provider 只输出 {"intent","confidence"} JSON——"需不需要工具"
 *      由语义理解判定，不做任何话题关键词枚举（价格/天气词表已删除）；
 *   L2 代码裁决：路由表映射 plane/capabilities/budget/tier；
 *   降级：provider 失败/输出不可解析 → 保守落任务面（高精度闲聊除外）。
 *
 * 已删除并验证不回归的旧机制：L0 闲聊短路、L0.5 写动作词法安全网、
 * 低置信 fail-safe、前台自决模式（routeTurnByLlm 整体跳过）。
 */
import assert from "node:assert/strict";
import test from "node:test";

// 前置路由门：AGENT_FOREGROUND_DISPATCH 不再影响 routeTurnByLlm 是否分类
// （旧「整体跳过」语义已退役），本文件在默认模式下验证每轮必跑的独立路由行为。
delete process.env.AGENT_FOREGROUND_DISPATCH;

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

test("前置路由门：默认模式每轮必跑 L1 分类（旧「整体跳过」已退役）", async () => {
  const { provider, calls } = fakeProvider("chat");
  const decision = await routeTurnByLlm(provider, "sess-gate-1", "在吗");
  assert.equal(decision.plane, "chat");
  assert.equal(decision.plane, "chat");
  assert.ok(
    decision.reasons[0]?.startsWith("llm_intent:chat"),
    `应产出真实语义分类理由，实际 ${decision.reasons.join(",")}`,
  );
  assert.equal(calls.count, 1, "前置门不得跳过路由 LLM——触发权威在程序层，前提是分类必跑");
});

test("L1：寒暄经语义分类直判 chat（L0 词法短路已删除，不再有零成本捷径）", async () => {
  const { provider, calls } = fakeProvider("chat");
  const decision = await routeTurnByLlm(provider, "sess-l0-1", "哈喽哈喽");
  assert.equal(decision.plane, "chat");
  assert.equal(decision.plane, "chat");
  assert.equal(decision.intent, "chat");
  assert.equal(calls.count, 1, "应到达 L1 语义分类");
});

test("L1 不吞掉带诉求的句子：比特币价格句进语义分类并落任务面", async () => {
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
  assert.equal(decision.plane, "task");
  assert.deepEqual(decision.capabilities, ["search"]);
  assert.equal(decision.budget, 2);
  assert.equal(decision.tier, "flash");
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
  assert.equal(decision.plane, "chat");
  assert.deepEqual(decision.capabilities, []);
  assert.equal(decision.budget, 0);
  assert.equal(calls.count, 1, "L1 分类恰好调用一次");
});

test("低置信 chat 不再强转任务面（fail-safe 已随前台自决删除）", async () => {
  const { provider } = fakeProvider("chat", 0.3);
  const decision = await routeTurnByLlm(provider, "sess-failsafe-1", "我跟你讲哦今天遇到的事情有点多啊");
  assert.equal(decision.plane, "chat", "fail-safe 已删除：分类结果按路由表直判");
  assert.ok(!decision.reasons.some((r) => r.includes("low_confidence_fail_safe")));
});

test("L2 路由表：action_write 归位对话面（前台直写工具直办）/ multi_step_task 落任务面", async () => {
  const write = await routeTurnByLlm(
    fakeProvider("action_write").provider,
    "sess-table-1",
    "明天早上八点提醒我开会",
  );
  assert.equal(write.plane, "chat", "提醒/日程单工具直办，不再派后台（2026-09-08）");
  assert.equal(write.intent, "action_write");
  assert.equal(write.tier, "flash");

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
