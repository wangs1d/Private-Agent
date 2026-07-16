/**
 * 实测：搜索今天 A 股的消息
 */
import { InfoHubService } from "../src/services/info-hub-service.js";
import { parsePublishedAtMs } from "../src/services/search-freshness.js";

async function main() {
  const service = new InfoHubService();
  const query = "今天A股最新消息";

  console.log(`搜索查询: "${query}"`);
  console.log(`时间: ${new Date().toISOString()}`);
  console.log("==================================\n");

  const start = Date.now();
  const items = await service.search(query, 10);
  const elapsed = Date.now() - start;

  console.log(`耗时: ${elapsed}ms`);
  console.log(`返回 ${items.length} 条结果\n`);

  const now = Date.now();
  items.forEach((item, i) => {
    const ts = parsePublishedAtMs(item.publishedAt);
    const ageMin = ts ? Math.round((now - ts) / 60000) : null;
    const ageStr = ageMin !== null ? `${ageMin} 分钟前` : "未知时间";
    const dateStr = ts ? new Date(ts).toISOString() : item.publishedAt || "未知";
    console.log(`${i + 1}. [${item.source}] ${item.title}`);
    console.log(`   时间: ${dateStr} (${ageStr})`);
    console.log(`   URL: ${item.url}`);
    if (item.snippet) console.log(`   摘要: ${item.snippet.slice(0, 120)}`);
    console.log("");
  });
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
