import "../src/config/load-server-env.js";

import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getBuiltinAgentChatTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import {
  executeToolSearchBridge,
  invalidateFullCatalogCache,
  prepareToolsWithToolSearch,
} from "../src/tools/tool-search/index.js";
import { exportCatalogToToolRouter } from "../src/tools/tool-search/tool-router-export.js";
import { shutdownToolRouterWorker } from "../src/tools/tool-search/tool-router-adapter.js";

type RecallCase = {
  registryName: string;
  query: string;
};

type Match = {
  name: string;
  score?: number;
  resource_type?: string;
};

type BackendResult = {
  backend: "adaptive" | "tool_router";
  cases: number;
  top1: number;
  top5: number;
  latencies: number[];
  details: Array<{
    expected: string;
    top1: boolean;
    top5: boolean;
    latencyMs: number;
    hits: string[];
  }>;
};

const CASES: RecallCase[] = [
  { registryName: "clock.get_current_time", query: "what time is it now" },
  { registryName: "clock.get_date", query: "what is today's date" },
  { registryName: "weather.get_local", query: "weather forecast for my location" },
  { registryName: "calendar.list_tasks", query: "list my todo tasks" },
  { registryName: "search_web", query: "search web for latest AI news" },
  { registryName: "fetch_web", query: "read this web page content" },
  { registryName: "browser.session.list", query: "list browser tabs" },
  { registryName: "agent.query_capabilities", query: "what tools and capabilities can you use" },
  { registryName: "phone.call_user", query: "call me to remind me" },
  { registryName: "budget.calculate", query: "calculate my monthly budget" },
  { registryName: "shopping.suggest", query: "recommend a laptop to buy" },
  { registryName: "self.list_custom_skills", query: "list my custom skills" },
  { registryName: "calendar.create_task", query: "create a calendar task for tomorrow" },
  { registryName: "calendar.create_from_text", query: "extract schedule from this text" },
  { registryName: "reminder.plan", query: "set a reminder in ten minutes" },
  { registryName: "agent.send_to_peer", query: "send this message to another agent" },
  { registryName: "agent.link.send_friend_request", query: "send another agent a friend request" },
  { registryName: "agent.link.list_friends", query: "list my agent friends" },
  { registryName: "wallet.get_balance", query: "check my wallet balance" },
  { registryName: "wallet.get_transactions", query: "show recent wallet transactions" },
  { registryName: "aip.dispatch", query: "dispatch an AIP protocol request" },
  { registryName: "embodiment.window_place", query: "place avatar window at position" },
  { registryName: "embodiment.roam", query: "let avatar roam around" },
  { registryName: "desktop.run_automation", query: "run desktop automation task script" },
  { registryName: "desktop.run_shell", query: "execute a shell command" },
  { registryName: "world.open_registry.agent_quick", query: "register an agent in the world registry" },
];

const ENV_OVERRIDES: Record<string, string> = {
  AGENT_TOOL_SEARCH_ENABLED: "on",
  AGENT_TOOL_SEARCH_EMBEDDING: "off",
};

async function main(): Promise<void> {
  const restoreEnv = applyEnvOverrides();
  try {
    invalidateBuiltinToolsCache();
    invalidateFullCatalogCache();

    const allTools = getBuiltinAgentChatTools();
    const prepared = prepareToolsWithToolSearch([], allTools);
    const migrated = exportCatalogToToolRouter(prepared.deferredCatalog, {
      tenantId: "default",
      environment: "prod",
    });

    console.log("Tool-router real catalog migration summary");
    console.log("=".repeat(72));
    console.log(`resources.total=${migrated.summary.total}`);
    console.log(`resource_types=${JSON.stringify(migrated.summary.resource_types)}`);

    const adaptive = await benchmarkBackend("adaptive", prepared);
    const toolRouter = await benchmarkBackend("tool_router", prepared);

    printBackend(adaptive);
    printBackend(toolRouter);
    printComparison(adaptive, toolRouter);
  } finally {
    restoreEnv();
    invalidateBuiltinToolsCache();
    invalidateFullCatalogCache();
    shutdownToolRouterWorker();
  }
}

async function benchmarkBackend(
  backend: "adaptive" | "tool_router",
  prepared: ReturnType<typeof prepareToolsWithToolSearch>,
): Promise<BackendResult> {
  process.env.AGENT_TOOL_SEARCH_BACKEND = backend;
  if (backend === "tool_router") {
    const pythonBin = detectBundledPython();
    if (pythonBin) process.env.TOOL_ROUTER_PYTHON_BIN = pythonBin;
    await executeToolSearchBridge(
      "tool_discover",
      { query: "warm the tool router search path", limit: 1, tenant_id: "default", agent_context_hash: "warmup" },
      prepared.deferredCatalog,
    );
  }
  const details: BackendResult["details"] = [];
  const latencies: number[] = [];
  let top1 = 0;
  let top5 = 0;

  for (const recallCase of CASES) {
    const t0 = performance.now();
    const result = await executeToolSearchBridge(
      "tool_discover",
      { query: recallCase.query, limit: 5, tenant_id: "default", agent_context_hash: `compare-${backend}` },
      prepared.deferredCatalog,
    );
    const latencyMs = performance.now() - t0;
    latencies.push(latencyMs);
    const matches =
      result.ok && result.kind === "discover"
        ? (((result.result as { matches?: Match[] }).matches ?? []) as Match[])
        : [];
    const names = matches.map((match) => match.name);
    const isTop1 = names[0] === recallCase.registryName;
    const isTop5 = names.slice(0, 5).includes(recallCase.registryName);
    top1 += Number(isTop1);
    top5 += Number(isTop5);
    details.push({
      expected: recallCase.registryName,
      top1: isTop1,
      top5: isTop5,
      latencyMs,
      hits: names.slice(0, 5),
    });
  }

  return {
    backend,
    cases: CASES.length,
    top1,
    top5,
    latencies,
    details,
  };
}

function printBackend(result: BackendResult): void {
  console.log("");
  console.log(`${result.backend} backend`);
  console.log("-".repeat(72));
  console.log(`cases=${result.cases}`);
  console.log(`top1=${result.top1}/${result.cases} (${pct(result.top1, result.cases)})`);
  console.log(`top5=${result.top5}/${result.cases} (${pct(result.top5, result.cases)})`);
  const p = percentiles(result.latencies);
  console.log(
    `latency_ms p50=${p.p50.toFixed(2)} p95=${p.p95.toFixed(2)} p99=${p.p99.toFixed(2)} max=${p.max.toFixed(2)}`,
  );
}

function printComparison(adaptive: BackendResult, toolRouter: BackendResult): void {
  const ap = percentiles(adaptive.latencies);
  const tp = percentiles(toolRouter.latencies);
  console.log("");
  console.log("comparison");
  console.log("-".repeat(72));
  console.log(`top1_delta=${toolRouter.top1 - adaptive.top1}`);
  console.log(`top5_delta=${toolRouter.top5 - adaptive.top5}`);
  console.log(`p50_delta_ms=${(tp.p50 - ap.p50).toFixed(2)}`);
  console.log(`p95_delta_ms=${(tp.p95 - ap.p95).toFixed(2)}`);
  console.log(`p99_delta_ms=${(tp.p99 - ap.p99).toFixed(2)}`);
}

function percentiles(values: number[]): { p50: number; p95: number; p99: number; max: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: pick(sorted, 0.5),
    p95: pick(sorted, 0.95),
    p99: pick(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function pick(sorted: number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
}

function pct(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

function applyEnvOverrides(): () => void {
  const backup = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
    backup.set(key, process.env[key]);
    process.env[key] = value;
  }
  const previousBackend = process.env.AGENT_TOOL_SEARCH_BACKEND;
  const previousPython = process.env.TOOL_ROUTER_PYTHON_BIN;
  return () => {
    for (const [key, value] of backup.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousBackend === undefined) delete process.env.AGENT_TOOL_SEARCH_BACKEND;
    else process.env.AGENT_TOOL_SEARCH_BACKEND = previousBackend;
    if (previousPython === undefined) delete process.env.TOOL_ROUTER_PYTHON_BIN;
    else process.env.TOOL_ROUTER_PYTHON_BIN = previousPython;
  };
}

function detectBundledPython(): string | null {
  const candidate = join(
    homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    process.platform === "win32" ? "python.exe" : "bin/python3",
  );
  return existsSync(candidate) ? candidate : null;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
