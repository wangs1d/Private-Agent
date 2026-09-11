import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeNormalizedStream,
  createStreamDsmlSanitizer,
  extractDsmlToolCalls,
  stripDsmlToolCallMarkup,
  ToolIntentWithoutToolsError,
  type NormalChatChunk,
} from "../src/external-model/stream-chat-helpers.js";

const dsmlFetchWeb =
  "I will fetch the weather page.\n\n" +
  '< | | DSML | | tool_calls>\n' +
  '< | | DSML | | invoke name="fetch_web">\n' +
  '< | | DSML | | parameter name="url" string="true">https://www.weather.com.cn/weather/101010100.shtml</ | | DSML | | parameter>\n' +
  '</ | | DSML | | invoke>\n' +
  '</ | | DSML | | tool_calls>';

// 2026-09-11 01:34 用户截图原文：外层是 calls（非 tool_calls），invoke name="tool_call"，
// 真实工具名在 name 参数里（延迟目录桥 tool_call 的调用形态）。
const dsmlCallsVariant =
  '< | | DSML | | calls>\n' +
  '< | | DSML | | invoke name="tool_call">\n' +
  '< | | DSML | | parameter name="arguments" string="false">{"mode": "full"}</ | | DSML | | parameter>\n' +
  '< | | DSML | | parameter name="name" string="true">desktop.visual.screenshot</ | | DSML | | parameter>\n' +
  '</ | | DSML | | invoke>\n' +
  '</ | | DSML | | calls>';

test("extractDsmlToolCalls parses spaced Kimi DSML tool call markup", () => {
  const calls = extractDsmlToolCalls(dsmlFetchWeb);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "fetch_web");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    url: "https://www.weather.com.cn/weather/101010100.shtml",
  });
});

test("extractDsmlToolCalls parses calls-wrapper bridge variant (2026-09-11 leak)", () => {
  const calls = extractDsmlToolCalls(dsmlCallsVariant);

  assert.equal(calls.length, 1);
  // 桥接形态：invoke name="tool_call"，真实工具名在 name 参数里
  assert.equal(calls[0]?.name, "tool_call");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    arguments: '{"mode": "full"}',
    name: "desktop.visual.screenshot",
  });
});

test("stripDsmlToolCallMarkup removes spaced DSML blocks from visible text", () => {
  const cleaned = stripDsmlToolCallMarkup(dsmlFetchWeb);

  assert.equal(cleaned.includes("DSML"), false);
  assert.equal(cleaned.includes("fetch_web"), false);
  assert.equal(cleaned, "I will fetch the weather page.");
});

test("stripDsmlToolCallMarkup removes calls-wrapper variant completely", () => {
  const cleaned = stripDsmlToolCallMarkup(dsmlCallsVariant);

  assert.equal(cleaned, "");
});

test("consumeNormalizedStream turns DSML content into real tool calls", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { content: dsmlFetchWeb, finishReason: "stop" };
  }

  const result = await consumeNormalizedStream(source());

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content, "I will fetch the weather page.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "fetch_web");
});

test("consumeNormalizedStream recovers bridge calls from calls-wrapper variant", async () => {
  async function* source(): AsyncIterable<NormalChatChunk> {
    yield { content: dsmlCallsVariant, finishReason: "stop" };
  }

  const result = await consumeNormalizedStream(source());

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.content, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "tool_call");
});

test("consumeNormalizedStream never streams DSML markup through onContentDelta", async () => {
  // 端到端不变量（2026-09-11 根修）：正文含 DSML 协议块时，流式 delta 不得出现
  // 任何协议标记/协议参数，而流末提取仍能拿到完整工具调用。
  async function* source(): AsyncIterable<NormalChatChunk> {
    // 按小切片喂入，模拟真实逐 token 流式（标记必然跨 chunk 断开）
    for (const piece of dsmlCallsVariant.match(/[\s\S]{1,7}/g) ?? []) {
      yield { content: piece, finishReason: null };
    }
    yield { content: "", finishReason: "stop" };
  }

  const deltas: string[] = [];
  const result = await consumeNormalizedStream(source(), {
    onContentDelta: (d) => deltas.push(d),
  });

  const streamed = deltas.join("");
  assert.equal(streamed.includes("DSML"), false, `delta 泄漏协议标记: ${streamed}`);
  assert.equal(
    streamed.includes("desktop.visual.screenshot"),
    false,
    `delta 泄漏工具名: ${streamed}`,
  );
  assert.equal(result.content.includes("DSML"), false);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.finishReason, "tool_calls");
});

test("createStreamDsmlSanitizer keeps prose around a closed DSML block", () => {
  const guard = createStreamDsmlSanitizer();
  const before = "好的，我先截个屏看看当前画面。";
  const after = "\n已经看到你的桌面了，稍等。";

  const out =
    guard.feed(before) +
    guard.feed(dsmlCallsVariant) +
    guard.feed(after) +
    guard.flush();

  assert.equal(out.includes(before), true, `丢失块前正文: ${out}`);
  assert.equal(out.includes(after.trim()), true, `丢失块后正文: ${out}`);
  assert.equal(out.includes("DSML"), false);
  assert.equal(out.includes("desktop.visual.screenshot"), false);
});

test("createStreamDsmlSanitizer drops unclosed protocol block to end of stream", () => {
  const guard = createStreamDsmlSanitizer();
  const lead = "让我看看。";
  const out =
    guard.feed(lead) +
    guard.feed('< | | DSML | | invoke name="tool_call">\n') +
    guard.feed('< | | DSML | | parameter name="name" string="true">desktop.visual.screenshot');

  assert.equal(out, lead);
  // 未闭合块：flush 丢弃残段，不吐协议
  assert.equal(guard.flush(), "");
});

test("createStreamDsmlSanitizer handles fullwidth pipe variant", () => {
  const guard = createStreamDsmlSanitizer();
  const fullwidth =
    '<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="tool_call">' +
    '<｜｜DSML｜｜parameter name="name" string="true">desktop.visual.screenshot' +
    '</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>';

  const out = guard.feed(fullwidth) + guard.flush();

  assert.equal(out.includes("DSML"), false);
  assert.equal(out.includes("desktop.visual.screenshot"), false);
});

test("createStreamDsmlSanitizer passes comparison prose through", () => {
  const guard = createStreamDsmlSanitizer();
  const prose = "如果 a < b 且 x > y，输出 5 < 3 的结果。";

  const out = guard.feed(prose) + guard.flush();

  assert.equal(out, prose);
});

test("ToolIntentWithoutToolsError carries extracted calls for escalation", () => {
  const calls = extractDsmlToolCalls(dsmlCallsVariant);
  const err = new ToolIntentWithoutToolsError({
    providerId: "openai-compatible",
    model: "test-model",
    toolCalls: calls,
  });

  assert.equal(err.name, "ToolIntentWithoutToolsError");
  assert.equal(err.toolCalls.length, 1);
  assert.equal(err.message.includes("desktop"), false);
  assert.equal(err.message.includes("tool_call"), true);
});
