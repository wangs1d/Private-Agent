import assert from "node:assert/strict";

import { compactToolOutputForLlm } from "../src/tokenjuice/compactor.js";
import { getToolResultProcessor } from "../src/services/tool-result-processor.js";

const processor = getToolResultProcessor();

/**
 * 真实事故复现：用户搜"刘浩存"，前端看到「`{...}... [truncated 870 chars]`」。
 *
 * 根因链路：
 *   1. compactor 把 search_web 工具结果（~4870 字符 JSON）按 char 硬切到 4000 字符，
 *      末尾挂「[truncated 870 chars]」标记。
 *   2. 硬切把 `"url":"https://movie.douban.com/..."` 切到只剩
 *      `"url":"movie.douban.com/..."` —— `https://` 前缀被吃掉。
 *   3. LLM 把这段破损 JSON 原样复制到 reply.text。
 *   4. 后端 detectRawSearchResultJson 因 URL 缺 https:// 而校验失败，
 *      JSON 整段透出到前端。
 *
 * 本测试覆盖修复后的三层防线：
 *   - 第二层（detector 容错）：URL 缺 https:// 时自动补回，识别为搜索结果卡
 *   - 第三层（HTTP 路径 plainTextMode 守卫）：raw JSON 仍会被剥掉
 *   - 第一层（compactor 不破坏 JSON）：见 compactor 自己的测试
 */

console.log("[A] 破损 URL（https:// 前缀被 compactor 切掉）→ 仍应被识别为搜索结果卡");

// 真实事故样本：https:// 已被吃掉
const brokenUrlText = `{"items":[{"title":"想飞的女孩（豆瓣）","url":"movie.douban.com/dapp=1&dt_platform=com.douban.activity.wechat.friends","snippet":"想飞的女孩的剧情简介 · · · · 影片讲述了一对表姐妹二十余年的成长与救赎","source":"必应中国","publishedAt":"周五, 21 8月 2026 05:43:00 GMT"},{"title":"刘浩存百科","url":"baike.baidu.com/item/%E5%88%98%E6%B5%A9%E5%AD%98/55898568","snippet":"刘浩存（Haocun Liu），2000年5月20日出生于吉林省通化市辉南县","source":"必应中国","publishedAt":"2026-01-15"}],"provider":"必应中国","notes":[],"searchDateLocal":"2026-08-22","fetchedAt":"2026-08-22T10:00:00Z"}... [truncated 870 chars]`;

const outA = processor.processAssistantText(brokenUrlText, {
  userText: "刘浩存",
  toolName: "search_web",
});
assert.ok(
  outA.includes("[AGENT_RESULT_CARD_START]"),
  "破损 URL 也应被转为结构化卡片（容错后补 https://）",
);
assert.ok(outA.includes("https://movie.douban.com/"), "URL 应自动补回 https:// 前缀");
assert.ok(outA.includes("https://baike.baidu.com/"), "URL 应自动补回 https:// 前缀");
assert.ok(!outA.includes("[truncated 870 chars]"), "compactor 截断标记应被剥除");

console.log("[B] plainTextMode（HTTP 路径）下 raw JSON 仍要被清理，不能透出");

const outB = processor.processAssistantText(brokenUrlText, {
  userText: "刘浩存",
  toolName: "search_web",
  plainTextMode: true,
});
// plainTextMode 时：不再注入 [AGENT_RESULT_CARD_START] 标记（下游不解析），
// 但必须把破损 JSON 块剥掉，不能让 `{...}...` 透出。
assert.ok(!outB.includes('"items":[{'), "plainTextMode 也不允许 raw JSON 透出");
assert.ok(!outB.includes("[truncated"), "plainTextMode 也不允许 truncated 标记透出");

console.log("[C] 残缺 URL 不是域名（如只是 'foo bar'）→ 不应被错误补 https://");

const garbage = `{"items":[{"title":"A","url":"foo bar baz","snippet":"..."},{"title":"B","url":"hello world","snippet":"..."}]}`;
const outC = processor.processAssistantText(garbage, {
  userText: "x",
  toolName: "search_web",
});
// 含空白的非 URL 字符串既不是 https:// 也不是域名，应被丢弃，导致 validCount < 2
// 整个 JSON 不应被识别为搜索结果卡
assert.ok(
  !outC.includes("[AGENT_RESULT_CARD_START]"),
  "非域名的脏字符串不应被误判为搜索结果",
);

console.log("[D] 纯文本中提到 https://example.com → 不应被误判为 JSON 搜索结果");

const plain = "你可以访问 https://example.com 查看更多。";
const outD = processor.processAssistantText(plain, {
  userText: "示例",
  toolName: "search_web",
});
assert.ok(
  !outD.includes("[AGENT_RESULT_CARD_START]"),
  "普通文本中提到 URL 不应被误判为 JSON 搜索结果",
);

console.log("[E] 1.5 段：compactor 对 JSON 工具结果不应再做 char 截断");

// 模拟：search_web 工具结果是一个大 JSON 对象（>4000 字符）。
// 用"每条加很多重复 snippet"的方式让单个 JSON 自然撑大，结构仍然合法。
const bigItems = Array.from({ length: 30 }).map((_, i) => ({
  title: `Result ${i} - ${"x".repeat(40)}`,
  url: `https://example.com/article/${i}`,
  snippet: "description ".repeat(60),
  source: "bing-cn",
  publishedAt: "2026-08-22",
}));
const bigPayload = {
  provider: "bing-cn",
  searchDateLocal: "2026-08-22",
  fetchedAt: "2026-08-22T10:00:00Z",
  notes: [],
  items: bigItems,
};
const bigJson = JSON.stringify(bigPayload);
console.log(`    rawBytes=${Buffer.byteLength(bigJson, "utf8")} (期望 > 4000 触发压缩)`);

const compacted = await compactToolOutputForLlm({
  toolName: "search_web",
  ok: true,
  result: bigPayload,
  preferredMaxChars: 4000,
});
console.log(`    compactBytes=${compacted.compactBytes}, max=4000`);
// 关键不变量：compacted.content 必须仍然可被解析为合法 JSON，
// 不能以 `... [truncated N chars]` 结尾（char 截断破损 JSON 已被根因修复拦截）。
assert.ok(
  !/\.\.\.\s*\[truncated\s+\d+\s+chars\]\s*$/i.test(compacted.content),
  "compactor 对 JSON 工具结果不应输出 char 截断破损 JSON",
);
const reparsed = JSON.parse(compacted.content);
assert.ok(Array.isArray(reparsed.items) && reparsed.items.length > 0, "压缩后 JSON 仍可解析、items 数组非空");
console.log(
  `    compacted: ${compacted.content.slice(0, 200)}... [items=${reparsed.items.length}]`,
);

console.log("\n✅ 全部通过 — 即使 compactor 破坏了 JSON 工具结果，三层防线也能保证前端只看到结构化搜索结果卡。");
