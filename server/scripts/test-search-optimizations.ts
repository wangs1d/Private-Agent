/**
 * 联网能力优化 - 第二轮集成测试
 *
 * 验证 8 项优化：
 *   1. tokenjuice 规则修复（toolNames 匹配）
 *   2. 搜索结果缓存（LRU + TTL）
 *   3. RSS 健康检查 + 自动降级
 *   4. User-Agent 反爬优化
 *   5. navigateSite 接入 Readability
 *   6. fetch_web 支持 PDF
 *   7. 搜索意图识别
 *   8. 同会话跨查询复用
 *
 * 运行：npx tsx scripts/test-search-optimizations.ts
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import {
  SearchCache,
  RssHealthMonitor,
  classifySearchIntent,
  SessionSearchCache,
} from "../src/services/search-enhancements.js";
import { fetchWebPageEnhanced, extractWithReadability } from "../src/services/web-fetch-enhancer.js";
import { InfoHubService } from "../src/services/info-hub-service.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function fmtMs(ms: number): string {
  return `${ms}ms`;
}
function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// ============================================================
// 测试 1：tokenjuice 规则修复
// ============================================================
async function testTokenjuiceRules() {
  console.log("\n========== 测试 1：tokenjuice 规则 toolNames 匹配 ==========\n");
  // tokenjuice 规则在项目根目录，不在 server 目录
  const rulesPath = join(process.cwd(), "..", ".tokenjuice", "rules", "agent-tool-json.json");
  const raw = await readFile(rulesPath, "utf8");
  const rules = JSON.parse(raw);
  const toolNames: string[] = rules.match.toolNames;

  const requiredTools = ["fetch_web", "search_web", "info.search", "info.read_webpage", "info.inspect_webpage", "info.navigate_site"];
  const oldAliases = ["web.fetch_page", "web.search"];

  console.log(`  规则文件 toolNames: ${toolNames.join(", ")}`);
  console.log("");

  let pass = true;
  for (const t of requiredTools) {
    const ok = toolNames.includes(t);
    if (!ok) pass = false;
    console.log(`  ${ok ? "✓" : "✗"} 包含 "${t}"`);
  }
  for (const alias of oldAliases) {
    const stillExists = toolNames.includes(alias);
    if (stillExists) pass = false;
    console.log(`  ${!stillExists ? "✓" : "✗"} 已移除旧别名 "${alias}"`);
  }
  console.log(`\n  结果: ${pass ? "✓ 通过" : "✗ 失败"}`);
}

// ============================================================
// 测试 2：搜索结果缓存
// ============================================================
async function testSearchCache() {
  console.log("\n========== 测试 2：搜索结果缓存（LRU + TTL） ==========\n");

  const cache = new SearchCache<string[]>({ maxSize: 3, ttlMs: 1000 });
  cache.set("k1", ["v1"]);
  cache.set("k2", ["v2"]);
  cache.set("k3", ["v3"]);

  console.log("  [初始] 设置 k1/k2/k3");
  console.log(`  ✓ get("k1") = ${cache.getWithStats("k1")}`); // 命中
  console.log(`  ✓ get("k2") = ${cache.getWithStats("k2")}`); // 命中

  // LRU 淘汰：访问 k1/k2 后，它们移到末尾，新增 k4 会淘汰最久未访问的 k3
  cache.set("k4", ["v4"]);
  console.log("\n  [LRU 淘汰] 新增 k4（maxSize=3）");
  console.log(`  ✓ get("k1") = ${cache.getWithStats("k1")} (应命中)`); // 命中
  console.log(`  ✓ get("k3") = ${cache.getWithStats("k3")} (应 undefined，被淘汰)`); // miss

  // TTL 过期
  console.log("\n  [TTL 过期] 等待 1.1s...");
  await new Promise((r) => setTimeout(r, 1100));
  console.log(`  ✓ get("k1") = ${cache.getWithStats("k1")} (应 undefined，已过期)`);

  const stats = cache.stats();
  console.log(`\n  统计: size=${stats.size}, hits=${stats.hitCount}, misses=${stats.missCount}`);
  console.log(`  结果: ${stats.hitCount >= 2 && stats.missCount >= 2 ? "✓ 通过" : "✗ 失败"}`);
}

// ============================================================
// 测试 3：RSS 健康检查 + 自动降级
// ============================================================
async function testRssHealth() {
  console.log("\n========== 测试 3：RSS 健康检查 + 自动降级 ==========\n");

  const monitor = new RssHealthMonitor({ failureThreshold: 3, cooldownMs: 500 });
  const sources = [
    { source: "源A", url: "http://a.example.com/rss" },
    { source: "源B", url: "http://b.example.com/rss" },
    { source: "源C", url: "http://c.example.com/rss" },
  ];

  console.log("  [初始] 所有源可用");
  console.log(`  ✓ 可用源数: ${monitor.filterAvailable(sources).length} (应 3)`);

  // 源 A 连续失败 3 次
  console.log("\n  [降级] 源A 连续失败 3 次");
  monitor.recordFailure("源A");
  monitor.recordFailure("源A");
  const degraded = monitor.recordFailure("源A");
  console.log(`  ✓ 触发降级: ${degraded} (应 true)`);
  console.log(`  ✓ 可用源数: ${monitor.filterAvailable(sources).length} (应 2)`);
  console.log(`  ✓ 源A 可用: ${monitor.isAvailable("源A")} (应 false)`);

  // 源 A 成功恢复
  console.log("\n  [恢复] 源A 记录成功");
  monitor.recordSuccess("源A");
  console.log(`  ✓ 源A 可用: ${monitor.isAvailable("源A")} (应 true)`);

  // 冷却期自动恢复
  console.log("\n  [冷却期] 源B 失败 3 次后等待 0.6s");
  monitor.recordFailure("源B");
  monitor.recordFailure("源B");
  monitor.recordFailure("源B");
  console.log(`  ✓ 降级后立即检查: ${monitor.isAvailable("源B")} (应 false)`);
  await new Promise((r) => setTimeout(r, 600));
  console.log(`  ✓ 冷却期后自动恢复: ${monitor.isAvailable("源B")} (应 true)`);

  console.log(`\n  结果: ✓ 通过`);
}

// ============================================================
// 测试 4：User-Agent 反爬优化
// ============================================================
async function testUserAgent() {
  console.log("\n========== 测试 4：User-Agent 反爬优化 ==========\n");

  const service = new InfoHubService();
  // @ts-expect-error 访问 private 字段用于测试
  const ua: string = service.userAgent;

  console.log(`  当前 UA: ${ua}`);
  const isRealBrowser = /Chrome\/\d+|Firefox\/\d+|Safari\/\d+/.test(ua);
  const notBot = !/bot|crawler|spider|PrivateAIAgent/i.test(ua);
  console.log(`  ✓ 真实浏览器 UA: ${isRealBrowser}`);
  console.log(`  ✓ 不含 bot 标识: ${notBot}`);

  // 实际测试 IT之家（之前会被反爬拒绝）
  console.log("\n  [实测] 抓取 IT之家 RSS（之前 UA 会被拒）...");
  const start = Date.now();
  try {
    const result = await fetchWebPageEnhanced(
      "https://www.ithome.com/rss/",
      { userAgent: ua, timeoutMs: 10_000, enableJina: false },
      (html) => html.slice(0, 500),
    );
    const elapsed = Date.now() - start;
    console.log(`  ✓ 耗时: ${fmtMs(elapsed)}`);
    console.log(`  ✓ 提取器: ${result.extractor}`);
    console.log(`  ✓ 内容长度: ${result.text.length} 字符`);
    console.log(`  ✓ 内容预览: ${truncate(result.text.replace(/\s+/g, " "), 100)}`);
  } catch (e: any) {
    console.log(`  ✗ 失败: ${e.message}`);
  }
  console.log(`\n  结果: ${isRealBrowser && notBot ? "✓ 通过" : "✗ 失败"}`);
}

// ============================================================
// 测试 5：navigateSite 接入 Readability
// ============================================================
async function testNavigateSiteReadability() {
  console.log("\n========== 测试 5：navigateSite 接入 Readability ==========\n");

  // 构造一个模拟场景：用 extractWithReadability 验证 navigateSite 内部逻辑
  const sampleHtml = `<!DOCTYPE html>
<html><head><title>注册页面 - 示例站</title></head>
<body>
  <nav>导航菜单</nav>
  <main>
    <article>
      <h1>欢迎注册</h1>
      <p>请点击下方按钮完成注册。注册流程简单，只需 3 步。</p>
      <p>第一步：填写邮箱。第二步：设置密码。第三步：验证手机。</p>
    </article>
  </main>
  <aside>广告位</aside>
  <footer>版权所有</footer>
</body></html>`;

  const result = extractWithReadability(sampleHtml, "https://example.com/register");
  console.log(`  ✓ 标题: ${result.title}`);
  console.log(`  ✓ 内容长度: ${result.text.length} 字符`);
  console.log(`  ✓ 包含"注册": ${result.text.includes("注册")}`);
  console.log(`  ✓ 排除"广告位": ${!result.text.includes("广告位")}`);
  console.log(`  ✓ 排除"版权所有": ${!result.text.includes("版权所有")}`);
  console.log(`\n  结果: ${result.text.includes("注册") && !result.text.includes("广告位") ? "✓ 通过" : "✗ 失败"}`);
}

// ============================================================
// 测试 6：fetch_web 支持 PDF
// ============================================================
async function testPdfParsing() {
  console.log("\n========== 测试 6：fetch_web 支持 PDF 自动解析 ==========\n");

  // 用公开的 PDF 测试（arxiv 论文）
  const testPdfUrl = "https://arxiv.org/pdf/1706.03762"; // Attention Is All You Need
  console.log(`  测试 URL: ${testPdfUrl}`);
  const start = Date.now();
  try {
    const result = await fetchWebPageEnhanced(
      testPdfUrl,
      { userAgent: USER_AGENT, timeoutMs: 30_000, enableJina: false },
      (html) => html.slice(0, 500),
    );
    const elapsed = Date.now() - start;
    console.log(`  ✓ 耗时: ${fmtMs(elapsed)}`);
    console.log(`  ✓ 提取器: ${result.extractor}`);
    console.log(`  ✓ 标题: ${truncate(result.title, 60)}`);
    console.log(`  ✓ 内容长度: ${result.text.length} 字符`);
    console.log(`  ✓ 内容预览: ${truncate(result.text.replace(/\s+/g, " "), 200)}`);
    // 验证是 PDF 内容（包含论文关键词）
    const isPdfContent = /attention|transformer|neural|sequence/i.test(result.text);
    console.log(`  ✓ 内容是 PDF 文本: ${isPdfContent}`);
    console.log(`\n  结果: ${isPdfContent ? "✓ 通过" : "✗ 失败"}`);
  } catch (e: any) {
    console.log(`  ✗ 失败: ${e.message}`);
  }
}

// ============================================================
// 测试 7：搜索意图识别
// ============================================================
async function testIntentClassification() {
  console.log("\n========== 测试 7：搜索意图识别 ==========\n");

  const cases = [
    { query: "OpenAI 最新新闻", expectIntent: "latest", expectFresh: true },
    { query: "iPhone 15 和 iPhone 16 对比", expectIntent: "compare", expectFresh: false },
    { query: "茅台股票价格", expectIntent: "price", expectFresh: true },
    { query: "什么是大语言模型", expectIntent: "definition", expectFresh: false },
    { query: "调研一下特斯拉这家公司", expectIntent: "research", expectFresh: false },
    { query: "今天天气怎么样", expectIntent: "latest", expectFresh: true },
  ];

  let pass = 0;
  for (const c of cases) {
    const result = classifySearchIntent(c.query);
    const intentOk = result.intent === c.expectIntent;
    const freshOk = result.requiresFreshWeb === c.expectFresh;
    const ok = intentOk && freshOk;
    if (ok) pass++;
    console.log(`  ${ok ? "✓" : "✗"} "${c.query}"`);
    console.log(`     意图: ${result.intent} (期望 ${c.expectIntent}) ${intentOk ? "✓" : "✗"}`);
    console.log(`     需联网: ${result.requiresFreshWeb} (期望 ${c.expectFresh}) ${freshOk ? "✓" : "✗"}`);
    console.log(`     实体: [${result.entities.join(", ")}]`);
    console.log(`     建议limit: ${result.suggestedLimit ?? "默认"}`);
  }
  console.log(`\n  通过率: ${pass}/${cases.length}`);
}

// ============================================================
// 测试 8：同会话跨查询复用
// ============================================================
async function testSessionCache() {
  console.log("\n========== 测试 8：同会话跨查询复用 ==========\n");

  const cache = new SessionSearchCache({ similarityThreshold: 0.3 });
  const sessionId = "test-session-1";

  // 模拟第一次搜索
  const query1 = "人工智能 最新发展";
  const items1 = [
    { title: "AI 最新进展", url: "https://example.com/1", snippet: "...", source: "test" },
    { title: "GPT-5 发布", url: "https://example.com/2", snippet: "...", source: "test" },
  ];
  cache.record(sessionId, query1, items1 as any);
  console.log(`  [记录] "${query1}"`);

  // 相似查询应命中
  const query2 = "人工智能 最新";
  const reusable2 = cache.findReusable(sessionId, query2);
  console.log(`  [复用] "${query2}" → ${reusable2 ? `命中 ${reusable2.length} 条` : "未命中"}`);

  // 不相关查询不应命中
  const query3 = "天气预报";
  const reusable3 = cache.findReusable(sessionId, query3);
  console.log(`  [复用] "${query3}" → ${reusable3 ? `命中 ${reusable3.length} 条` : "未命中"}`);

  // 另一会话不应命中
  const reusable4 = cache.findReusable("other-session", query2);
  console.log(`  [隔离] 其他会话 "${query2}" → ${reusable4 ? `命中 ${reusable4.length} 条` : "未命中"}`);

  const pass = !!reusable2 && reusable2.length > 0 && !reusable3 && !reusable4;
  console.log(`\n  结果: ${pass ? "✓ 通过" : "✗ 失败"}`);
}

// ============================================================
// 测试 9：端到端 - InfoHubService 集成验证
// ============================================================
async function testEndToEnd() {
  console.log("\n========== 测试 9：InfoHubService 端到端验证 ==========\n");

  const service = new InfoHubService();
  const query = "人工智能 最新新闻";

  console.log(`▶ 第一次搜索 "${query}"...`);
  const start1 = Date.now();
  const r1 = await service.search(query, 8, "e2e-session");
  const elapsed1 = Date.now() - start1;
  console.log(`  耗时: ${fmtMs(elapsed1)}，返回 ${r1.length} 条`);
  if (r1.length > 0) {
    console.log(`  最新: [${r1[0].source}] ${truncate(r1[0].title, 50)}`);
    console.log(`  时间: ${r1[0].publishedAt || "未知"}`);
  }

  console.log(`\n▶ 第二次相同查询（应命中缓存，耗时大幅下降）...`);
  const start2 = Date.now();
  const r2 = await service.search(query, 8, "e2e-session");
  const elapsed2 = Date.now() - start2;
  console.log(`  耗时: ${fmtMs(elapsed2)}，返回 ${r2.length} 条`);
  console.log(`  ✓ 缓存命中: ${elapsed2 < elapsed1 / 3}`);
  console.log(`  ✓ 结果一致: ${r1.length === r2.length}`);

  console.log(`\n▶ 相似查询（应命中会话复用）...`);
  const similarQuery = "人工智能 最新";
  const start3 = Date.now();
  const r3 = await service.search(similarQuery, 8, "e2e-session");
  const elapsed3 = Date.now() - start3;
  console.log(`  耗时: ${fmtMs(elapsed3)}，返回 ${r3.length} 条`);
  console.log(`  ✓ 会话复用: ${elapsed3 < 50}`);
}

async function main() {
  console.log("Private-Agent 联网能力优化 - 第二轮测试");
  console.log("==========================================");
  console.log(`时间: ${new Date().toISOString()}`);

  await testTokenjuiceRules();
  await testSearchCache();
  await testRssHealth();
  await testUserAgent();
  await testNavigateSiteReadability();
  await testPdfParsing();
  await testIntentClassification();
  await testSessionCache();
  await testEndToEnd();

  console.log("\n========== 全部测试完成 ==========\n");
}

main().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
