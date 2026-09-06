/**
 * tool 召回延迟基准（2026-09-06）。
 *
 * 量化 tool_discover 召回在三种形态下的端到端耗时，给「快速通道 2 波预算」
 * 和容量规划提供数字：
 *
 *   1. 进程内 adaptive（backend=adaptive）：冷启动（含目录/索引构建）与热查询
 *      p50/p95——这是熔断/降级后的真实路径，也是预算的下界；
 *   2. 死服务降级（backend=tool_router + HTTP 指向拒绝连接端口 + stdio 禁用）：
 *      首查代价（失败+熔断记账）与熔断后代价——量化端点守卫的价值；
 *   3. 真实 primary（TOOL_ROUTER_HTTP_URL 指向活服务时自动探测）：单查延迟分布。
 *
 * 用法：
 *   npx tsx scripts/eval-tool-recall.ts                       # 全部场景
 *   npx tsx scripts/eval-tool-recall.ts --repeat 50           # 加大采样
 *   npx tsx scripts/eval-tool-recall.ts --scenario adaptive   # 只跑一个场景
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || join(tmpdir(), "pa-eval-tool-recall");
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.TOOL_ROUTER_STDIO_DISABLED = "1"; // 基准里绝不 spawn Python

import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const REPEAT = Math.max(3, Number(arg("repeat", "30")));
const SCENARIO = arg("scenario", "all");

function pct(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
const fmt = (ms: number) => `${ms.toFixed(1)}ms`;

async function main(): Promise<void> {
  const { getBuiltinAgentChatTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
    "../src/tools/tool-search/index.js"
  );
  const {
    resetRouterEndpointGuard,
    getRouterEndpointGuard,
  } = await import("../src/tools/tool-search/router-endpoint-guard.js");

  const QUERIES = [
    "北京今天天气怎么样",
    "找几张猫的照片",
    "我在哪个城市",
    "现在几点了",
    "比特币现在什么价",
    "明天早上九点提醒我开会",
    "把客厅的灯打开",
    "看一下门口摄像头",
    "我钱包还有多少钱",
    "今天有什么热搜",
  ];

  // ── 场景 1：进程内 adaptive ──
  if (SCENARIO === "all" || SCENARIO === "adaptive") {
    process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
    resetRouterEndpointGuard();
    const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
    const catalog = prepared.deferredCatalog;

    const t0 = performance.now();
    await executeToolSearchBridge("tool_discover", { query: QUERIES[0]!, limit: 5 }, catalog);
    const coldMs = performance.now() - t0;

    const samples: number[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const q = QUERIES[i % QUERIES.length]!;
      const t = performance.now();
      await executeToolSearchBridge("tool_discover", { query: `${q} #${i}`, limit: 5 }, catalog);
      samples.push(performance.now() - t);
    }
    console.log("=== 场景 1：进程内 adaptive（降级安全路径）===");
    console.log(
      `  工具数: ${catalog.entries.length} | 冷启动(含索引): ${fmt(coldMs)} | 热查询 ${REPEAT} 次: p50=${fmt(pct(samples, 50))} p95=${fmt(pct(samples, 95))} max=${fmt(Math.max(...samples))}`,
    );
    console.log(`  对照：快速通道预算 2 波 ≈ Flash 首 token ~500ms/波，召回 ${fmt(pct(samples, 95))} 占比 <3%`);
    console.log("");
  }

  // ── 场景 2：死服务降级（守卫价值）──
  if (SCENARIO === "all" || SCENARIO === "dead") {
    process.env.AGENT_TOOL_SEARCH_BACKEND = "tool_router";
    process.env.TOOL_ROUTER_HTTP_URL = "http://127.0.0.1:9"; // 拒绝连接
    process.env.TOOL_ROUTER_PRIMARY_FAILURES_TO_OPEN = "2";
    process.env.TOOL_ROUTER_PRIMARY_BUDGET_MS = "1000";
    resetRouterEndpointGuard();
    const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
    const catalog = prepared.deferredCatalog;

    const perQuery: number[] = [];
    for (let i = 0; i < Math.min(6, QUERIES.length); i++) {
      const t = performance.now();
      await executeToolSearchBridge("tool_discover", { query: `${QUERIES[i]} #d${i}`, limit: 5 }, catalog);
      perQuery.push(performance.now() - t);
    }
    const snap = getRouterEndpointGuard().snapshot();
    console.log("=== 场景 2：primary 服务不可用（守卫降级链）===");
    console.log(`  逐查询耗时: ${perQuery.map(fmt).join(" → ")}`);
    console.log(
      `  解读: 第 1-2 次含连接失败+熔断记账（无守卫时这里是 30s HTTP 超时或 Python 冷启动 60s），第 3 次起熔断打开 → 纯进程内延迟`,
    );
    console.log(`  熔断态: ${snap.state} | 连败 ${snap.consecutiveFailures} | 预算中止 ${snap.totalBudgetAborts} 次`);
    console.log("");
    delete process.env.TOOL_ROUTER_HTTP_URL;
    process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
    resetRouterEndpointGuard();
  }

  // ── 场景 3：真实 primary（服务活着才跑）──
  const httpUrl = process.env.TOOL_ROUTER_HTTP_URL?.trim();
  if (httpUrl && (SCENARIO === "all" || SCENARIO === "live")) {
    const alive = await Promise.race([
      fetch(`${httpUrl.replace(/\/$/, "")}/docs`, { signal: AbortSignal.timeout(400) })
        .then((r) => r.ok)
        .catch(() => false),
    ]);
    if (alive) {
      process.env.AGENT_TOOL_SEARCH_BACKEND = "tool_router";
      resetRouterEndpointGuard();
      const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
      const catalog = prepared.deferredCatalog;
      const samples: number[] = [];
      for (let i = 0; i < REPEAT; i++) {
        const q = `${QUERIES[i % QUERIES.length]} #l${i}`;
        const t = performance.now();
        await executeToolSearchBridge("tool_discover", { query: q, limit: 5 }, catalog);
        samples.push(performance.now() - t);
      }
      console.log("=== 场景 3：真实 primary（TOOL_ROUTER_HTTP_URL）===");
      console.log(
        `  ${REPEAT} 次查询: p50=${fmt(pct(samples, 50))} p95=${fmt(pct(samples, 95))} max=${fmt(Math.max(...samples))}`,
      );
      console.log(
        `  判定: p95 若 > 快速通道预算节拍（建议 <300ms），应考虑 ${"AGENT_TOOL_SEARCH_BACKEND=adaptive"} 或调低 TOOL_ROUTER_PRIMARY_BUDGET_MS`,
      );
      process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
      resetRouterEndpointGuard();
    } else {
      console.log("=== 场景 3：真实 primary ===");
      console.log(`  ${httpUrl} 不可达（400ms 探测超时），跳过。启动 tool-router 后可复测。`);
    }
    console.log("");
  }

  console.log("结论模板：召回延迟预算 = 熔断后 p95（进程内）→ 场景 1 数值即下界；primary 可用性由端点守卫保证不劣化用户体验。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
