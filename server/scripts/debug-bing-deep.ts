/**
 * 调试：详细查看 searchBingChina 内部发生了什么
 */
import { searchBingChina, buildSearchQueryVariants, filterItemsByRelevance } from "../src/services/domestic-web-providers.js";
import { prependRecencyQueryVariants } from "../src/services/search-enhancements.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function main() {
  const query = "今天A股最新消息";

  console.log(`Query: "${query}"`);

  // 1. 变体
  const variants = prependRecencyQueryVariants(buildSearchQueryVariants(query), query);
  console.log(`变体: [${variants.map((v) => `"${v}"`).join(", ")}]`);

  // 2. 直接 fetch 每个变体（绕过 searchBingChina 的过滤）
  for (const v of variants) {
    const start = Date.now();
    const rssUrl = `https://cn.bing.com/search?q=${encodeURIComponent(v)}&format=rss`;
    const htmlUrl = `https://cn.bing.com/search?q=${encodeURIComponent(v)}`;
    console.log(`\n变体 "${v}" (直接fetchBingChinaOnce):`);
    try {
      const items = await searchBingChina(v, 10, { userAgent: UA });
      console.log(`  返回 ${items.length} 条, ${Date.now() - start}ms`);
      items.slice(0, 3).forEach((it, i) => {
        console.log(`  ${i + 1}. ${it.title.slice(0, 50)}`);
      });

      // 检查过滤后还有多少
      const filtered = filterItemsByRelevance(items, query);
      console.log(`  过滤后: ${filtered.length} 条`);
      if (items.length > 0 && filtered.length === 0) {
        console.log(`  ⚠️ 全部被过滤掉！anchors:`);
        // 重新计算 anchors
      }
    } catch (e: any) {
      console.log(`  失败: ${e.message}`);
    }
  }
}

main().catch(console.error);
