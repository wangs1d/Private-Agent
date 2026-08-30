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
