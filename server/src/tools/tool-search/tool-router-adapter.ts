import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import type { DeferredToolCatalog } from "./catalog.js";
import type { AdaptiveDeferredToolSearchMatch } from "./adaptive-catalog.js";
import { describeDeferredTool } from "./catalog.js";
import { exportCatalogToToolRouter, type ToolRouterExportBundle } from "./tool-router-export.js";
import {
  resolveToolRouterHttpUrl,
  prewarmToolRouterCatalogHttp,
  searchDeferredToolsViaToolRouterHttp,
} from "./tool-router-http-client.js";

type WorkerState = {
  proc: ChildProcessWithoutNullStreams;
  pending: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  catalogSignature: string | null;
  nextId: number;
  initPromise: Promise<void> | null;
  closed: boolean;
};

let workerState: WorkerState | null = null;
const prewarmPromises = new Map<string, Promise<void>>();

// ===== 搜索 TTL 缓存（含在飞行去重）=====
// 相同（目录签名 + query + limit + schema 开关）的检索在 TTL 窗口内直接复用；
// 缓存的是 Promise 而非结果——并发同 query 只打一次 Python 端（预召回与
// tool_discover 桥接同时发起时不会重复排队）。失败不缓存，允许重试。

type SearchCacheEntry = { promise: Promise<AdaptiveDeferredToolSearchMatch[]>; expiresAt: number };
const searchCache = new Map<string, SearchCacheEntry>();
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX = 64;

function catalogCacheKey(catalog: DeferredToolCatalog): string {
  return catalog.entries.map((e) => e.registryName).join(",");
}

/** 测试/调试用：清空搜索缓存（目录变更 / MCP 重连后调用）。 */
export function invalidateToolRouterSearchCache(): void {
  searchCache.clear();
}

function isExpectedWorkerLifecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("tool-router worker shutdown") ||
    message.includes("tool-router worker is not writable") ||
    message.includes("tool-router worker exited")
  );
}

export function searchDeferredToolsViaToolRouter(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: {
    includeSchema?: boolean;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  const cacheKey = `${catalogCacheKey(catalog)}|${query}|${limit}|${options?.includeSchema ? 1 : 0}`;

  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() <= hit.expiresAt) {
    return hit.promise;
  }
  if (hit) {
    searchCache.delete(cacheKey);
  }

  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }

  const promise = searchDeferredToolsViaToolRouterUncached(catalog, query, limit, options).catch(
    (error) => {
      // 失败不缓存：移除后让后续调用重试
      searchCache.delete(cacheKey);
      throw error;
    },
  );
  searchCache.set(cacheKey, { promise, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
  return promise;
}

async function searchDeferredToolsViaToolRouterUncached(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: {
    includeSchema?: boolean;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  // 优先 HTTP REST：独立部署的 FastAPI 服务（配置 TOOL_ROUTER_HTTP_URL 时启用）。
  // 服务不可用（未启动 / 网络失败）时自动回退 stdio bridge_worker 子进程。
  if (resolveToolRouterHttpUrl()) {
    try {
      return await searchDeferredToolsViaToolRouterHttp(catalog, query, limit, options);
    } catch (error) {
      console.warn(
        `[tool-search:tool-router] HTTP 服务调用失败，回退 stdio worker: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  const exported = getExportedCatalog(catalog, {
    tenantId: options?.tenantId ?? "default",
    environment: resolveToolRouterEnvironment(),
  });
  const worker = await ensureWorker();
  await ensureCatalogLoaded(worker, exported);

  const result = await sendWorkerCommand(worker, "search", {
    raw_user_query: query,
    agent_context_hash: options?.agentContextHash ?? "tool-search-bridge",
    tenant_id: options?.tenantId ?? "default",
    environment: resolveToolRouterEnvironment(),
    limit,
  });

  if (!result?.ok) throw new Error(String(result?.error ?? "tool-router search failed"));

  const payload = result.data as {
    parsed_intent: {
      intent: string;
      confidence: number;
      primary_capability: string;
    };
    domain_groups: string[];
    domains: string[];
    capabilities: string[];
    candidates: Array<{
      name: string;
      score: number;
      resource_type: "tool" | "skill" | "mcp_server";
      domain: string;
      capabilities: string[];
      stage_scores?: Record<string, number>;
    }>;
  };

  return payload.candidates.map((candidate) => {
    const schema = options?.includeSchema ? describeDeferredTool(catalog, candidate.name) : null;
    const entry = catalog.byName.get(candidate.name) ?? catalog.byApiName.get(candidate.name.replace(/\./g, "_"));
    return {
      name: candidate.name,
      description:
        (schema?.description as string | undefined) ??
        (entry?.tool.type === "function" ? entry.tool.function.description ?? "" : ""),
      score: candidate.score,
      parameterNames: entry?.parameterNames ?? [],
      requiredParameters: entry?.requiredParameters ?? [],
      parameters: schema
        ? ((schema.parameters as Record<string, unknown> | undefined) ?? {
            type: "object",
            properties: {},
          })
        : undefined,
      resource_type: candidate.resource_type === "mcp_server" ? "mcp_server" : candidate.resource_type,
      domain: [candidate.domain],
      capability: candidate.capabilities,
      routing: {
        intent: payload.parsed_intent.intent,
        confidence: payload.parsed_intent.confidence,
        top_p: topPForConfidence(payload.parsed_intent.confidence),
        domain_groups: payload.domain_groups,
        domain_candidates: payload.domains,
        primary_capability: payload.parsed_intent.primary_capability,
      },
    } satisfies AdaptiveDeferredToolSearchMatch;
  });
}

export function prewarmToolRouterCatalog(
  catalog: DeferredToolCatalog,
  options?: { tenantId?: string; environment?: "dev" | "staging" | "prod" },
): Promise<void> {
  const exported = getExportedCatalog(catalog, {
    tenantId: options?.tenantId ?? "default",
    environment: options?.environment ?? resolveToolRouterEnvironment(),
  });
  // HTTP 模式预加载（服务未配置/未启动时静默跳过，搜索时再回退 stdio）
  if (resolveToolRouterHttpUrl()) {
    prewarmToolRouterCatalogHttp(catalog, options);
  }
  const existing = prewarmPromises.get(exported.signature);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const worker = await ensureWorker();
      await ensureCatalogLoaded(worker, exported);
    } catch (error) {
      if (isExpectedWorkerLifecycleError(error)) return;
      throw error;
    }
  })().finally(() => {
    prewarmPromises.delete(exported.signature);
  });
  prewarmPromises.set(exported.signature, promise);
  return promise;
}

function topPForConfidence(confidence: number): number {
  if (confidence > 0.85) return 0.7;
  if (confidence > 0.6) return 0.9;
  return 0.95;
}

async function ensureWorker(): Promise<WorkerState> {
  const existing = workerState;
  if (existing && !existing.closed && existing.proc.exitCode == null && existing.proc.killed === false) {
    return existing;
  }
  const pythonBin = resolvePythonBin();
  const workerScript = resolveWorkerScript();
  const proc = spawn(pythonBin, [workerScript], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const state: WorkerState = {
    proc,
    pending,
    catalogSignature: null,
    nextId: 1,
    initPromise: null,
    closed: false,
  };

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as { id?: string; ok?: boolean; error?: string };
      const id = message.id;
      if (!id) return;
      const pendingCall = pending.get(id);
      if (!pendingCall) return;
      pending.delete(id);
      if (message.ok === false) pendingCall.reject(new Error(message.error ?? "tool-router worker error"));
      else pendingCall.resolve(message);
    } catch (error) {
      console.warn("[tool-search:tool-router] invalid worker stdout", error);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn("[tool-search:tool-router:stderr]", text);
  });

  proc.stdin.on("error", (error) => {
    if (state.closed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const pendingCall of pending.values()) pendingCall.reject(failure);
    pending.clear();
  });

  proc.on("exit", (code, signal) => {
    state.closed = true;
    const error = new Error(`tool-router worker exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    for (const pendingCall of pending.values()) pendingCall.reject(error);
    pending.clear();
    if (workerState === state) workerState = null;
  });

  workerState = state;
  return state;
}

export function shutdownToolRouterWorker(): void {
  const state = workerState;
  if (!state) return;
  workerState = null;
  state.closed = true;
  try {
    state.proc.stdin.end();
  } catch {
    // ignore
  }
  if (state.proc.exitCode == null && !state.proc.killed) {
    state.proc.kill();
  }
  for (const pending of state.pending.values()) {
    pending.reject(new Error("tool-router worker shutdown"));
  }
  state.pending.clear();
  prewarmPromises.clear();
}

function sendWorkerCommand(
  worker: WorkerState,
  command: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const id = String(worker.nextId++);
  return new Promise((resolve, reject) => {
    if (
      worker.closed ||
      worker.proc.exitCode != null ||
      worker.proc.killed ||
      worker.proc.stdin.destroyed ||
      worker.proc.stdin.writableEnded
    ) {
      reject(new Error("tool-router worker is not writable"));
      return;
    }
    worker.pending.set(id, { resolve, reject });
    try {
      worker.proc.stdin.write(`${JSON.stringify({ id, command, payload })}\n`, "utf8", (error) => {
        if (!error) return;
        worker.pending.delete(id);
        reject(error);
      });
    } catch (error) {
      worker.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function resolveWorkerScript(): string {
  // 1) 显式 TOOL_ROUTER_ROOT 优先
  const explicitRoot = process.env.TOOL_ROUTER_ROOT?.trim();
  if (explicitRoot) {
    const candidate = join(explicitRoot, "scripts", "bridge_worker.py");
    if (existsSync(candidate)) return candidate;
  }
  // 2) 从 cwd 向上逐级查找 <repo>/tool-router/scripts/bridge_worker.py
  //    （server 从 server/ 启动时 cwd 是 server/，仓库根在其上级）
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "tool-router", "scripts", "bridge_worker.py");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 3) 相对本模块位置（src/ 与 dist/ 下均为 tools/tool-search，上溯 4 级到仓库根）
  const viaModule = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "tool-router",
    "scripts",
    "bridge_worker.py",
  );
  if (existsSync(viaModule)) return viaModule;
  throw new Error(
    `bridge_worker.py not found. Tried TOOL_ROUTER_ROOT, cwd walk-up from "${process.cwd()}", and "${viaModule}".`,
  );
}

function resolvePythonBin(): string {
  const candidates = [
    process.env.TOOL_ROUTER_PYTHON_BIN?.trim(),
    process.env.CODEX_PYTHON_BIN?.trim(),
    join(
      homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      process.platform === "win32" ? "python.exe" : "bin/python3",
    ),
    process.platform === "win32" ? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : undefined,
    "python",
    "python3",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if (candidate.includes("\\") || candidate.includes("/")) {
        if (!existsSync(candidate)) continue;
        return candidate;
      }
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("No Python runtime found for tool-router worker");
}

function resolveToolRouterEnvironment(): "dev" | "staging" | "prod" {
  const value = process.env.AGENT_ENV?.trim().toLowerCase();
  if (value === "dev" || value === "staging") return value;
  return "prod";
}

function getExportedCatalog(
  catalog: DeferredToolCatalog,
  options: { tenantId?: string; environment?: "dev" | "staging" | "prod" },
): ToolRouterExportBundle {
  return exportCatalogToToolRouter(catalog, options);
}

async function ensureCatalogLoaded(
  worker: WorkerState,
  exported: ToolRouterExportBundle,
): Promise<void> {
  if (worker.catalogSignature === exported.signature) return;
  if (!worker.initPromise) {
    worker.initPromise = (async () => {
      const initResult = await sendWorkerCommand(worker, "init_catalog", {
        signature: exported.signature,
        resources: exported.resources,
        edges: exported.edges,
      });
      if (!initResult?.ok) throw new Error(String(initResult?.error ?? "tool-router init failed"));
      worker.catalogSignature = exported.signature;
    })().finally(() => {
      worker.initPromise = null;
    });
  }
  await worker.initPromise;
}
