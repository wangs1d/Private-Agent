/**
 * 调试必应搜索：测试不同 query 变体
 */
import { searchBingChina } from "../src/services/domestic-web-providers.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function main() {
  const queries = [
    "今天A股最新消息",
    "A股",
    "A股 今日行情",
    "中国股市",
    "上证指数",
  ];

  for (const q of queries) {
    console.log(`\n▶ 查询: "${q}"`);
    const start = Date.now();
    try {
      const items = await searchBingChina(q, 5, { userAgent: UA });
      const elapsed = Date.now() - start;
      console.log(`  耗时: ${elapsed}ms, 返回 ${items.length} 条`);
      items.slice(0, 3).forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.source}] ${item.title?.slice(0, 60)}`);
        console.log(`     时间: ${item.publishedAt || "未知"}`);
      });
    } catch (e: any) {
      console.log(`  失败: ${e.message}`);
    }
  }
}

main().catch(console.error);
