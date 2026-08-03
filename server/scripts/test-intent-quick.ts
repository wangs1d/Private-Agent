import { classifySearchIntent } from "../src/services/search-enhancements.js";

const queries = [
  "今天A股最新消息",
  "蜘蛛侠4 斩新之日 票房 评分",
  "GPT-5 最新动态",
  "北京明天天气",
  "iPhone 17 评测",
  "MacBook M5 发布",
  "Claude 4 性能",
  "Switch 2 上市",
];

for (const q of queries) {
  const r = classifySearchIntent(q);
  console.log(`${q}\n  intent: ${r.intent}, entities: [${r.entities.join(", ")}]`);
}
