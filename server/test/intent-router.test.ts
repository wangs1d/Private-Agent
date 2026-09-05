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
    assert.ok(["chat", "task"].includes(plan.plane), "必须有执行平面");
    assert.ok(Array.isArray(plan.capabilities), "capabilities 必须是数组");
    assert.ok(Number.isInteger(plan.budget) && plan.budget >= 0, "budget 必须是非负整数");
    assert.ok(["fast", "complex"].includes(plan.tier), "必须有模型档位");
    // 对话面零工具契约：无能力束、零预算
    if (plan.plane === "chat") {
      assert.equal(plan.capabilities.length, 0, "对话面不得携带能力束");
      assert.equal(plan.budget, 0, "对话面预算必须为 0");
    } else {
      assert.ok(plan.capabilities.length > 0, "任务面必须声明能力束");
      assert.ok(plan.budget > 0, "任务面必须有正预算");
    }
  }
});

test("路由表：对话面三标签零工具；实时/媒体轻预算任务面；写数据按 write 束裁剪、多步全量高预算", () => {
  const chat = routePlanForIntent("chat");
  assert.equal(chat.plane, "chat");
  assert.equal(chat.tier, "fast");

  for (const label of ["knowledge_qa", "meta_capability"] as const) {
    assert.equal(routePlanForIntent(label).plane, "chat");
  }

  const realtime = routePlanForIntent("realtime_lookup");
  assert.equal(realtime.plane, "task");
  assert.deepEqual(realtime.capabilities, ["search"]);
  assert.equal(realtime.budget, 2);
  assert.equal(realtime.tier, "fast", "单点查询用 Flash 档，省 token");

  const media = routePlanForIntent("media_retrieval");
  assert.equal(media.plane, "task");
  assert.deepEqual(media.capabilities, ["media", "search"]);
  assert.equal(media.budget, 2);

  const write = routePlanForIntent("action_write");
  assert.equal(write.plane, "task");
  // 2026-09-05：写轮按 write 能力束裁剪注入（calendar/reminder/voice/phone/
  // shopping/wallet/agent/surface + tool_discover 延迟目录桥按需召回长尾），
  // 不再全量注入 112+ 工具 schema（~64k 字符）。
  assert.deepEqual(write.capabilities, ["write"]);
  assert.equal(write.budget, 3);
  assert.equal(write.tier, "complex");

  const multi = routePlanForIntent("multi_step_task");
  assert.equal(multi.plane, "task");
  assert.deepEqual(multi.capabilities, ["full"]);
  assert.equal(multi.budget, 3);
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

test("parseIntentJson：JSON 失败时降级全文标签词扫描", () => {
  assert.equal(parseIntentJson("realtime_lookup")?.intent, "realtime_lookup");
  // 降级扫描置信度打折（触发上游 fail-safe）
  assert.equal(parseIntentJson("media")?.confidence, 0.5);
});

test("parseIntentJson：完全无法解析 → null（调用方保守降级任务面）", () => {
  assert.equal(parseIntentJson(""), null);
  assert.equal(parseIntentJson(undefined), null);
  assert.equal(parseIntentJson("嗯嗯好的"), null);
});

test("isIntentLabel：封闭集校验", () => {
  assert.equal(isIntentLabel("chat"), true);
  assert.equal(isIntentLabel("nope"), false);
  assert.equal(isIntentLabel(42), false);
});
