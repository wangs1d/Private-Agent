import { InfoHubService } from "../src/services/info-hub-service.js";
import { filterItemsByRelevance } from "../src/services/domestic-web-providers.js";

async function live(svc: InfoHubService, query: string, limit: number): Promise<void> {
  const items = await svc.search(query, limit);
  console.log(`\n=== 真实联网 "${query}" -> ${items.length} 条 ===`);
  items.forEach((it, i) => console.log(`  ${i + 1}. [${it.source}] ${it.title.slice(0, 60)}`));
}

// 单元级：动词跑题过滤
const noise = [
  { title: "《中国工业领域绿色低碳发展技术蓝皮书》在湖州发布", url: "x", snippet: "发布" },
  { title: "DeepSeek V4-Pro 正式版更新了什么?", url: "y", snippet: "更新" },
  { title: "如何查看网站的发布日期和更新记录", url: "z", snippet: "看日期" },
  { title: "荣耀折叠屏手机 2026 新款 参数", url: "a", snippet: "荣耀折叠屏" },
  { title: "2026 折叠屏手机横评：荣耀 Magic V 领衔", url: "b", snippet: "荣耀" },
];
const kept = filterItemsByRelevance(noise, "荣耀折叠屏手机 最新发布");
console.log("\n=== 单元过滤 query='荣耀折叠屏手机 最新发布' ===");
kept.forEach((k) => console.log("  KEEP:", k.title));

async function main() {
  const svc = new InfoHubService();
  await live(svc, "荣耀 折叠屏手机 最新发布", 12);
}
main().catch((e) => { console.error(e); process.exit(1); });