/**
 * 联网能力优化集成测试（国内可用方案）
 *
 * 验证：
 *   1. @mozilla/readability（主提取器，替换正则 htmlToText）
 *   2. 国内官方媒体 RSS（中国新闻网、人民网，实时性提升）
 *   3. 对比新旧方案在 fetch_web 和 search_news 场景的效果
 *
 * 运行：npx tsx scripts/test-web-enhancements.ts
 */

import { fetchWebPageEnhanced, extractWithReadability } from "../src/services/web-fetch-enhancer.js";
import {
  fetchDomesticNews,
  fetchDomesticOfficialNews,
  fetchDomesticTechNews,
} from "../src/services/domestic-web-providers.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; PrivateAIAgent/1.0; +https://example.local/agent)";

// 估算 token：粗略按 1 token ≈ 4 字符（中英文混合）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fmtMs(ms: number): string {
  return `${ms}ms`;
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

async function testReadabilityOffline() {
  console.log("\n========== 测试 1：@mozilla/readability 离线提取（纯本地） ==========\n");

  // 构造一个典型新闻页 HTML
  const sampleHtml = `<!DOCTYPE html>
<html><head><title>测试新闻标题 - 示例站点</title></head>
<body>
  <nav><ul><li><a href="/">首页</a></li><li><a href="/news">新闻</a></li></ul></nav>
  <header><div class="banner">广告位 占位文字</div></header>
  <main>
    <article>
      <h1>测试新闻标题</h1>
      <time>2026-07-13</time>
      <p>这是正文第一段。这是测试 @mozilla/readability 提取效果的内容。Readability 应该能智能识别这是正文并保留。</p>
      <p>第二段正文内容，包含一些详细信息。Readability 基于 Firefox 阅读模式内核，会自动去除导航、广告、侧边栏等噪声。</p>
      <p>第三段内容，进一步验证提取完整性。这里应该被保留。token 消耗应显著低于正则解析方案。</p>
      <p>第四段：Readability 还会自动识别文章的主要结构，去除非正文区域。这是正则方案难以做到的。</p>
    </article>
  </main>
  <aside class="sidebar">相关推荐：其他文章链接列表</aside>
  <footer>版权所有 © 2026 示例站点 联系我们 隐私政策</footer>
  <script>console.log("should be removed");</script>
  <style>.ad { color: red; }</style>
</body></html>`;

  const start = Date.now();
  const result = extractWithReadability(sampleHtml, "https://example.com/test");
  const elapsed = Date.now() - start;

  console.log(`  耗时: ${fmtMs(elapsed)}（纯本地，无网络）`);
  console.log(`  标题: ${result.title}`);
  console.log(`  内容长度: ${result.text.length} 字符`);
  console.log(`  估算 token: ${estimateTokens(result.text)} tokens`);
  console.log(`  内容:`);
  console.log(result.text.split("\n").map((l) => `    ${l}`).join("\n"));

  console.log("\n  --- 验证提取质量 ---");
  const checks = [
    { label: "包含「正文第一段」", expected: true, actual: result.text.includes("正文第一段") },
    { label: "包含「第二段正文内容」", expected: true, actual: result.text.includes("第二段正文内容") },
    { label: "包含「Firefox 阅读模式」", expected: true, actual: result.text.includes("Firefox 阅读模式") },
    { label: "排除「广告位」(导航噪声)", expected: false, actual: result.text.includes("广告位") },
    { label: "排除「相关推荐」(侧边栏)", expected: false, actual: result.text.includes("相关推荐") },
    { label: "排除「版权所有」(页脚)", expected: false, actual: result.text.includes("版权所有") },
    { label: "排除「should be removed」(脚本)", expected: false, actual: result.text.includes("should be removed") },
    { label: "排除「联系我们」(页脚链接)", expected: false, actual: result.text.includes("联系我们") },
  ];
  let passed = 0;
  for (const c of checks) {
    const ok = c.actual === c.expected;
    if (ok) passed++;
    console.log(`    ${ok ? "✓" : "✗"} ${c.label}：${c.actual}`);
  }
  console.log(`\n  通过率: ${passed}/${checks.length}`);
}

async function testReadabilityRealWorld() {
  console.log("\n========== 测试 2：@mozilla/readability 真实网页提取 ==========\n");

  // 用国内可访问的网站测试
  const testUrls = [
    "https://www.ithome.com/0/824/139.htm", // IT之家文章
    "https://36kr.com/p/2606852947979655", // 36氪文章
    "https://www.chinanews.com.cn/gn/2026/07-13/10658570.shtml", // 中新网文章
  ];

  for (const url of testUrls) {
    console.log(`▶ URL: ${url}`);
    const start = Date.now();
    try {
      const result = await fetchWebPageEnhanced(
        url,
        { userAgent: USER_AGENT, timeoutMs: 15_000, enableJina: false },
        (html) => html, // 兜底
      );
      const elapsed = Date.now() - start;
      console.log(`  耗时: ${fmtMs(elapsed)}`);
      console.log(`  提取器: ${result.extractor}`);
      console.log(`  标题: ${truncate(result.title, 80)}`);
      console.log(`  内容长度: ${result.text.length} 字符`);
      console.log(`  估算 token: ${estimateTokens(result.text)} tokens`);
      console.log(`  内容预览: ${truncate(result.text.replace(/\s+/g, " "), 200)}`);
      console.log("");
    } catch (e: any) {
      console.log(`  失败: ${e.message}\n`);
    }
  }
}

async function testOfficialNewsRss() {
  console.log("\n========== 测试 3：国内官方媒体 RSS（实时新闻源） ==========\n");

  const queries = [
    "人工智能",
    "科技",
    "经济",
  ];

  for (const query of queries) {
    console.log(`▶ 查询: "${query}"`);
    const start = Date.now();
    try {
      const items = await fetchDomesticOfficialNews(query, 5, {
        userAgent: USER_AGENT,
        timeoutMs: 10_000,
      });
      const elapsed = Date.now() - start;
      console.log(`  耗时: ${fmtMs(elapsed)}`);
      console.log(`  返回 ${items.length} 条结果`);
      items.slice(0, 3).forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.source}] ${truncate(item.title, 60)}`);
        console.log(`     时间: ${item.publishedAt || "未知"}`);
        console.log(`     URL: ${item.url}`);
      });
      console.log("");
    } catch (e: any) {
      console.log(`  失败: ${e.message}\n`);
    }
  }
}

async function testCompareOldVsNew() {
  console.log("\n========== 测试 4：对比新旧搜索方案（实时性 + 覆盖面） ==========\n");

  const query = "人工智能 最新新闻";
  console.log(`▶ 查询: "${query}"\n`);

  console.log("  [A] 原方案（仅必应 RSS + 科技 RSS）：");
  const startA = Date.now();
  // 模拟原方案：只用必应 + 科技 RSS
  const { searchBingChina } = await import("../src/services/domestic-web-providers.js");
  const [bingOnly, techOnly] = await Promise.all([
    searchBingChina(query, 6, { userAgent: USER_AGENT }),
    fetchDomesticTechNews(query, 6, { userAgent: USER_AGENT }),
  ]);
  const oldItems = [...bingOnly, ...techOnly];
  const elapsedA = Date.now() - startA;
  console.log(`    耗时: ${fmtMs(elapsedA)}，返回 ${oldItems.length} 条`);
  oldItems.slice(0, 3).forEach((item, i) => {
    console.log(`    ${i + 1}. [${item.source}] ${truncate(item.title, 60)}`);
    console.log(`       时间: ${item.publishedAt || "未知"}`);
  });

  console.log("\n  [B] 新方案（必应 + 科技 RSS + 官方媒体 RSS）：");
  const startB = Date.now();
  const newItems = await fetchDomesticNews(query, 10, { userAgent: USER_AGENT });
  const elapsedB = Date.now() - startB;
  console.log(`    耗时: ${fmtMs(elapsedB)}（并行），返回 ${newItems.length} 条`);
  newItems.slice(0, 5).forEach((item, i) => {
    console.log(`    ${i + 1}. [${item.source}] ${truncate(item.title, 60)}`);
    console.log(`       时间: ${item.publishedAt || "未知"}`);
  });

  // 实时性对比
  console.log("\n  [实时性对比]");
  const now = Date.now();
  const analyzeFreshness = (items: typeof oldItems, label: string) => {
    if (items.length === 0) {
      console.log(`    ${label}: 无结果`);
      return;
    }
    const timestamps = items
      .map((i) => (i.publishedAt ? new Date(i.publishedAt).getTime() : 0))
      .filter((t) => t > 0)
      .sort((a, b) => b - a);
    if (timestamps.length === 0) {
      console.log(`    ${label}: 无有效时间戳`);
      return;
    }
    const latest = timestamps[0];
    const ageMin = Math.round((now - latest) / 60000);
    const avgAge = Math.round(
      timestamps.slice(0, 5).reduce((a, b) => a + (now - b), 0) / Math.min(5, timestamps.length) / 60000,
    );
    console.log(`    ${label}: 最新 ${ageMin} 分钟前，前5条平均 ${avgAge} 分钟前`);
  };
  analyzeFreshness(oldItems, "原方案");
  analyzeFreshness(newItems, "新方案");

  // 来源覆盖对比
  console.log("\n  [来源覆盖对比]");
  const countSources = (items: typeof oldItems) => {
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.source] = (counts[i.source] || 0) + 1;
    return counts;
  };
  console.log(`    原方案: ${JSON.stringify(countSources(oldItems))}`);
  console.log(`    新方案: ${JSON.stringify(countSources(newItems))}`);
}

async function main() {
  console.log("Private-Agent 联网能力优化集成测试（国内可用方案）");
  console.log("====================================================");
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`JINA_READER_ENABLED: ${process.env.JINA_READER_ENABLED ?? "未设置（默认禁用，国内不可达）"}`);
  console.log(`方案: @mozilla/readability（主提取器）+ 国内官方媒体 RSS（实时新闻源）`);

  await testReadabilityOffline();
  await testReadabilityRealWorld();
  await testOfficialNewsRss();
  await testCompareOldVsNew();

  console.log("\n========== 测试完成 ==========\n");
}

main().catch((e) => {
  console.error("测试运行失败:", e);
  process.exit(1);
});
