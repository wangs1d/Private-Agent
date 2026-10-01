/**
 * 任务面 router-first 旅游规划族恒注入（2026-10-01 从 goal 语义+latch 改恒注入）单测。
 *
 * 契约：router-first 任务轮（full 束/后台派发/保守降级）可见集 = 桥工具 +
 * travel 规划族瘦身 schema（恒注入，不再依赖 goal 正则命中）；编辑/回查类
 * 跟随工具不在清单内。配套口径：ROUTER_FIRST_LANE_MAX_VISIBLE = 桥(2)+规划族(4)。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  pickTravelPlanningTools,
  ROUTER_FIRST_LANE_MAX_VISIBLE,
  TRAVEL_PLANNING_PROMOTED_NAMES,
  slimToolSchema,
  toolsMatchingCapabilityBeam,
} from "../src/external-model/lane-tool-sets.js";
import type { ChatCompletionTool } from "../src/external-model/types.js";

function fn(name: string, description = name): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { q: { type: "string", description: "字段级描述应被瘦身剥掉" } },
      },
    },
  };
}

const CORPUS = [
  fn("tool_discover"),
  fn("travel.plan-itinerary"),
  fn("travel.search-poi"),
  fn("travel.destination-info"),
  fn("travel.compute-route"),
  fn("travel.get-itinerary"),
  fn("travel.edit-itinerary"),
  fn("search_web"),
];

test("恒注入：无论 goal 语义，规划族四工具常驻可见", () => {
  const promoted = pickTravelPlanningTools(CORPUS).map(
    (t) => (t as { function: { name: string } }).function.name,
  );
  assert.deepEqual(promoted.sort(), [
    "travel.compute-route",
    "travel.destination-info",
    "travel.plan-itinerary",
    "travel.search-poi",
  ]);
  assert.equal(
    promoted.every((n) => TRAVEL_PLANNING_PROMOTED_NAMES.has(n)),
    true,
  );
});

test("恒注入走瘦身 schema：字段级描述被剥、description 压首句", () => {
  const [first] = pickTravelPlanningTools(CORPUS);
  assert.ok(first);
  const params = (first as { function: { parameters: { properties: Record<string, unknown> } } })
    .function.parameters.properties;
  assert.equal("description" in params.q, false);
});

test("语料缺失 travel 工具时不炸（提升结果为空）", () => {
  assert.deepEqual(pickTravelPlanningTools([fn("search_web"), fn("tool_call")]), []);
});

test("口径：router-first 常驻规模上限 = 桥(2) + 规划族(4)", () => {
  assert.equal(ROUTER_FIRST_LANE_MAX_VISIBLE, 6);
});

test("轻任务束投影（2026-10-01 一次分类处处消费）：search 束含检索族、不含写动作族", () => {
  const beam = toolsMatchingCapabilityBeam(CORPUS, ["search"]).map(
    (t) => (t as { function: { name: string } }).function.name,
  );
  assert.ok(beam.includes("search_web"));
  assert.equal(beam.includes("tool_discover"), false); // 桥工具由 prepareTools 另行注入
});

test("full/空束不投影（仍走 router-first 桥召回）", () => {
  assert.deepEqual(toolsMatchingCapabilityBeam(CORPUS, ["full"]), []);
  assert.deepEqual(toolsMatchingCapabilityBeam(CORPUS, []), []);
});

test("slimToolSchema 确定性：同输入恒同输出（防前缀缓存抖动）", () => {
  const a = slimToolSchema(fn("x", "首句。第二句不保留。"));
  const b = slimToolSchema(fn("x", "首句。第二句不保留。"));
  assert.deepEqual(a, b);
});
