/**
 * 任务面 router-first 旅游域定向保底（2026-09-24 大理轮）单测。
 *
 * 契约：goal 命中旅游语义时 pickTravelPlanningTools 从语料中取出 travel 规划族
 * 提为常驻可见；未命中返回空（不提升，仍走桥召回）。编辑/回查类跟随工具不在
 * 提升清单内。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  pickTravelPlanningTools,
  TRAVEL_PLANNING_PROMOTED_NAMES,
} from "../src/external-model/lane-tool-sets.js";
import type { ChatCompletionTool } from "../src/external-model/types.js";

function fn(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
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

test("goal 命中旅游语义：规划族四工具提升，编辑/回查类不提升", () => {
  const promoted = pickTravelPlanningTools(CORPUS, true).map(
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

test("goal 未命中：返回空，不提升任何工具", () => {
  assert.deepEqual(pickTravelPlanningTools(CORPUS, false), []);
});

test("语料缺失 travel 工具时不炸（提升结果为可用子集）", () => {
  const promoted = pickTravelPlanningTools([fn("search_web"), fn("tool_call")], true);
  assert.deepEqual(promoted, []);
});
