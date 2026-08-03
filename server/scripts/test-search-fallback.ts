/**
 * 集成测试：验证 search() 的三层 fallback 机制。
 *
 * 场景：
 *  1. "今天A股最新消息" — 实体化查询（"A股"）应该能返回结果
 *  2. "GPT-5 最新动态" — 实体化查询（"GPT-5"）应该能返回结果
 *  3. "蜘蛛侠4 斩新之日 票房" — 实体化查询（"蜘蛛侠4"）应该能返回结果
 *  4. fallback 验证：即使实体化返回 0，也应该回退到完整 query + 宽松模式
 */
import { prependRecencyQueryVariants, classifySearchIntent } from "../src/services/search-enhancements.js";
import {
  buildSearchQueryVariants,
  filterItemsByRelevance,
  searchBingChina,
  searchBingChinaRelaxed,
} from "../src/services/domestic-web-providers.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const cases = [
  { q: "今天A股最新消息", expectedEntity: "A股" },
  { q: "GPT-5 最新动态", expectedEntity: "GPT-5" },
  { q: "蜘蛛侠4 斩新之日 票房", expectedEntity: "蜘蛛侠4" },
  { q: "iPhone 17 评测", expectedEntity: "iPhone 17" },
];

async function main() {
  for (const { q, expectedEntity } of cases) {
    console.log(`\n========== 案例：${q} ==========`);

    // 1. 意图识别
    const intent = classifySearchIntent(q);
    console.log(`意图：${intent.intent}`);
    console.log(`实体（优先级排序）：[${intent.entities.join(", ")}]`);
    const bestEntity = intent.entities.find(
      (e) => e.length >= 2 && !/^(最新|最近|今日|今天|现在|目前|刚刚|新闻|消息|资讯|事件|发生|动态|头条|怎么|如何|什么|情况)$/i.test(e),
    );
    console.log(`选中实体：${bestEntity} ${bestEntity === expectedEntity ? "✅" : "❌ 预期 " + expectedEntity}`);

    // 2. 变体生成
    const variants = prependRecencyQueryVariants(buildSearchQueryVariants(q), q);
    console.log(`查询变体（${variants.length}）：`);
    variants.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));

    // 3. 实体化查询
    let entityResults: Awaited<ReturnType<typeof searchBingChina>> = [];
    if (bestEntity && q.length > 6) {
      const start = Date.now();
      entityResults = await searchBingChina(bestEntity, 8, { userAgent: UA });
      console.log(`\n实体查询 "${bestEntity}": ${entityResults.length} 条，${Date.now() - start}ms`);
      entityResults.slice(0, 3).forEach((it, i) =>
        console.log(`  ${i + 1}. ${it.title.slice(0, 60)}`),
      );
    }

    // 4. 完整 query 查询（fallback level 1）
    const startFull = Date.now();
    const fullResults = await searchBingChina(q, 8, { userAgent: UA });
    console.log(`\n完整查询 "${q}": ${fullResults.length} 条，${Date.now() - startFull}ms`);
    fullResults.slice(0, 3).forEach((it, i) =>
      console.log(`  ${i + 1}. ${it.title.slice(0, 60)}`),
    );

    // 5. 宽松模式（fallback level 2）
    const startRelaxed = Date.now();
    const relaxedResults = await searchBingChinaRelaxed(bestEntity ?? q, 8, { userAgent: UA });
    console.log(`\n宽松模式 "${bestEntity ?? q}": ${relaxedResults.length} 条，${Date.now() - startRelaxed}ms`);
    relaxedResults.slice(0, 3).forEach((it, i) =>
      console.log(`  ${i + 1}. ${it.title.slice(0, 60)}`),
    );

    // 6. 总结
    const totalAvailable = Math.max(
      fullResults.length,
      entityResults.length,
      relaxedResults.length,
    );
    console.log(
      `\n>>> 总可召回：${totalAvailable} 条 ${totalAvailable > 0 ? "✅" : "❌ 全部为空"}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
