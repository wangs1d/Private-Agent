import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

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

// ── escalate 哨兵退役（2026-09-05 双面架构）回归 ──
// 旧契约：fastLane 每轮必带 agent.escalate_to_complex，模型调用后返回哨兵、
// agent-core 删线程整轮重放 complex。新契约：对话面零工具、任务面全量工具，
// 轨道内出口自检承担纠错，哨兵机制整体删除。

test("fast lane toolset no longer carries the escalation escape hatch", async () => {
  const { getFastLaneTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const names = getFastLaneTools().map((t) => ("function" in t ? t.function?.name : undefined));
  assert.equal(names.includes("agent.escalate_to_complex"), false);
});

test("selectRelevantTools never surfaces the retired escalation tool", async () => {
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
    assert.equal(
      names.includes("agent.escalate_to_complex"),
      false,
      `retired tool must not resurface for: ${userText}`,
    );
  }
});
