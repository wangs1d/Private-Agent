/**
 * 4 项优化集成测试
 * 1. 网页内容缓存
 * 2. 搜索结果质量评分
 * 3. 错误重试 + 指数退避
 * 4. 新增 RSS 源
 */
import { InfoHubService } from "../src/services/info-hub-service.js";
import { withRetry, sortByQuality, scoreSearchItem, type InfoSearchItem } from "../src/services/search-enhancements.js";

let passed = 0;
let failed = 0;
const log = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
};

async function main() {
  console.log("=== 4 项优化集成测试 ===\n");

  // ---------- 测试 1：网页内容缓存 ----------
  console.log("【测试 1】网页内容缓存");
  try {
    const svc = new InfoHubService();
    const url = "https://example.com";
    const t1 = Date.now();
    await svc.readWebpage(url);
    const t1Elapsed = Date.now() - t1;

    const t2 = Date.now();
    await svc.readWebpage(url);
    const t2Elapsed = Date.now() - t2;

    log(
      t2Elapsed < 50 && t2Elapsed < t1Elapsed,
      "网页内容缓存命中",
      `首次=${t1Elapsed}ms, 缓存命中=${t2Elapsed}ms`,
    );
  } catch (e: any) {
    log(false, "网页内容缓存", e.message);
  }

  // ---------- 测试 2：搜索结果质量评分 ----------
  console.log("\n【测试 2】搜索结果质量评分");
  try {
    const query = "A股";
    const items: InfoSearchItem[] = [
      { title: "A股收评：三大指数集体收跌", url: "u1", snippet: "A股今日收盘", source: "中国新闻网财经", publishedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
      { title: "天气预报", url: "u2", snippet: "今日天气", source: "必应中国", publishedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
      { title: "A股IPO动态", url: "u3", snippet: "今日A股IPO", source: "必应中国", publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    const sorted = sortByQuality(items, query);
    log(
      sorted[0].url === "u1" && sorted[1].url === "u3" && sorted[2].url === "u2",
      "质量评分排序",
      `顺序: ${sorted.map(i => i.url).join(" → ")}（A股相关排前，无关排后）`,
    );
    const score1 = scoreSearchItem(items[0], query);
    const score2 = scoreSearchItem(items[1], query);
    log(score1 > score2, "评分对比", `A股文章=${score1.toFixed(3)} > 天气预报=${score2.toFixed(3)}`);
  } catch (e: any) {
    log(false, "搜索结果质量评分", e.message);
  }

  // ---------- 测试 3：错误重试 + 指数退避 ----------
  console.log("\n【测试 3】错误重试 + 指数退避");
  try {
    let attempts = 0;
    const start = Date.now();
    try {
      await withRetry(async () => {
        attempts++;
        throw new Error("模拟失败");
      }, { maxRetries: 2, baseDelayMs: 100 });
    } catch {}
    const elapsed = Date.now() - start;
    log(attempts === 3, "重试次数正确", `共尝试 ${attempts} 次（1+2 次重试）`);
    log(elapsed >= 300, "指数退避生效", `耗时 ${elapsed}ms（至少 100+200=300ms 间隔）`);
  } catch (e: any) {
    log(false, "错误重试", e.message);
  }

  try {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error("首次失败");
      return "ok";
    }, { maxRetries: 2, baseDelayMs: 50 });
    log(result === "ok" && attempts === 2, "重试后成功", `第 ${attempts} 次成功`);
  } catch (e: any) {
    log(false, "重试后成功", e.message);
  }

  // ---------- 测试 4：RSS 源健康检查（新增源验证） ----------
  console.log("\n【测试 4】RSS 源健康检查");
  try {
    const svc = new InfoHubService();
    // 搜索国际新闻，应该能命中中新网国际等官方 RSS 源
    const items = await svc.search("美国 最新新闻", 15);
    const officialSources = ["中国新闻网滚动", "中国新闻网要闻", "中国新闻网国际", "中国新闻网财经", "中国新闻网国内", "人民网时政", "人民网国际"];
    const officialHits = items.filter(i => officialSources.includes(i.source));
    log(
      officialHits.length > 0,
      "官方 RSS 源返回结果",
      `${officialHits.length} 条来自官方媒体（中新网/人民网）`,
    );
    if (officialHits.length > 0) {
      console.log(`  示例: [${officialHits[0].source}] ${officialHits[0].title.slice(0, 60)}`);
    }
    // 验证环球网/联合早报已正确移除（实测失效）
    const invalidSources = items.filter(i => i.source === "环球网" || i.source === "联合早报");
    log(
      invalidSources.length === 0,
      "失效源已移除",
      "环球网/联合早报 RSS 实测返回 HTML 而非 XML，已正确移除",
    );
  } catch (e: any) {
    log(false, "RSS 源健康检查", e.message);
  }

  // ---------- 总结 ----------
  console.log("\n==================================");
  console.log(`测试结果: ${passed} 通过 / ${failed} 失败`);
  if (failed === 0) {
    console.log("✓ 全部通过");
  } else {
    console.log("✗ 有失败项，请检查");
  }
}

main().catch(console.error);
