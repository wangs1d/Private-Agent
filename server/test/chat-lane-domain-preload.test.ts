/**
 * chat 车道域信号预召回单测（2026-10-09 工具链根修）。
 *
 * 根因回归：travel 全族在延迟目录，chat 车道模型不主动 tool_discover 就手写
 * 行程（旅游卡缺席；profile.update / weather.get_local 同款教训，三次实证）。
 * 根修后 explicit 轮可见集 = chat Core ∪ buildDomainPreloadTools（BM25 域多数票
 * 命中域全族瘦身 schema）——「帮我规划…行程」这类轮次 travel.plan-itinerary
 * 确定性对模型可见，不再依赖模型自觉 discover。
 *
 * 注意：travel 技能族不在静态 builtin 注册表，生产由 bootstrap 注册链注入；
 * 测试环境按注册链同源构造（同 lane-tool-travel-promotion.test.ts）。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const {
  buildDomainPreloadTools,
  buildLaneCoreTools,
  CHAT_LANE_CORE_NAMES,
} = await import("../src/external-model/lane-tool-sets.js");
import type { ChatCompletionTool } from "openai/resources/chat/completions";

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

/** 生产语料 + travel 技能族（bootstrap 注册链同源构造） */
const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools()];
for (const n of [
  "travel.plan-itinerary", "travel.search-poi", "travel.destination-info",
  "travel.compute-route", "travel.get-itinerary", "travel.edit-itinerary",
]) {
  corpus.push(fn(n, `${n}：行程规划`));
}

function toolName(t: ChatCompletionTool): string {
  return t.type === "function" ? t.function?.name ?? "" : "";
}

test("旅游轮根因回归：travel.plan-itinerary 确定性进可见集（无需模型自觉 discover）", () => {
  const coreNames = new Set(CHAT_LANE_CORE_NAMES);
  const preload = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  const names = preload.map(toolName);
  assert.ok(
    names.includes("travel.plan-itinerary"),
    `预载缺 travel.plan-itinerary，实际: ${names.join(",")}`,
  );
});

test("chat 车道装配口径：Core ∪ 预载无重名（与 buildChatLaneExplicitOpts 同构）", () => {
  const core = buildLaneCoreTools("chat", corpus);
  const coreNames = new Set(core.map(toolName).filter(Boolean));
  const preload = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  const union = [...core.map(toolName), ...preload.map(toolName)];
  assert.equal(new Set(union).size, union.length, "Core 与预载出现重名");
  assert.ok(preload.map(toolName).includes("travel.plan-itinerary"));
});

test("预载 schema 瘦身：字段级描述被剥掉（控 token）", () => {
  const preload = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, new Set());
  assert.ok(preload.length > 0);
  const first = preload[0]!;
  const params = (first.function?.parameters ?? {}) as {
    properties?: Record<string, unknown>;
  };
  const prop = params.properties?.q as { description?: string } | undefined;
  assert.ok(prop, "测试构造的字段 q 应保留");
  assert.equal("description" in prop, false, "字段级描述应被瘦身剥掉");
});

test("闲聊轮不注入：无强信号 → 空预载（零工具隔离语义不受影响）", () => {
  assert.deepEqual(buildDomainPreloadTools("嗯嗯好的", corpus), []);
  assert.deepEqual(buildDomainPreloadTools("哈哈哈哈哈", corpus), []);
  assert.deepEqual(buildDomainPreloadTools("", corpus), []);
});

test("去重：excludeNames 命中的工具不重复注入，且先排除后截断", () => {
  const synthetic = [
    fn("travel.plan-itinerary", "旅游行程规划：景点 门票 攻略"),
    fn("travel.search-poi", "景点搜索：景区 门票"),
    fn("travel.destination-info", "目的地信息：旅游 攻略"),
    fn("search_web", "联网搜索网页"),
  ];
  const exclude = new Set(["travel.plan-itinerary"]);
  const preload = buildDomainPreloadTools("帮我规划旅游行程看景点门票", synthetic, exclude);
  const names = preload.map(toolName);
  assert.equal(names.includes("travel.plan-itinerary"), false, "Core 已含的工具不应重复注入");
  assert.ok(names.includes("travel.search-poi"), `增量工具应注入: ${names.join(",")}`);
});

test("cap 生效：域族超过上限时截断", () => {
  const big = [fn("search_web", "联网搜索网页")];
  for (let i = 0; i < 20; i++) {
    big.push(fn(`fake.travel.tool${i}`, `旅游 行程 规划 景点 工具${i}`));
  }
  const preload = buildDomainPreloadTools("帮我规划旅游行程看景点", big, new Set(), 5);
  assert.ok(preload.length <= 5, `预载族规模超上限: ${preload.length}`);
});

test("确定性：同文本同语料恒同预载（前缀缓存前提）", () => {
  const coreNames = new Set(CHAT_LANE_CORE_NAMES);
  const a = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  const b = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  assert.deepEqual(a, b);
});
