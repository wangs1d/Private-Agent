import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeNormalizedStream,
  extractDsmlToolCalls,
  stripDsmlToolCallMarkup,
  type NormalChatChunk,
} from "../src/external-model/stream-chat-helpers.js";

const dsmlFetchWeb =
  "I will fetch the weather page.\n\n" +
  '< | | DSML | | tool_calls>\n' +
  '< | | DSML | | invoke name="fetch_web">\n' +
  '< | | DSML | | parameter name="url" string="true">https://www.weather.com.cn/weather/101010100.shtml</ | | DSML | | parameter>\n' +
  '</ | | DSML | | invoke>\n' +
  '</ | | DSML | | tool_calls>';

test("extractDsmlToolCalls parses spaced Kimi DSML tool call markup", () => {
  const calls = extractDsmlToolCalls(dsmlFetchWeb);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "fetch_web");
  assert.deepEqual(JSON.parse(calls[0]?.argumentsChunk ?? "{}"), {
    url: "https://www.weather.com.cn/weather/101010100.shtml",
  });
});

test("stripDsmlToolCallMarkup removes spaced DSML blocks from visible text", () => {
  const cleaned = stripDsmlToolCallMarkup(dsmlFetchWeb);

  assert.equal(cleaned.includes("DSML"), false);
  assert.equal(cleaned.includes("fetch_web"), false);
  assert.equal(cleaned, "I will fetch the weather page.");
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
