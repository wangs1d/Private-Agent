import "../src/config/load-server-env.js";

import { performance } from "node:perf_hooks";

import {
  getBuiltinAgentChatTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import { resolveChatToolPlanForStream } from "../src/external-model/resolve-chat-tools.js";
import {
  executeToolSearchBridge,
  invalidateFullCatalogCache,
  prepareToolsWithToolSearch,
  summarizeAdaptiveCatalog,
} from "../src/tools/tool-search/index.js";
import { shutdownToolRouterWorker } from "../src/tools/tool-search/tool-router-adapter.js";

type RecallCase = {
  registryName: string;
  query: string;
};

type Match = {
  name: string;
  score?: number;
  resource_type?: string;
  domain?: string[];
  capability?: string[];
};

type RecallResult = {
  case: RecallCase;
  targetAvailable: boolean;
  visible: boolean;
  top1: boolean;
  top5: boolean;
  latencyMs: number;
  hits: Match[];
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
  DESKTOP_VISUAL_ENABLED: "1",
  DESKTOP_BRIDGE_ENABLED: "1",
  DESKTOP_BRIDGE_TOKEN: "test-bridge-token-12345678",
  PHONE_BRIDGE_ENABLED: "1",
  PHONE_BRIDGE_TOKEN: "test-phone-token-12345678",
};

async function main(): Promise<void> {
  const restoreEnv = applyEnvOverrides();
  try {
    invalidateBuiltinToolsCache();
    invalidateFullCatalogCache();

    const allTools = getBuiltinAgentChatTools();
    const allToolNames = new Set(
      allTools
        .map((tool) => (tool.type === "function" ? tool.function.name : ""))
        .filter(Boolean),
    );
    const availableCases = CASES.filter((item) => allToolNames.has(item.registryName));
    const skippedCases = CASES.filter((item) => !allToolNames.has(item.registryName));

    const preparedAll = prepareToolsWithToolSearch([], allTools);
    const tIndex0 = performance.now();
    const summary = summarizeAdaptiveCatalog(preparedAll.deferredCatalog);
    const indexMs = performance.now() - tIndex0;

    console.log("Adaptive tool search recall/speed test");
    console.log("=".repeat(72));
    console.log(`tools.total=${allTools.length}`);
    console.log(`deferred.total=${preparedAll.deferredCatalog.entries.length}`);
    console.log(`adaptive.index_build_ms=${indexMs.toFixed(2)}`);
    console.log(`resource_types=${JSON.stringify(summary.resource_types)}`);
    console.log(`top_domains=${JSON.stringify(topEntries(summary.domains, 10))}`);
    if (skippedCases.length > 0) {
      console.log(`skipped_missing_cases=${skippedCases.map((c) => c.registryName).join(",")}`);
    }

    const allDeferred = await runAllDeferredRecall(availableCases, preparedAll.deferredCatalog);
    printRecallBlock("All-deferred adaptive bridge recall", allDeferred);

    const contextual = await runContextualProductionRecall(availableCases);
    printRecallBlock("Contextual production bridge recall", contextual);
  } finally {
    restoreEnv();
    invalidateBuiltinToolsCache();
    shutdownToolRouterWorker();
  }
}

async function runAllDeferredRecall(
  cases: RecallCase[],
  catalog: ReturnType<typeof prepareToolsWithToolSearch>["deferredCatalog"],
): Promise<RecallResult[]> {
  const results: RecallResult[] = [];
  for (const recallCase of cases) {
    const measured = await discover(catalog, recallCase.query);
    results.push({
      case: recallCase,
      targetAvailable: true,
      visible: false,
      top1: measured.hits[0]?.name === recallCase.registryName,
      top5: measured.hits.some((hit) => isMatch(hit.name, recallCase.registryName)),
      latencyMs: measured.latencyMs,
      hits: measured.hits,
    });
  }
  return results;
}

async function runContextualProductionRecall(cases: RecallCase[]): Promise<RecallResult[]> {
  const results: RecallResult[] = [];
  for (const recallCase of cases) {
    const plan = resolveChatToolPlanForStream(recallCase.query, {
      toolExposureProfile: "contextual",
    });
    const visible = plan.visibleTools.some((tool) =>
      tool.type === "function" && isMatch(tool.function.name, recallCase.registryName),
    );
    if (visible) {
      results.push({
        case: recallCase,
        targetAvailable: true,
        visible: true,
        top1: true,
        top5: true,
        latencyMs: 0,
        hits: [],
      });
      continue;
    }
    const prepared = prepareToolsWithToolSearch(plan.visibleTools, plan.searchableTools);
    const targetAvailable = prepared.deferredCatalog.entries.some((entry) =>
      isMatch(entry.registryName, recallCase.registryName),
    );
    const measured = await discover(prepared.deferredCatalog, recallCase.query);
    results.push({
      case: recallCase,
      targetAvailable,
      visible: false,
      top1: measured.hits[0]?.name === recallCase.registryName,
      top5: measured.hits.some((hit) => isMatch(hit.name, recallCase.registryName)),
      latencyMs: measured.latencyMs,
      hits: measured.hits,
    });
  }
  return results;
}

async function discover(
  catalog: ReturnType<typeof prepareToolsWithToolSearch>["deferredCatalog"],
  query: string,
): Promise<{ hits: Match[]; latencyMs: number }> {
  const t0 = performance.now();
  const result = await executeToolSearchBridge(
    "tool_discover",
    { query, limit: 5 },
    catalog,
  );
  const latencyMs = performance.now() - t0;
  if (!result.ok || result.kind !== "discover") return { hits: [], latencyMs };
  const payload = result.result as { matches?: Match[] };
  return { hits: payload.matches ?? [], latencyMs };
}

function printRecallBlock(title: string, results: RecallResult[]): void {
  const evaluated = results.filter((r) => r.targetAvailable);
  const top1 = evaluated.filter((r) => r.top1).length;
  const top5 = evaluated.filter((r) => r.top5).length;
  const visible = evaluated.filter((r) => r.visible).length;
  const latencies = evaluated.filter((r) => !r.visible).map((r) => r.latencyMs);
  const p = percentiles(latencies);

  console.log("");
  console.log(title);
  console.log("-".repeat(72));
  console.log(`cases=${evaluated.length} visible=${visible}`);
  console.log(`top1=${top1}/${evaluated.length} (${pct(top1, evaluated.length)})`);
  console.log(`top5=${top5}/${evaluated.length} (${pct(top5, evaluated.length)})`);
  console.log(
    `latency_ms p50=${p.p50.toFixed(2)} p95=${p.p95.toFixed(2)} p99=${p.p99.toFixed(2)} max=${p.max.toFixed(2)}`,
  );

  for (const result of evaluated) {
    const status = result.visible
      ? "VISIBLE"
      : result.top1
        ? "TOP1"
        : result.top5
          ? "TOP5"
          : "MISS";
    const hits = result.hits
      .slice(0, 3)
      .map((hit) => `${hit.name}:${hit.score ?? 0}:${hit.resource_type ?? "?"}`)
      .join(" | ");
    console.log(
      `${status.padEnd(7)} ${result.case.registryName.padEnd(34)} ${result.latencyMs.toFixed(2).padStart(7)}ms ${hits}`,
    );
  }
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

function topEntries(input: Record<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  );
}

function isMatch(name: string, target: string): boolean {
  return target.endsWith(".") ? name.startsWith(target) : name === target;
}

function applyEnvOverrides(): () => void {
  const backup = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
    backup.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of backup.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
