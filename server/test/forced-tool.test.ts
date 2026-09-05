import test from "node:test";
import assert from "node:assert/strict";

import { resolveForcedToolChoice } from "../src/gateway/forced-tool.js";

function fnTool(name: string) {
  return { type: "function" as const, function: { name } };
}

test("显式电话请求强制 phone.call_user（工具名以注册名为准）", () => {
  const choice = resolveForcedToolChoice(
    "帮我打个电话提醒我三点开会",
    [fnTool("phone.call_user"), fnTool("search_web")],
  );
  assert.deepEqual(choice, { type: "function", function: { name: "phone.call_user" } });
});

test("电话未在工具列表时电话分支不强制", () => {
  const choice = resolveForcedToolChoice("帮我打个电话", [fnTool("search_web")]);
  assert.equal(choice, "auto");
});

test("解释性提问不触发电话强制路由", () => {
  const choice = resolveForcedToolChoice(
    "电话是什么时候发明的",
    [fnTool("phone.call_user")],
  );
  assert.equal(choice, "auto");
});

test("直接时间问题强制 clock.get_current_time（注册名带点号）", () => {
  const choice = resolveForcedToolChoice(
    "现在几点了",
    [fnTool("clock.get_current_time")],
  );
  assert.deepEqual(choice, { type: "function", function: { name: "clock.get_current_time" } });
});

test("Fast 模式跳过时间强制（system prompt 已注入 currentTime）", () => {
  const choice = resolveForcedToolChoice(
    "现在几点了",
    [fnTool("clock.get_current_time")],
    true,
  );
  assert.equal(choice, "auto");
});

test("时效性查询不再强制 search_web（话题词强制已删，工具需求由语义路由 + 出口自检承担）", () => {
  const choice = resolveForcedToolChoice(
    "帮我查查最新的新闻",
    [fnTool("search_web")],
  );
  assert.equal(choice, "auto");
});
