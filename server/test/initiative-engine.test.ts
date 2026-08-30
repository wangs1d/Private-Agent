// InitiativeEngine（LLM 主动性决策引擎）单测：
// 正常决策解析、JSON 容错（围栏/前后缀）、非法输出静默降级、
// act 无行动计划降级 advise、从未交互防御、归一化截断。
import assert from "node:assert/strict";
import test from "node:test";

import { InitiativeEngine, type LlmCompleteFn } from "../src/proactivity/initiative-engine.js";

const ACTOR = "actor-1";
const BASE_INPUT = {
  actorId: ACTOR,
  observations: [
    {
      actorId: ACTOR,
      type: "rhythm_overwork",
      content: "过劳信号：连续工作 3.5h",
      salience: "high" as const,
      observedAt: Date.now(),
    },
  ],
  lastInteractionAt: Date.now() - 10 * 60 * 1000,
};

function engineWith(reply: string): InitiativeEngine {
  const fn: LlmCompleteFn = async () => reply;
  return new InitiativeEngine(fn);
}

test("isEnabled：未注入 llmComplete 时禁用", () => {
  assert.equal(new InitiativeEngine(null).isEnabled(), false);
  assert.equal(new InitiativeEngine(async () => "").isEnabled(), true);
});

test("未注入 LLM：evaluate 恒 null（静默只用快路径）", async () => {
  const engine = new InitiativeEngine(null);
  assert.equal(await engine.evaluate(BASE_INPUT), null);
});

test("正常 speak 决策解析", async () => {
  const engine = engineWith(
    JSON.stringify({
      mode: "speak",
      kind: "schedule_care",
      importance: "medium",
      rationale: "用户连续加班，值得主动关怀",
      messageHint: "像朋友一样心疼一句，提醒早点休息",
      actions: [],
    }),
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.mode, "speak");
  assert.equal(d.kind, "schedule_care");
  assert.equal(d.importance, "medium");
  assert.equal(d.actions.length, 0);
});

test("act 决策：行动计划透传（含 args）", async () => {
  const engine = engineWith(
    JSON.stringify({
      mode: "act",
      kind: "schedule_care",
      importance: "high",
      rationale: "排好休息日程并放轻音乐",
      messageHint: "做完轻描淡写提一句",
      actions: [
        { tool: "media.search", args: { query: "轻音乐", limit: 3 } },
        { tool: "media.play", args: {} },
      ],
    }),
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.mode, "act");
  assert.equal(d.actions.length, 2);
  assert.equal(d.actions[0].tool, "media.search");
  assert.deepEqual(d.actions[0].args, { query: "轻音乐", limit: 3 });
});

test("act 无行动计划：降级 advise（有 messageHint）", async () => {
  const engine = engineWith(
    JSON.stringify({
      mode: "act",
      kind: "schedule_care",
      importance: "medium",
      rationale: "想帮忙但没给工具计划",
      messageHint: "建议用户早点休息",
      actions: [],
    }),
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.mode, "advise");
  assert.equal(d.actions.length, 0);
});

test("act 无行动计划且无话术：降级 none", async () => {
  const engine = engineWith(
    JSON.stringify({
      mode: "act",
      kind: "schedule_care",
      importance: "medium",
      rationale: "想帮忙但没给工具计划",
      messageHint: "",
      actions: [],
    }),
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.mode, "none");
});

test("markdown 围栏包裹的 JSON 仍可解析", async () => {
  const engine = engineWith(
    "```json\n" +
      JSON.stringify({ mode: "advise", kind: "info_prep", importance: "low", rationale: "先记着", messageHint: "下次聊到时带出", actions: [] }) +
      "\n```",
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.mode, "advise");
  assert.equal(d.kind, "info_prep");
});

test("前后有杂文的 JSON 仍可解析", async () => {
  const engine = engineWith(
    `好的，我的判断如下：\n${JSON.stringify({ mode: "none", kind: "general", importance: "low", rationale: "观察平淡", messageHint: "", actions: [] })}\n以上。`,
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.mode, "none");
});

test("非法 JSON：返回 null（静默不主动）", async () => {
  const engine = engineWith("这不是 JSON");
  assert.equal(await engine.evaluate(BASE_INPUT), null);
});

test("LLM 抛异常：返回 null 不抛出", async () => {
  const fn: LlmCompleteFn = async () => {
    throw new Error("402 Insufficient Balance");
  };
  const engine = new InitiativeEngine(fn);
  assert.equal(await engine.evaluate(BASE_INPUT), null);
});

test("mode 非法：返回 null", async () => {
  const engine = engineWith(
    JSON.stringify({ mode: "do_everything", kind: "x", importance: "high", rationale: "", messageHint: "", actions: [] }),
  );
  assert.equal(await engine.evaluate(BASE_INPUT), null);
});

test("从未交互（lastInteractionAt=null）：即使 LLM 说主动也强制 null（防御越权）", async () => {
  const engine = engineWith(
    JSON.stringify({ mode: "speak", kind: "cold_start", importance: "high", rationale: "想主动", messageHint: "你好", actions: [] }),
  );
  assert.equal(await engine.evaluate({ ...BASE_INPUT, lastInteractionAt: null }), null);
});

test("归一化：kind 缺省 general、importance 非法归 medium、超长截断", async () => {
  const engine = engineWith(
    JSON.stringify({
      mode: "speak",
      importance: "ultra",
      rationale: "x".repeat(500),
      messageHint: "y".repeat(500),
      actions: [
        { tool: "t" },
        { tool: "" },
        "junk",
        null,
        { tool: "u" },
        { tool: "v" }, // 第 6 项起被步数上限截断
      ],
    }),
  );
  const d = await engine.evaluate(BASE_INPUT);
  assert.ok(d);
  assert.equal(d.kind, "general");
  assert.equal(d.importance, "medium");
  assert.equal(d.rationale.length, 200);
  assert.equal(d.messageHint.length, 300);
  // 空 tool 名与非法项被滤掉；步数上限 5（第 5 项 {tool:"u"} 是最后一个合法项）
  assert.equal(d.actions.length, 2);
  assert.deepEqual(d.actions[0], { tool: "t", args: {} });
  assert.deepEqual(d.actions[1], { tool: "u", args: {} });
});

// ── prompt 压缩（省 token 不降质量） ─────────────────

test("prompt 压缩：工具数限 18、长描述截断、背景观察只留最近 6 条", async () => {
  let prompt = "";
  const fn: LlmCompleteFn = async (p) => {
    prompt = p;
    return JSON.stringify({ mode: "none", kind: "general", importance: "low", rationale: "", messageHint: "", actions: [] });
  };
  const engine = new InitiativeEngine(fn);
  await engine.evaluate({
    ...BASE_INPUT,
    recentContext: Array.from({ length: 10 }, (_, i) => ({
      actorId: ACTOR,
      type: "conversation_turn",
      content: `背景观察${i}`,
      salience: "low" as const,
      observedAt: Date.now(),
    })),
    availableTools: [
      ...Array.from({ length: 17 }, (_, i) => ({ name: `tool_${i}`, description: `短描述${i}` })),
      { name: "long_desc", description: "很长的描述".repeat(50) }, // 300 字符长描述
      { name: "overflow", description: "第 19 个工具" }, // 超出 18 上限
    ],
  });

  // 工具数上限 18：前 17 + long_desc 进 prompt，overflow 不进
  assert.ok(prompt.includes("- tool_0："));
  assert.ok(prompt.includes("- long_desc："));
  assert.ok(!prompt.includes("overflow"));
  // 长描述截断：80 字符 + 省略号（行前缀 12 字符 → 行长 ≤ 95）
  const longLine = prompt.split("\n").find((l) => l.startsWith("- long_desc："));
  assert.ok(longLine);
  assert.ok(longLine.length <= 95);
  // 背景观察只保留最近 6 条（4-9），更早的不进 prompt
  assert.ok(!prompt.includes("背景观察3"));
  assert.ok(prompt.includes("背景观察9"));
});
