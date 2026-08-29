/**
 * tool-router HTTP REST 集成测试。
 *
 * 前置：tool-router FastAPI 服务已启动（默认 http://127.0.0.1:8787），
 *      可用 `tool-router\start-tool-router.ps1` 或 `uvicorn tool_router.main:app --port 8787` 启动。
 *
 * 验证：TS 端通过 HTTP 客户端（tool-router-http-client.ts）调用 FastAPI 服务——
 *  1. 真实工具目录批量注册（POST /api/catalog/init）
 *  2. 混合检索（POST /api/resource/search）返回候选
 *  3. 覆盖 HTTP 优先 + 失败回退 stdio 的接线
 */
import "../src/config/load-server-env.js";

import { performance } from "node:perf_hooks";

import {
  getBuiltinAgentChatTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import {
  executeToolSearchBridge,
  invalidateFullCatalogCache,
  prepareToolsWithToolSearch,
} from "../src/tools/tool-search/index.js";
import {
  resolveToolRouterHttpUrl,
  prewarmToolRouterCatalogHttp,
  searchDeferredToolsViaToolRouterHttp,
} from "../src/tools/tool-search/tool-router-http-client.js";
import { shutdownToolRouterWorker } from "../src/tools/tool-search/tool-router-adapter.js";

type Match = { name: string; score?: number; resource_type?: string };

const CASES: Array<{ registryName: string; query: string }> = [
  { registryName: "clock.get_current_time", query: "what time is it now" },
  { registryName: "weather.get_local", query: "weather forecast for my location" },
  { registryName: "calendar.list_tasks", query: "list my todo tasks" },
  { registryName: "search_web", query: "search web for latest AI news" },
  { registryName: "phone.call_user", query: "call me to remind me" },
  { registryName: "shopping.suggest", query: "recommend a laptop to buy" },
  { registryName: "reminder.plan", query: "set a reminder in ten minutes" },
  { registryName: "wallet.get_balance", query: "check my wallet balance" },
];

async function main(): Promise<void> {
  const httpUrl = resolveToolRouterHttpUrl();
  if (!httpUrl) {
    console.error(
      "[tool-router-http-test] TOOL_ROUTER_HTTP_URL 未配置。请先启动 FastAPI 服务并设置环境变量，例如:",
      "\n  $env:TOOL_ROUTER_HTTP_URL='http://127.0.0.1:8787'",
      "\n  cd tool-router && python -m uvicorn tool_router.main:app --port 8787",
    );
    process.exit(1);
  }

  invalidateBuiltinToolsCache();
  invalidateFullCatalogCache();

  const allTools = getBuiltinAgentChatTools();
  const prepared = prepareToolsWithToolSearch([], allTools);
  const deferredCatalog = prepared.deferredCatalog;

  console.log(`[tool-router-http-test] 目标服务: ${httpUrl}`);
  console.log(`[tool-router-http-test] 真实工具目录资源数: ${deferredCatalog.entries.length}`);

  // 1) 直接调用 HTTP 客户端：catalog/init + search
  console.log("\n=== 1) HTTP 客户端直调（catalog/init + search）===");
  try {
    await prewarmToolRouterCatalogHttp(deferredCatalog, {
      tenantId: "default",
      environment: "prod",
    });
    const t0 = performance.now();
    const httpMatches = await searchDeferredToolsViaToolRouterHttp(
      deferredCatalog,
      "what time is it now",
      5,
      { tenantId: "default", agentContextHash: "http-test" },
    );
    const latencyMs = performance.now() - t0;
    console.log(`search latency_ms=${latencyMs.toFixed(2)}`);
    console.log(`matches=${JSON.stringify(httpMatches.slice(0, 3).map((m) => ({ name: m.name, score: m.score })))}`);
  } catch (error) {
    console.error("[tool-router-http-test] HTTP 直调失败:", error);
    process.exit(1);
  }

  // 2) 走 executeToolSearchBridge 主链路（HTTP 优先，服务在线时不应回退 stdio）
  console.log("\n=== 2) executeToolSearchBridge 主链路（HTTP 优先）===");
  let top1 = 0;
  let top5 = 0;
  const latencies: number[] = [];
  const details: string[] = [];
  for (const recallCase of CASES) {
    const t0 = performance.now();
    const result = await executeToolSearchBridge(
      "tool_discover",
      { query: recallCase.query, limit: 5, tenant_id: "default", agent_context_hash: `http-e2e-${recallCase.registryName}` },
      deferredCatalog,
    );
    const latencyMs = performance.now() - t0;
    latencies.push(latencyMs);
    const matches = result.ok && result.kind === "discover"
      ? (((result.result as { matches?: Match[] }).matches ?? []) as Match[])
      : [];
    const names = matches.map((match) => match.name);
    top1 += Number(names[0] === recallCase.registryName);
    top5 += Number(names.slice(0, 5).includes(recallCase.registryName));
    details.push(
      `  ${recallCase.registryName.padEnd(32)} top1=${String(names[0] === recallCase.registryName)} top5=${String(
        names.slice(0, 5).includes(recallCase.registryName),
      )} hits=${names.slice(0, 5).join(",") || "(none)"}`,
    );
  }
  console.log(`cases=${CASES.length}`);
  console.log(`top1=${top1}/${CASES.length}`);
  console.log(`top5=${top5}/${CASES.length}`);
  console.log(details.join("\n"));
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  console.log(`latency_ms p50=${pct(0.5).toFixed(2)} p95=${pct(0.95).toFixed(2)} max=${Math.max(...latencies).toFixed(2)}`);

  shutdownToolRouterWorker();
  console.log("\n[tool-router-http-test] 完成");
}

main().catch((error) => {
  console.error("[tool-router-http-test] 失败:", error);
  process.exit(1);
});
