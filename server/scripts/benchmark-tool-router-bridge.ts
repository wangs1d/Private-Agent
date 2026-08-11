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
  invalidateFullCatalogCache,
  prepareToolsWithToolSearch,
} from "../src/tools/tool-search/index.js";
import {
  prewarmToolRouterCatalog,
  searchDeferredToolsViaToolRouter,
  shutdownToolRouterWorker,
} from "../src/tools/tool-search/tool-router-adapter.js";

const QUERIES = [
  "what time is it now",
  "weather forecast for my location",
  "search web for latest AI news",
  "list browser tabs",
  "list my custom skills",
  "check my wallet balance",
  "run desktop automation task script",
  "register an agent in the world registry",
];

const ENV_OVERRIDES: Record<string, string> = {
  AGENT_TOOL_SEARCH_ENABLED: "on",
  AGENT_TOOL_SEARCH_EMBEDDING: "off",
  AGENT_TOOL_SEARCH_BACKEND: "tool_router",
};

async function main(): Promise<void> {
  const restoreEnv = applyEnvOverrides();
  try {
    invalidateBuiltinToolsCache();
    invalidateFullCatalogCache();

    const pythonBin = detectBundledPython();
    if (pythonBin) process.env.TOOL_ROUTER_PYTHON_BIN = pythonBin;

    const allTools = getBuiltinAgentChatTools();
    const prepared = prepareToolsWithToolSearch([], allTools);

    shutdownToolRouterWorker();
    const coldLatency = await timeSearch(prepared.deferredCatalog, QUERIES[0] ?? "what time is it now", "cold-start");

    shutdownToolRouterWorker();
    const prewarmStarted = performance.now();
    await prewarmToolRouterCatalog(prepared.deferredCatalog, { tenantId: "default", environment: "prod" });
    const prewarmMs = performance.now() - prewarmStarted;
    const warmedFirstLatency = await timeSearch(prepared.deferredCatalog, QUERIES[0] ?? "what time is it now", "post-prewarm");

    const latencies: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const query of QUERIES) {
        latencies.push(await timeSearch(prepared.deferredCatalog, query, `warm-${round}`));
      }
    }

    const p = percentiles(latencies);
    console.log("Tool-router bridge benchmark");
    console.log("=".repeat(72));
    console.log(`catalog.total=${prepared.deferredCatalog.entries.length}`);
    console.log(`cold_start_ms=${coldLatency.toFixed(2)}`);
    console.log(`prewarm_ms=${prewarmMs.toFixed(2)}`);
    console.log(`post_prewarm_first_query_ms=${warmedFirstLatency.toFixed(2)}`);
    console.log(
      `resident_latency_ms p50=${p.p50.toFixed(2)} p95=${p.p95.toFixed(2)} p99=${p.p99.toFixed(2)} max=${p.max.toFixed(2)}`,
    );
  } finally {
    shutdownToolRouterWorker();
    restoreEnv();
    invalidateBuiltinToolsCache();
    invalidateFullCatalogCache();
  }
}

async function timeSearch(
  catalog: ReturnType<typeof prepareToolsWithToolSearch>["deferredCatalog"],
  query: string,
  agentContextHash: string,
): Promise<number> {
  const t0 = performance.now();
  await searchDeferredToolsViaToolRouter(catalog, query, 5, {
    tenantId: "default",
    agentContextHash,
  });
  return performance.now() - t0;
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

function applyEnvOverrides(): () => void {
  const backup = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
    backup.set(key, process.env[key]);
    process.env[key] = value;
  }
  const previousPython = process.env.TOOL_ROUTER_PYTHON_BIN;
  return () => {
    for (const [key, value] of backup.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
