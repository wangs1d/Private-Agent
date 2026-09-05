/**
 * [dispatch:...] 结构化派发标签（2026-09-05 前后台架构）测试。
 *
 * 契约：前台 1 次调用内嵌标签完成回复+派发；流式出口逐块剥离（含跨 chunk
 * 截断的标签头 hold），完整文本解析出派发请求，用户可见文本零标签残留。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { parseDispatchTags, stripDispatchTags, DispatchTagStreamFilter } = await import(
  "../src/agent/dispatch-tag.js"
);

test("解析：标准 JSON 标签（goal + 可选 note）", () => {
  const text = '在办了，稍等哈[dispatch:{"goal":"创建明天早上8点的起床提醒","note":"工作日"}]';
  const reqs = parseDispatchTags(text);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.goal, "创建明天早上8点的起床提醒");
  assert.equal(reqs[0]!.note, "工作日");
});

test("解析：容忍纯文本 goal 与多个标签", () => {
  const reqs = parseDispatchTags("这就去查[dispatch:查比特币价格]，照片也一并找[dispatch:{\"goal\":\"找几张景甜的照片\"}]");
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0]!.goal, "查比特币价格");
  assert.equal(reqs[1]!.goal, "找几张景甜的照片");
});

test("解析：上限截断 + 坏 JSON 跳过", () => {
  const three = '[dispatch:{"goal":"a"}][dispatch:{"goal":"b"}][dispatch:{"goal":"c"}]';
  assert.equal(parseDispatchTags(three).length, 3);
  const four = three + '[dispatch:{"goal":"d"}]';
  assert.equal(parseDispatchTags(four).length, 3, "超过 3 个应截断");
  assert.equal(parseDispatchTags("[dispatch:{broken json}]").length, 0, "坏 JSON 不派发");
});

test("剥离：最终文本零标签残留", () => {
  const text = '在办了[dispatch:{"goal":"a"}]，好的。';
  assert.equal(stripDispatchTags(text), "在办了，好的。");
  assert.equal(stripDispatchTags("没有标签的普通回复"), "没有标签的普通回复");
});

test("流式过滤器：完整标签单块到达 → 剥离", () => {
  const f = new DispatchTagStreamFilter();
  const out = f.feed('在办了[dispatch:{"goal":"a"}]好的') + f.flush();
  assert.equal(out, "在办了好的");
});

test("流式过滤器：标签跨 chunk 截断 → hold 后剥除，不泄漏", () => {
  const f = new DispatchTagStreamFilter();
  let out = "";
  out += f.feed("在办了[dis");
  assert.ok(!out.includes("dis"), "疑似标签头应 hold，不透出");
  out += f.feed('patch:{"goal":"a"}]好的');
  out += f.flush();
  assert.equal(out, "在办了好的");
});

test("流式过滤器：无标签文本零损耗透传", () => {
  const f = new DispatchTagStreamFilter();
  let out = f.feed("今天天气不错，") + f.feed("聊聊天。") + f.flush();
  assert.equal(out, "今天天气不错，聊聊天。");
});
