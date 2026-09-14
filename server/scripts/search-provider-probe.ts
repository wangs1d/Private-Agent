/**
 * 搜索源召回对比探针（P2a）：用黄金问题集直查已配置的搜索 API，
 * 输出每题的返回条数/耗时/前 3 条标题，供人工评估源覆盖质量
 * （如 AnySearch 对娱乐人物动态的覆盖）。
 *
 * 用法: npx tsx scripts/search-provider-probe.ts ["自定义查询1" "自定义查询2" ...]
 * 换源对比：临时改 .env.local 的 SEARCH_API_PROVIDER/SEARCH_API_KEY 后重跑。
 */
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
config({ path: new URL("../.env.local", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), override: true });

import { searchViaSearchApi } from "../src/services/search-api-provider.js";

const DEFAULT_QUERIES = [
  "刘浩存 近期 行程",
  "刘浩存 泰国",
  "刘浩存 最新动态",
  "比特币 最新价格",
  "今天 重大新闻",
];

const queries =
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_QUERIES;

console.log(`provider 配置读取完成，开始探测 ${queries.length} 个查询…\n`);

let total = 0;
for (const q of queries) {
  const t0 = Date.now();
  try {
    const items = await searchViaSearchApi(q, 8);
    const ms = Date.now() - t0;
    const n = items?.length ?? 0;
    total += n;
    console.log(`【${q}】 ${n} 条 / ${ms}ms`);
    for (const it of (items ?? []).slice(0, 3)) {
      console.log(`   - ${String(it.title).slice(0, 60)}｜${String(it.publishedAt ?? it.date ?? "无日期").slice(0, 20)}`);
    }
  } catch (err) {
    console.log(`【${q}】 探测失败: ${err instanceof Error ? err.message : err}`);
  }
  console.log("");
}
console.log(`合计 ${total} 条。判断：某类查询长期 0-2 条 = 该源对这类信息覆盖弱，考虑换 SEARCH_API_PROVIDER 或补第二源。`);
