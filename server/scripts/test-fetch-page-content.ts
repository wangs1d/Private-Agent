/**
 * 抓取搜索结果中的具体页面内容
 */
import { InfoHubService } from "../src/services/info-hub-service.js";

async function main() {
  const service = new InfoHubService();

  const urls = [
    { name: "财联社股市频道", url: "https://www.cls.cn/subject?id=1003" },
    { name: "同花顺A股市场", url: "https://q.10jqka.com.cn/" },
  ];

  for (const { name, url } of urls) {
    console.log(`\n========== ${name} ==========`);
    console.log(`URL: ${url}\n`);
    const start = Date.now();
    try {
      const result = await service.readWebpage(url);
      const elapsed = Date.now() - start;
      console.log(`耗时: ${elapsed}ms`);
      console.log(`标题: ${result.title}`);
      console.log(`内容长度: ${result.content.length} 字符`);
      console.log(`摘要: ${result.summary}`);
      console.log(`\n--- 正文内容（前 2000 字）---\n`);
      console.log(result.content.slice(0, 2000));
    } catch (e: any) {
      console.log(`失败: ${e.message}`);
    }
    console.log("\n");
  }
}

main().catch(console.error);
