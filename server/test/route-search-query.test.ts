/**
 * realtime 轮路由搜索词（search_query）提取的回归测试（2026-09-13 根修配套）。
 *
 * 背景：「她最近在那」类位置近况轮的「真实搜索」由程序前置检索确定性执行，
 * 前提是路由器输出的 search_query 能完整进入 RouteDecision。此前的失败模式：
 *   1. 超长 query 被整体丢弃 → realtime 轮失去前置检索，模型口头推脱「搜过了」；
 *   2. 前置检索门禁只认对话面，而 realtime_lookup 路由表契约是 plane=task →
 *      主路径死代码（由 launchComplexBackgroundTask 的 routeSearchQuery 透传修复，
 *      路由表形状在这里一并锁定防回退）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractRouteSearchQuery } from "../src/agent/llm-task-router.js";
import { INTENT_ROUTING_TABLE } from "../src/agent/intent-router.js";

test("search_query 提取：合法 JSON 内的查询词原样返回", () => {
  const raw = JSON.stringify({
    intent: "realtime_lookup",
    confidence: 0.9,
    search_query: "刘浩存 近期 行程",
  });
  assert.equal(extractRouteSearchQuery(raw), "刘浩存 近期 行程");
});

test("search_query 提取：缺省/空串/非字符串返回 undefined", () => {
  assert.equal(extractRouteSearchQuery(undefined), undefined);
  assert.equal(extractRouteSearchQuery("不是 JSON"), undefined);
  assert.equal(
    extractRouteSearchQuery(JSON.stringify({ intent: "chat", search_query: "" })),
    undefined,
  );
  assert.equal(
    extractRouteSearchQuery(JSON.stringify({ intent: "chat", search_query: "   " })),
    undefined,
  );
});

test("search_query 提取：超长查询截断采用而非整体丢弃（丢弃 = realtime 轮失去前置检索）", () => {
  const longQuery =
    "刘浩存 最近半年 行程动态汇总 在哪个城市 泰国电影拍摄剧组进展 公开活动安排 杂志拍摄通告 最新消息 微博更新 粉丝偶遇 现身机场"; // > 60 字符
  assert.ok(longQuery.length > 60, `用例前置：查询词需超 60 字（实际 ${longQuery.length}）`);
  const extracted = extractRouteSearchQuery(JSON.stringify({ search_query: longQuery }));
  assert.ok(extracted, "超长查询不得被丢弃");
  assert.equal(extracted!.length, 60);
  assert.ok(longQuery.startsWith(extracted!));
});

test("路由表契约：realtime_lookup 恒为任务面 search 能力（前置检索双面透传的前提）", () => {
  const plan = INTENT_ROUTING_TABLE.realtime_lookup;
  assert.equal(plan.plane, "task");
  assert.ok(plan.capabilities.includes("search"));
});
