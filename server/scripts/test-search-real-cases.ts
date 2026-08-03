/**
 * 测试当前搜索对电影/娱乐类查询的表现
 */
import { InfoHubService } from "../src/services/info-hub-service.js";

async function testQuery(label: string, query: string) {
  console.log(`\n========== ${label}: "${query}" ==========`);
  const service = new InfoHubService();
  const start = Date.now();
  const items = await service.search(query, 8);
  const elapsed = Date.now() - start;
  console.log(`耗时: ${elapsed}ms, 返回 ${items.length} 条`);
  items.slice(0, 5).forEach((item, i) => {
    console.log(`  ${i + 1}. [${item.source}] ${item.title.slice(0, 70)}`);
    if (item.publishedAt) {
      const d = new Date(item.publishedAt);
      console.log(`     时间: ${d.toLocaleString("zh-CN")}`);
    }
  });
}

async function main() {
  await testQuery("电影", "蜘蛛侠4 斩新之日 票房 评分");
  await testQuery("AI", "GPT-5 最新动态");
  await testQuery("金融", "今天A股大盘行情");
  await testQuery("赛事", "巴黎奥运会 2026 中国队");
  await testQuery("娱乐", "周杰伦 最新专辑 演唱会");
  await testQuery("天气", "北京明天天气");
  await testQuery("无意义查询", "今天有什么好看的电影");
}

main().catch(console.error);
