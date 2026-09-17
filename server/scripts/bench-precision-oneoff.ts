/**
 * 定向读取精确度实验（一次性测量，2026-09-17）。
 *
 * 度量 resolveQueryWindow 的 hit@1：窗口切片是否包含答案所需事实。
 * 按「query 与答案原文的词面重叠度」分四档 + 无关 query 的正确拒绝率。
 * 命中判定与 eval-content-recall 同口径：切片 contains 目标事实。
 */
import { buildContentMap, resolveQueryWindow } from "../src/external-model/content-map.js";

// ── 语料（5 类文档，与 eval-content-recall 同源） ──
const mdDoc = [
  "# 服务条款",
  "## 产品简介",
  `这是一款面向个人用户的智能助理产品。${"简".repeat(600)}`,
  "## 常见问题",
  `支持多端同步与语音输入。${"问".repeat(600)}`,
  "## 退款政策",
  "退款规则：购买后 7 天内可无理由全额退款，超过 7 天收取 10% 手续费。",
  `${"退".repeat(600)}`,
  "## 联系方式",
  `客服工作时间 9:00-21:00，热线 400-000-0000。${"联".repeat(600)}`,
].join("\n");

const jsonItems = Array.from({ length: 40 }, (_, i) => ({
  title: `结果${i}：常规资讯` + "流".repeat(60),
  snippet: "每日热点摘要" + "流".repeat(150),
  url: `https://example.com/news/${i}`,
}));
jsonItems[37] = { title: "结果37：上海公积金新政策", snippet: "缴存基数上限调整为 36549 元，7 月 1 日起执行。", url: "https://example.com/news/gjj" };
const jsonDoc = JSON.stringify({ ok: true, query: "公积金", items: jsonItems });

const csvRows = ["航班号,出发,到达,状态"];
for (let i = 1; i <= 600; i++) {
  csvRows.push(i === 540 ? "MU5137,上海浦东,法兰克福,延误 2 小时" : `CZ${1000 + i},城市${i},城市${(i % 40) + 1},正常`);
}
const csvDoc = csvRows.join("\n");

const textDoc = [
  "会议纪要：本周同步了项目进展。",
  ...Array.from({ length: 12 }, (_, i) => `议题${i}：常规讨论内容` + "常".repeat(180)),
  "议题13：预算决议——Q4 市场预算上调至 120 万元，需财务复核。",
  ...Array.from({ length: 6 }, (_, i) => `议题1${4 + i}：后续安排` + "排".repeat(180)),
].join("\n\n");

const codeParts: string[] = [];
for (let i = 0; i < 30; i++) {
  codeParts.push(`export function helper${i}(x: number): number {\n  return x + ${i};\n}\n`);
  if (i === 21) codeParts.push("export function refundFee(days: number): number {\n  return days <= 7 ? 0 : 0.1; // 7 天内免手续费\n}\n");
}
const codeDoc = codeParts.join("\n");

// ── 用例：query 按词面重叠度分档 ──
interface P { doc: string; docName: string; query: string; mustContain: string; tier: string }
const CASES: P[] = [
  // T1 直接命中：query 词汇出现在答案原文
  { doc: mdDoc, docName: "条款页", query: "退款手续费", mustContain: "10% 手续费", tier: "T1 词面直接命中" },
  { doc: jsonDoc, docName: "搜索结果", query: "公积金 缴存基数", mustContain: "36549", tier: "T1 词面直接命中" },
  { doc: csvDoc, docName: "航班表", query: "MU5137 法兰克福 状态", mustContain: "延误 2 小时", tier: "T1 词面直接命中" },
  { doc: textDoc, docName: "会议纪要", query: "预算决议 市场预算", mustContain: "120 万元", tier: "T1 词面直接命中" },
  { doc: codeDoc, docName: "源码", query: "refundFee 手续费", mustContain: "days <= 7 ? 0 : 0.1", tier: "T1 词面直接命中" },
  // T2 部分改写：一半词汇重叠
  { doc: mdDoc, docName: "条款页", query: "手续费怎么算", mustContain: "10% 手续费", tier: "T2 部分改写" },
  { doc: mdDoc, docName: "条款页", query: "几天内能全额退款", mustContain: "7 天内可无理由全额退款", tier: "T2 部分改写" },
  { doc: jsonDoc, docName: "搜索结果", query: "公积金新政执行时间", mustContain: "7 月 1 日", tier: "T2 部分改写" },
  { doc: csvDoc, docName: "航班表", query: "去法兰克福的航班", mustContain: "延误 2 小时", tier: "T2 部分改写" },
  { doc: textDoc, docName: "会议纪要", query: "Q4 花多少钱", mustContain: "120 万元", tier: "T2 部分改写" },
  // T3 弱重叠：仅少量共同字
  { doc: mdDoc, docName: "条款页", query: "交了钱能退吗", mustContain: "退款规则", tier: "T3 弱重叠" },
  { doc: mdDoc, docName: "条款页", query: "客服电话多少", mustContain: "400-000-0000", tier: "T3 弱重叠" },
  { doc: jsonDoc, docName: "搜索结果", query: "住房资金新规", mustContain: "公积金", tier: "T3 弱重叠" },
  { doc: csvDoc, docName: "航班表", query: "540 行什么情况", mustContain: "MU5137", tier: "T3 弱重叠" },
  { doc: textDoc, docName: "会议纪要", query: "钱的问题谁负责", mustContain: "财务复核", tier: "T3 弱重叠" },
  // T4 极端：口语化/几乎无词面重叠
  { doc: mdDoc, docName: "条款页", query: "后悔了怎么办", mustContain: "退款", tier: "T4 极端改写" },
  { doc: jsonDoc, docName: "搜索结果", query: "买房的人注意了", mustContain: "公积金", tier: "T4 极端改写" },
  { doc: textDoc, docName: "会议纪要", query: "经费那事定了没", mustContain: "预算决议", tier: "T4 极端改写" },
  { doc: codeDoc, docName: "源码", query: "退钱扣多少比例", mustContain: "0.1", tier: "T4 极端改写" },
];

// 无关 query 的正确拒绝（应返回 null → 回退线性分页，不出假窗口）
const NEGATIVES: Array<{ doc: string; query: string }> = [
  { doc: mdDoc, query: "今天股市行情如何" },
  { doc: jsonDoc, query: "红烧肉怎么做" },
  { doc: csvDoc, query: "天气预报" },
];

const BUDGET = 1200;
let hit = 0;
const byTier = new Map<string, { h: number; n: number }>();
let hyHit = 0;
const hyByTier = new Map<string, { h: number; n: number }>();

// ── mock 同义词嵌入：概念词典 → 独热向量（演示融合管线；真实语义能力取决于 embedding 端点模型） ──
const CONCEPT_DIMS: Array<[string, string[]]> = [
  ["refund", ["退款", "退钱", "退货", "后悔", "手续费"]],
  ["contact", ["客服", "电话", "热线", "联系"]],
  ["housing-fund", ["公积金", "住房资金", "买房"]],
  ["budget", ["预算", "经费", "花钱", "财务"]],
  ["flight", ["航班", "延误", "法兰克福"]],
];
const DIM_INDEX = new Map(CONCEPT_DIMS.map(([name], i) => [name, i]));
const WORD_TO_DIM = new Map<string, number>();
for (const [name, words] of CONCEPT_DIMS) {
  for (const w of words) WORD_TO_DIM.set(w, DIM_INDEX.get(name)!);
}
function mockEmbed(text: string): Float32Array {
  const vec = new Float32Array(CONCEPT_DIMS.length);
  for (const [word, dim] of WORD_TO_DIM) {
    if (text.includes(word)) vec[dim] = 1;
  }
  return vec;
}
function semanticFor(doc: string, query: string) {
  const map = buildContentMap(doc);
  return {
    queryVector: mockEmbed(query),
    sectionVectors: map.sections.map((s) => mockEmbed(`${s.title} ${doc.slice(s.offset, s.offset + 512)}`)),
  };
}

console.log(`\n# 定向读取精确度实验（预算 ${BUDGET} 字符，hit@1 = 窗口含答案事实）\n`);
console.log("词面独跑            语义混合            tier / doc / query");
console.log("-".repeat(90));
for (const c of CASES) {
  const map = buildContentMap(c.doc);
  const win = resolveQueryWindow(map, c.doc, c.query, BUDGET);
  const slice = win ? c.doc.slice(win.offset, win.offset + win.chars) : "";
  const ok = slice.includes(c.mustContain);
  if (ok) hit++;
  const t = byTier.get(c.tier) ?? { h: 0, n: 0 };
  t.n++;
  if (ok) t.h++;
  byTier.set(c.tier, t);
  // 语义混合通道（端点未配置环境下用 mock 概念向量验证融合管线）
  const hint = semanticFor(c.doc, c.query);
  const win2 = resolveQueryWindow(map, c.doc, c.query, BUDGET, hint);
  const slice2 = win2 ? c.doc.slice(win2.offset, win2.offset + win2.chars) : "";
  const ok2 = slice2.includes(c.mustContain);
  if (ok2) hyHit++;
  const t2 = hyByTier.get(c.tier) ?? { h: 0, n: 0 };
  t2.n++;
  if (ok2) t2.h++;
  hyByTier.set(c.tier, t2);
  const mark = (b: boolean) => (b ? "HIT " : "MISS");
  const flip = ok !== ok2 ? " ←" : "";
  console.log(`${mark(ok).padEnd(18)} ${mark(ok2).padEnd(18)} [${c.tier}] ${c.docName} «${c.query}»${flip}`);
}
console.log("\n分档命中率（词面独跑 → 语义混合）：");
for (const [tier, t] of byTier) {
  const h2 = hyByTier.get(tier)!;
  console.log(`  ${tier}: ${t.h}/${t.n} → ${h2.h}/${h2.n}`);
}
console.log(`\n总计 hit@1: 词面 ${hit}/${CASES.length} = ${((hit / CASES.length) * 100).toFixed(0)}% → 混合 ${hyHit}/${CASES.length} = ${((hyHit / CASES.length) * 100).toFixed(0)}%`);

let rejectOk = 0;
for (const n of NEGATIVES) {
  const win = resolveQueryWindow(buildContentMap(n.doc), n.doc, n.query, BUDGET);
  const score = win ? "出窗(误命中)" : "null(正确拒绝)";
  if (!win) rejectOk++;
  console.log(`${score}  «${n.query}»`);
}
console.log(`无关 query 正确拒绝: ${rejectOk}/${NEGATIVES.length}`);
console.log("\n注：MISS/null 时系统自动回退旧线性翻页路径（能力兜底，不劣于优化前）。");
