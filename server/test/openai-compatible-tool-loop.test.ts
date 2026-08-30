import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { shouldRequireFreshWebLookup } from "../src/gateway/forced-tool.js";

const SEARCH_WEB_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_web",
    description: "Search the web",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
};

test("requires fresh web lookup for time-sensitive market/news prompts", () => {
  assert.equal(
    shouldRequireFreshWebLookup("今天A股怎么样，帮我查一下最新消息", [SEARCH_WEB_TOOL]),
    true,
  );
  assert.equal(
    shouldRequireFreshWebLookup("最新电影排片和票价帮我搜一下", [SEARCH_WEB_TOOL]),
    true,
  );
});

test("does not require fresh web lookup for clock-style prompts", () => {
  assert.equal(
    shouldRequireFreshWebLookup("现在几点了", [SEARCH_WEB_TOOL]),
    false,
  );
  assert.equal(
    shouldRequireFreshWebLookup("what time is it now", [SEARCH_WEB_TOOL]),
    false,
  );
});

test("does not require fresh web lookup when the tool is unavailable", () => {
  assert.equal(
    shouldRequireFreshWebLookup("帮我查一下今天股价", []),
    false,
  );
});

// ── 车道内升级（in-trajectory escalation）回归 ──

test("fast lane toolset always carries the escalation escape hatch", async () => {
  const { getFastLaneTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const tools = getFastLaneTools();
  const names = tools.map((t) => ("function" in t ? t.function?.name : undefined));
  assert.ok(names.includes("agent.escalate_to_complex"));
});

test("selectRelevantTools keeps the escalation tool visible for any user text", async () => {
  const { getFastLaneTools, selectRelevantTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  for (const userText of ["2分钟后提醒我睡觉", "在吗", "今天天气怎么样", "帮我搜下新闻"]) {
    const selected = selectRelevantTools(userText, getFastLaneTools(), {
      minTools: 4,
      maxTools: 15,
      includeAlwaysIncluded: true,
    });
    const names = selected.map((t) => ("function" in t ? t.function?.name : undefined));
    assert.ok(
      names.includes("agent.escalate_to_complex"),
      `escalate tool must survive contextual selection for: ${userText}`,
    );
  }
});

test("isEscalationSignal detects the sentinel and ignores normal replies", async () => {
  const { isEscalationSignal, ESCALATION_SENTINEL } = await import(
    "../src/tools/escalation-tool.js"
  );
  assert.equal(isEscalationSignal(ESCALATION_SENTINEL), true);
  assert.equal(isEscalationSignal("好的，2分钟后叫你睡觉哦"), false);
  assert.equal(isEscalationSignal(""), false);
  assert.equal(isEscalationSignal(undefined), false);
});
