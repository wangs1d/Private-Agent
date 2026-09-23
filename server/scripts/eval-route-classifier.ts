/**
 * L1 路由分类器黄金集评测（2026-09-23 工具自决权改造配套）。
 *
 * 真实组件：loadServerEnv + createExternalChatProviderFromEnv + routeTurnByLlm。
 * 唯一被测对象 = 语义路由分类器（真实 LLM 调用，无 mock）。
 *
 * 期望以「面 + 是否允许触发 web 前置检索」表达，而非具体标签——这样标签集
 * 演进（如 2026-09-23 新增 personal_data_query）前后仍可同表对比：
 *   - plane 期望：该轮应落对话面（直答/前台直办）还是任务面（后台执行）；
 *   - noWeb 期望：该轮绝不应被判成 realtime_lookup（realtime_lookup 会触发
 *     web 前置检索——个人数据查询/显式禁网轮判成它 = 烧错误搜索）。
 *
 * 用法：
 *   npx tsx scripts/eval-route-classifier.ts --label=baseline --out=results/route-baseline.json
 *   npx tsx scripts/eval-route-classifier.ts --label=after --out=results/route-after.json
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));

type Case = {
  text: string;
  expectPlane: "chat" | "task";
  /** true = 本轮绝不能被判成 realtime_lookup（判成即触发 web 前置检索） */
  expectNoWeb?: boolean;
  note?: string;
};

// 黄金用例：全部来自真实用户流量或真实误判事故（2026-09-22 日志取证）。
const CASES: Case[] = [
  // ── 纯闲聊（必须落对话面）──
  { text: "在吗", expectPlane: "chat" },
  { text: "今天有点烦，不想干活", expectPlane: "chat" },
  { text: "你觉得周末宅家好还是出去走走好", expectPlane: "chat" },
  { text: "你是谁", expectPlane: "chat" },
  // ── 实时事实（必须落任务面，realtime_lookup 允许）──
  { text: "刘浩存最近有什么新动态", expectPlane: "task" },
  { text: "贵州兴义明天天气怎么样", expectPlane: "task" },
  { text: "比特币现在什么价", expectPlane: "task" },
  { text: "人民币兑美元最近汇率走势如何", expectPlane: "task" },
  { text: "给我找几张刘浩存的高清照片", expectPlane: "task" },
  { text: "最近有什么值得看的新电影上映", expectPlane: "task" },
  // ── 个人数据查询（对话面 + 禁 web 前置检索；真实事故：订单查询被判 realtime 烧搜索）──
  { text: "看看我最近的购物订单到哪了", expectPlane: "chat", expectNoWeb: true },
  { text: "我明天有什么日程", expectPlane: "chat", expectNoWeb: true },
  { text: "我钱包余额还有多少", expectPlane: "chat", expectNoWeb: true },
  { text: "把我微信里小王发的最后一条消息念给我听", expectPlane: "chat", expectNoWeb: true },
  // ── 写动作（对话面直办，禁 web）──
  { text: "帮我设个明天早上8点的提醒", expectPlane: "chat", expectNoWeb: true },
  // ── 显式禁网（真实事故：「不要联网」轮被降级任务面拿原话当搜索词）──
  { text: "不要联网。列出搬家要带的8样物品，每样一行", expectPlane: "chat", expectNoWeb: true },
  // ── 常识/知识问答（对话面；是否触网不设硬期望，只看面）──
  { text: "为什么天空是蓝色的", expectPlane: "chat" },
  { text: "帮我总结一下刚才说的搬家清单的重点", expectPlane: "chat" },
  { text: "你会做什么", expectPlane: "chat" },
  // ── 多步/设备（任务面）──
  { text: "帮我把电脑上的Chrome打开然后截图", expectPlane: "task" },
];

type Row = Case & {
  intent?: string;
  confidence?: number;
  searchQuery?: string;
  planeOk: boolean;
  noWebOk: boolean;
  ms: number;
};

async function main(): Promise<void> {
  const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
  const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[route-eval] 外部模型 provider 未启用，无法评测");
    process.exit(1);
  }
  console.log(`[route-eval] provider=${provider.id} cases=${CASES.length}`);

  const rows: Row[] = [];
  for (const c of CASES) {
    const t0 = Date.now();
    let intent = "";
    let confidence = 0;
    let plane: "chat" | "task" = "chat";
    let searchQuery: string | undefined;
    try {
      const d = await routeTurnByLlm(provider, "route-eval-session", c.text, []);
      intent = d.intent ?? "";
      confidence = d.confidence ?? 0;
      plane = d.plane;
      searchQuery = d.searchQuery;
    } catch (err) {
      console.error(`[route-eval] 用例失败：${c.text} → ${err instanceof Error ? err.message : err}`);
    }
    const ms = Date.now() - t0;
    const planeOk = plane === c.expectPlane;
    const noWebOk = !c.expectNoWeb || intent !== "realtime_lookup";
    rows.push({ ...c, intent, confidence, searchQuery, planeOk, noWebOk, ms });
    const mark = planeOk && noWebOk ? "✔" : "✖";
    console.log(
      ` ${mark} ${(c.text).slice(0, 26).padEnd(28)} → ${intent || "?"}@${confidence.toFixed(2)} plane=${plane}` +
        `${searchQuery ? ` q="${searchQuery.slice(0, 24)}"` : ""}（${ms}ms）` +
        `${planeOk ? "" : ` 期望plane=${c.expectPlane}`}${noWebOk ? "" : " ⚠不应触网"}`,
    );
  }

  const planeAcc = rows.filter((r) => r.planeOk).length / rows.length;
  const noWebViolations = rows.filter((r) => !r.noWebOk).length;
  const passAll = rows.filter((r) => r.planeOk && r.noWebOk).length / rows.length;
  const avgMs = Math.round(rows.reduce((n, r) => n + r.ms, 0) / rows.length);
  const summary = {
    label: process.env.EVAL_LABEL ?? "run",
    total: rows.length,
    planeAccuracy: Number(planeAcc.toFixed(3)),
    noWebViolations,
    passRate: Number(passAll.toFixed(3)),
    avgLatencyMs: avgMs,
    at: new Date().toISOString(),
  };
  console.log("\n=== 汇总 ===");
  console.log(JSON.stringify(summary, null, 2));

  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  if (out) {
    const path = out.includes("/") || out.includes("\\") ? out : join(scriptDir, out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ summary, rows }, null, 2), "utf8");
    console.log(`[route-eval] 已保存 ${path}`);
  }
}

void main();
