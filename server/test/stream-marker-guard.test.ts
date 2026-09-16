import test from "node:test";
import assert from "node:assert/strict";

import { createStreamMarkerGuard } from "../src/utils/stream-marker-guard.js";

/**
 * 流式标记防泄漏 guard 单测：L2 激活后模型会在正文输出展示形式标记，
 * 流式 chunk 出口必须保证标记/卡片 JSON 不闪现在用户打字机气泡上。
 */

test("整行 RENDER_HINT 标记被扣下，不透出", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("[RENDER_HINT:structured]\n## 标题\n正文内容。");
  assert.ok(!out.includes("RENDER_HINT"));
  assert.ok(out.includes("## 标题"));
  assert.ok(out.includes("正文内容。"));
});

test("跨 chunk 断裂的标记行被扣住，补全后仍不透出", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("好的，安排如下：\n[RENDER_HI");
  const b = g.feed("NT:structured]\n第一步先备份。");
  assert.ok(!a.includes("[RENDER_HI"), `chunk1 泄漏：${a}`);
  assert.ok(!b.includes("RENDER_HINT"), `chunk2 泄漏：${b}`);
  assert.ok(b.includes("第一步先备份。"));
});

test("卡片 JSON 块整体丢弃（含跨 chunk 断裂）", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("结论在卡片里：\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"steps\",");
  const b = g.feed("\"title\":\"步骤\",\"items\":[{\"type\":\"num\",\"text\":\"1\"}]}\n[AGENT_RESULT_CARD_END]\n\n需要调整吗？");
  const c = g.flush();
  const all = a + b + c;
  assert.ok(!all.includes("cardType"), `泄漏卡片 JSON：${all}`);
  assert.ok(!all.includes("AGENT_RESULT_CARD"), `泄漏标记：${all}`);
  assert.ok(all.includes("结论在卡片里"));
  assert.ok(all.includes("需要调整吗？"));
});

test("未闭合的卡片块在流结束时全部丢弃", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("看卡：\n[AGENT_RESULT_CARD_START]\n{\"broken\": tru");
  const rest = g.flush();
  const all = a + rest;
  assert.ok(!all.includes("broken"), `半截 JSON 泄漏：${all}`);
  assert.ok(!all.includes("AGENT_RESULT_CARD_START"));
});

test("普通方括号文本不被误杀", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("参考 [1] 和 [2] 的说明，另见[链接](https://example.com)。\n完");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(all.includes("参考 [1] 和 [2] 的说明"));
  assert.ok(all.includes("另见[链接](https://example.com)。"));
});

test("行内嵌标记 token 被剥离，正文保留", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("开头 [RENDER_HINT:brief] 这是正文。");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(!all.includes("RENDER_HINT"), `行内标记泄漏：${all}`);
  assert.ok(all.includes("开头"));
  assert.ok(all.includes("这是正文。"));
});

test("纯正常流式文本零损失", () => {
  const g = createStreamMarkerGuard();
  const chunks = ["你", "好呀", "，今天天气", "不错。\n", "适合出门。"];
  let all = "";
  for (const c of chunks) all += g.feed(c);
  all += g.flush();
  assert.equal(all.replace(/\n/g, ""), "你好呀，今天天气不错。适合出门。");
});
