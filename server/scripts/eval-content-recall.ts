/**
 * 内容定向读取 QA 回归（WP0 基线 / WP1 验收，2026-09-17 建）。
 *
 * 度量问题：给定「文档 + 问题 + 预算字符数」，答案所需的目标事实能否进入
 * 返回给模型的窗口？
 *   - baseline = head-trim（现状：fetch_web/read_file 等「从头截 N 字符」）
 *   - map-jump = WP1（buildContentMap + resolveQueryWindow 按问题定向跳转）
 *
 * 纯确定性、零 LLM 调用：目标事实是预置字符串，命中 = 窗口切片 contains。
 * 防幻觉验收口径：map-jump 命中率不应低于 baseline，且平均返回窗口更小
 * （同等预算下信息密度更高）。新增语料时保持「目标事实必须位于头部预算之外」
 * 才有区分度（用于回归 WP2 偏置压缩时同样适用）。
 *
 * 用法：npx tsx scripts/eval-content-recall.ts [--budget 1200]
 */
import "dotenv/config";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const BUDGET = Math.max(200, Number(arg("budget", "1200")));

interface Case {
  name: string;
  doc: string;
  query: string;
  /** 答案所需的目标事实（必须能在一页窗口内回答）。 */
  mustContain: string;
}

function pad(text: string, width: number): string {
  return text + "·".repeat(Math.max(0, width - text.length));
}

/** 构造长填充：目标事实藏在第 skip 段之后（头部预算截不到）。 */
function buildMarkdownDoc(): string {
  const sections = [
    "## 产品简介",
    `这是一款面向个人用户的智能助理产品。${"简".repeat(600)}`,
    "## 常见问题",
    `支持多端同步与语音输入。${"问".repeat(600)}`,
    "## 退款政策",
    "退款规则：购买后 7 天内可无理由全额退款，超过 7 天收取 10% 手续费。",
    `${"退".repeat(600)}`,
    "## 联系方式",
    `客服工作时间 9:00-21:00。${"联".repeat(600)}`,
  ];
  return ["# 服务条款", ...sections].join("\n");
}

function buildJsonDoc(): string {
  const items = Array.from({ length: 40 }, (_, i) => ({
    title: `结果${i}：常规资讯` + "流".repeat(60),
    snippet: "每日热点摘要" + "流".repeat(150),
    url: `https://example.com/news/${i}`,
  }));
  items[37] = {
    title: "结果37：上海公积金新政策",
    snippet: "缴存基数上限调整为 36549 元，7 月 1 日起执行。",
    url: "https://example.com/news/gjj-2026",
  };
  return JSON.stringify({ ok: true, query: "公积金", items });
}

function buildCsvDoc(): string {
  const rows = ["航班号,出发,到达,状态"];
  for (let i = 1; i <= 600; i++) {
    rows.push(
      i === 540
        ? "MU5137,上海浦东,法兰克福,延误 2 小时"
        : `CZ${1000 + i},城市${i},城市${(i % 40) + 1},正常`,
    );
  }
  return rows.join("\n");
}

function buildTextDoc(): string {
  const paras = [
    "会议纪要：本周同步了项目进展。",
    ...Array.from({ length: 12 }, (_, i) => `议题${i}：常规讨论内容` + "常".repeat(180)),
    "议题13：预算决议——Q4 市场预算上调至 120 万元，需财务复核。",
    ...Array.from({ length: 6 }, (_, i) => `议题1${4 + i}：后续安排` + "排".repeat(180)),
  ];
  return paras.join("\n\n");
}

function buildCodeDoc(): string {
  const fns: string[] = [];
  for (let i = 0; i < 30; i++) {
    fns.push(`export function helper${i}(x: number): number {\n  return x + ${i}; // ${"注".repeat(20)}\n}\n`);
    if (i === 21) {
      fns.push("export function refundFee(days: number): number {\n  return days <= 7 ? 0 : 0.1; // 7 天内免手续费\n}\n");
    }
  }
  return fns.join("\n");
}

const CASES: Case[] = [
  {
    name: "markdown 退款政策（目标在第 3 节）",
    doc: buildMarkdownDoc(),
    query: "退款手续费多少",
    mustContain: "7 天内可无理由全额退款",
  },
  {
    name: "json 搜索结果（目标在第 37 条）",
    doc: buildJsonDoc(),
    query: "公积金 缴存基数",
    mustContain: "36549",
  },
  {
    name: "csv 航班表（目标在第 540 行）",
    doc: buildCsvDoc(),
    query: "MU5137 法兰克福 状态",
    mustContain: "延误 2 小时",
  },
  {
    name: "text 会议纪要（目标在议题13）",
    doc: buildTextDoc(),
    query: "预算决议 市场预算",
    mustContain: "120 万元",
  },
  {
    name: "code 源码（目标 refundFee）",
    doc: buildCodeDoc(),
    query: "refundFee 手续费",
    mustContain: "days <= 7 ? 0 : 0.1",
  },
];

async function main(): Promise<void> {
  const { buildContentMap, resolveQueryWindow } = await import(
    "../src/external-model/content-map.js"
  );

  let baseHit = 0;
  let jumpHit = 0;
  const results: Array<{ name: string; base: boolean; jump: boolean; baseChars: number; jumpChars: number; kind: string }> = [];

  for (const c of CASES) {
    const baseSlice = c.doc.slice(0, BUDGET);
    const base = baseSlice.includes(c.mustContain);
    const map = buildContentMap(c.doc);
    const win = resolveQueryWindow(map, c.doc, c.query, BUDGET);
    const jumpSlice = win ? c.doc.slice(win.offset, win.offset + win.chars) : "";
    const jump = jumpSlice.includes(c.mustContain);
    if (base) baseHit++;
    if (jump) jumpHit++;
    results.push({
      name: c.name,
      base,
      jump,
      baseChars: Math.min(BUDGET, c.doc.length),
      jumpChars: jumpSlice.length,
      kind: map.kind,
    });
  }

  console.log(`\n# eval-content-recall（预算 ${BUDGET} 字符，${CASES.length} 个用例）\n`);
  console.log("baseline(head-trim)  map-jump(WP1)  base_chars  jump_chars  kind  case");
  console.log("-".repeat(90));
  for (const r of results) {
    const mark = (b: boolean) => (b ? "HIT " : "MISS");
    console.log(
      mark(r.base).padEnd(19) +
        mark(r.jump).padEnd(14) +
        String(r.baseChars).padStart(10) +
        String(r.jumpChars).padStart(12) +
        `  ${pad(r.kind, 5)}  ${r.name}`,
    );
  }
  console.log("-".repeat(90));
  console.log(
    `命中率  baseline=${baseHit}/${CASES.length}  map-jump=${jumpHit}/${CASES.length}` +
      `  |  验收口径：map-jump 命中率 ≥ baseline，且 jump_chars 均值 ≤ base_chars`,
  );
  const avgJump = results.reduce((s, r) => s + r.jumpChars, 0) / results.length;
  console.log(
    `平均窗口  baseline=${(results.reduce((s, r) => s + r.baseChars, 0) / results.length).toFixed(0)}  map-jump=${avgJump.toFixed(0)}`,
  );

  if (jumpHit < baseHit) {
    console.error("\n[FAIL] map-jump 命中率低于 baseline——WP1 定向读取存在回归，禁止合入");
    process.exit(1);
  }
  console.log("\n[PASS] 定向读取未回归基线");
}

void main();
