import assert from "node:assert/strict";

import { getToolResultProcessor } from "../src/services/tool-result-processor.js";

const processor = getToolResultProcessor();

console.log("[1] LLM 把 search_web 原始 JSON 复制到 reply.text → 期望被转成结构化卡片");

// 真实场景：搜索"刘浩存"时 LLM 吐出来的 reply.text
const dirtyText = `{"items":[{"title":"想飞的女孩（豆瓣）","url":"https://movie.douban.com/dapp=1&dt_platform=com.douban.activity.wechat.friends","snippet":"想飞的女孩的剧情简介 · · · · 影片讲述了一对表姐妹二十余年的成长与救赎：拼死逃离家庭的田陌（刘浩存 饰）走投无路","source":"必应中国","publishedAt":"周五, 21 8月 2026 05:43:00 GMT"},{"title":"刘浩存百科","url":"https://baike.baidu.com/item/%E5%88%98%E6%B5%A9%E5%AD%98/55898568","snippet":"刘浩存（Haocun Liu），2000年5月20日出生于吉林省通化市辉南县，毕业于北京舞蹈学院·中国民族民间舞系，中国内地女演员。","source":"必应中国","publishedAt":"2026-01-15"}],"provider":"必应中国","notes":[],"searchDateLocal":"2026-08-22","fetchedAt":"2026-08-22T10:00:00Z"}... [truncated 870 chars]`;

const out1 = processor.processAssistantText(dirtyText, {
  userText: "刘浩存",
  toolName: "search_web",
});

console.log("    has [AGENT_RESULT_CARD_START]?", out1.includes("[AGENT_RESULT_CARD_START]"));
console.log("    still contains raw '\"items\":[{?", out1.includes('"items":[{'));
assert.ok(out1.includes("[AGENT_RESULT_CARD_START]"), "应当被转换为结构化卡片");
// 检查"原始 LLM 复述"是否被剥除：原始 JSON 里 items 数组元素是 {title,url,snippet,source,publishedAt}
// 转换后的卡片里 items 元素是 {type,text,url,source}，不含 publishedAt 字段。
assert.ok(!out1.includes('"publishedAt"'), "原始 JSON 的 publishedAt 字段应被剥除（已重组为卡片）");
assert.ok(out1.includes("想飞的女孩（豆瓣）"), "搜索结果标题应保留");
assert.ok(out1.includes("刘浩存百科"), "搜索结果标题应保留");
assert.ok(out1.includes("movie.douban.com"), "URL 应保留");
assert.ok(out1.includes("baike.baidu.com"), "URL 应保留");
assert.ok(out1.includes("必应中国"), "来源应保留");
assert.ok(out1.includes('"cardType":"search_result"'), "cardType=search_result");

console.log("[2] LLM 在 JSON 前后还写了引导句 → 引导句应保留在卡片前");

const withLead = `以下是搜索结果：\n${dirtyText}\n希望对您有帮助。`;
const out2 = processor.processAssistantText(withLead, {
  userText: "刘浩存",
  toolName: "search_web",
});
assert.ok(out2.includes("[AGENT_RESULT_CARD_START]"), "有引导句时仍应转卡片");
assert.ok(!out2.includes('"publishedAt"'), "原始 JSON 的 publishedAt 应被剥除");
assert.ok(!out2.includes("以下是搜索结果："), "纯公告引导句应被丢弃（避免与卡片标题重复）");
assert.ok(!out2.includes("希望对您有帮助"), "短收尾句应被丢弃");

console.log("[3] 普通自然段回复 → 不应被误判为 JSON 搜索结果");

const normalText = `好的，我已经帮你查到了相关信息。刘浩存是一位中国内地女演员，2000年5月20日出生于吉林省通化市辉南县。她毕业于北京舞蹈学院，主修中国民族民间舞系。\n\n近期她的代表作品包括《想飞的女孩》等影片。`;
const out3 = processor.processAssistantText(normalText, {
  userText: "刘浩存",
  toolName: "search_web",
});
assert.ok(!out3.includes("[AGENT_RESULT_CARD_START]"), "普通自然段不应被转换为卡片");

console.log("[4] 非搜索类工具 + 偶发 JSON → 不应被误判");

const nonSearchJson = `好的，工具已执行完毕。结果如下：{"items":[{"title":"测试","url":"https://test.com","snippet":"..."}]} 这是给用户的回复。`;
const out4 = processor.processAssistantText(nonSearchJson, {
  userText: "测试",
  toolName: "weather.get_local", // 非搜索类工具
});
assert.ok(!out4.includes("[AGENT_RESULT_CARD_START]"), "非搜索类工具的 JSON 不应被误判为搜索结果卡");

console.log("[5] items 数组中只有 1 条有效数据 → 不应被误判");

const singleItem = `{"items":[{"title":"孤例","url":"https://test.com","snippet":"...","source":"x"}],"provider":"x"}`;
const out5 = processor.processAssistantText(singleItem, {
  userText: "测试",
  toolName: "search_web",
});
assert.ok(!out5.includes("[AGENT_RESULT_CARD_START]"), "items 只有 1 条时不应被转为卡片");

console.log("\n✅ 全部通过 — LLM 即使把 tool result 原始 JSON 复制到回复里，前端也会拿到结构化搜索结果卡而不是脏 JSON。");
