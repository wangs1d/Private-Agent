import type { DeferredToolCatalog } from "./catalog.js";
import type { AdaptiveDeferredToolSearchMatch } from "./adaptive-catalog.js";
import { describeDeferredTool } from "./catalog.js";
import { exportCatalogToToolRouter, type ToolRouterExportBundle } from "./tool-router-export.js";

/**
 * tool-router FastAPI 服务的 HTTP 客户端。
 *
 * 当配置了 `TOOL_ROUTER_HTTP_URL`（如 http://127.0.0.1:8787）时，TS 服务端优先通过
 * HTTP REST 调用独立部署的 Python 微服务；未配置或服务不可用时，调用方回退到
 * stdio bridge_worker 子进程（见 tool-router-adapter.ts）。
 *
 * 协议对齐 FastAPI api.py：
 * - POST /api/catalog/init        批量注册目录（resources + edges，幂等）
 * - POST /api/resource/search     混合检索（intent → hierarchical → hybrid → top-p → KG → rerank）
 * - GET  /api/resource/health-check 健康检查
 */

type HttpWorkerState = {
  baseUrl: string;
  catalogSignature: string | null;
  initPromise: Promise<void> | null;
};

let httpWorkerState: HttpWorkerState | null = null;
const httpPrewarmPromises = new Map<string, Promise<void>>();

function resolveToolRouterEnvironment(): "dev" | "staging" | "prod" {
  const value = process.env.AGENT_ENV?.trim().toLowerCase();
  if (value === "dev" || value === "staging") return value;
  return "prod";
}

/** 读取 HTTP 服务地址；未配置返回 null（此时走 stdio 兜底）。 */
export function resolveToolRouterHttpUrl(): string | null {
  const url = process.env.TOOL_ROUTER_HTTP_URL?.trim();
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

async function request(
  baseUrl: string,
  path: string,
  options?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<any> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options?.method ?? "POST",
      headers: { "content-type": "application/json" },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`tool-router HTTP ${options?.method ?? "POST"} ${path} -> ${response.status}`);
    }
    const payload = (await response.json()) as { ok?: boolean; error?: string; data?: unknown };
    if (payload.ok === false) {
      throw new Error(String(payload.error ?? `tool-router HTTP error at ${path}`));
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

function ensureHttpWorker(): HttpWorkerState {
  const baseUrl = resolveToolRouterHttpUrl()!;
  if (httpWorkerState && httpWorkerState.baseUrl === baseUrl) return httpWorkerState;
  httpWorkerState = { baseUrl, catalogSignature: null, initPromise: null };
  return httpWorkerState;
}

/** HTTP 模式下预加载目录（幂等，按 signature 去重）。 */
export function prewarmToolRouterCatalogHttp(
  catalog: DeferredToolCatalog,
  options?: { tenantId?: string; environment?: "dev" | "staging" | "prod" },
): Promise<void> {
  const baseUrl = resolveToolRouterHttpUrl();
  if (!baseUrl) return Promise.resolve();
  const exported = getExportedCatalog(catalog, {
    tenantId: options?.tenantId ?? "default",
    environment: options?.environment ?? resolveToolRouterEnvironment(),
  });
  const existing = httpPrewarmPromises.get(exported.signature);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const worker = ensureHttpWorker();
      await ensureCatalogLoaded(worker, exported);
    } catch {
      // HTTP 预热失败静默（运行时搜索会回退 stdio）
    }
  })().finally(() => {
    httpPrewarmPromises.delete(exported.signature);
  });
  httpPrewarmPromises.set(exported.signature, promise);
  return promise;
}

async function ensureCatalogLoaded(
  worker: HttpWorkerState,
  exported: ToolRouterExportBundle,
): Promise<void> {
  if (worker.catalogSignature === exported.signature) return;
  if (!worker.initPromise) {
    worker.initPromise = (async () => {
      await request(worker.baseUrl, "/api/catalog/init", {
        method: "POST",
        body: {
          signature: exported.signature,
          resources: exported.resources,
          edges: exported.edges,
        },
      });
      worker.catalogSignature = exported.signature;
    })().finally(() => {
      worker.initPromise = null;
    });
  }
  await worker.initPromise;
}

export async function searchDeferredToolsViaToolRouterHttp(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: {
    includeSchema?: boolean;
    tenantId?: string;
    agentContextHash?: string;
  },
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  const baseUrl = resolveToolRouterHttpUrl();
  if (!baseUrl) {
    throw new Error("TOOL_ROUTER_HTTP_URL is not configured");
  }
  const worker = ensureHttpWorker();
  const exported = getExportedCatalog(catalog, {
    tenantId: options?.tenantId ?? "default",
    environment: resolveToolRouterEnvironment(),
  });
  await ensureCatalogLoaded(worker, exported);

  const data = await request(baseUrl, "/api/resource/search", {
    method: "POST",
    body: {
      raw_user_query: query,
      agent_context_hash: options?.agentContextHash ?? "tool-search-bridge",
      tenant_id: options?.tenantId ?? "default",
      environment: resolveToolRouterEnvironment(),
      limit,
    },
  });

  const payload = data as {
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

  return (payload.candidates ?? []).map((candidate) => {
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
        intent: payload.parsed_intent?.intent ?? "",
        confidence: payload.parsed_intent?.confidence ?? 0.5,
        top_p: topPForConfidence(payload.parsed_intent?.confidence ?? 0.5),
        domain_groups: payload.domain_groups ?? [],
        domain_candidates: payload.domains ?? [],
        primary_capability: payload.parsed_intent?.primary_capability ?? "misc.general",
      },
    } satisfies AdaptiveDeferredToolSearchMatch;
  });
}

function topPForConfidence(confidence: number): number {
  if (confidence > 0.85) return 0.7;
  if (confidence > 0.6) return 0.9;
  return 0.95;
}

function getExportedCatalog(
  catalog: DeferredToolCatalog,
  options: { tenantId?: string; environment?: "dev" | "staging" | "prod" },
): ToolRouterExportBundle {
  return exportCatalogToToolRouter(catalog, options);
}
