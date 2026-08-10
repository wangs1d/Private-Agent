import { createHash } from "node:crypto";

import type { DeferredToolCatalog, DeferredToolEntry } from "./catalog.js";
import { getEntryCategoryNames, TOOL_CATEGORIES } from "./tool-category.js";
import { isRegisteredSkillChatToolName } from "../../skills/skill-openai-bridge.js";

export type ToolRouterExportResource = {
  level1: {
    resource_id: string;
    tenant_id: string;
    resource_type: "tool" | "skill" | "mcp_server";
    name: string;
    description: string;
    domain: string;
    capability: string[];
    tags: string[];
    version: string;
    environment: "dev" | "staging" | "prod";
    status: "online" | "offline" | "maintenance" | "rate_limited";
    base_score: number;
    embedding: number[];
    latency_ms: number;
    created_at: string;
  };
  level2: {
    input_type: string;
    output_type: string;
    use_cases: string[];
    limitations: string[];
    preconditions: string[];
    dependencies: string[];
  };
  level3: {
    tool?: { parameters: Record<string, unknown>; required: string[]; timeout_ms: number } | null;
    skill?: {
      workflow: string[];
      child_resources: string[];
      retry_policy: Record<string, unknown>;
      fallback_resources: string[];
    } | null;
    mcp_server?: {
      transport: string;
      endpoint: string;
      rpc_methods: string[];
      auth_config: Record<string, unknown>;
      connection_pool: Record<string, unknown>;
      heartbeat_interval_seconds: number;
    } | null;
  };
  auth_level: "guest" | "default" | "admin";
  history_success_score: number;
  failure_penalty: number;
  latency_score: number;
  consecutive_failures: number;
};

export type ToolRouterExportBundle = {
  signature: string;
  resources: ToolRouterExportResource[];
  edges: Array<{ source_id: string; target_id: string; relation: string; weight: number }>;
  summary: { total: number; resource_types: Record<string, number> };
};

const exportCache = new Map<string, ToolRouterExportBundle>();

export function exportCatalogToToolRouter(
  catalog: DeferredToolCatalog,
  options?: { tenantId?: string; environment?: "dev" | "staging" | "prod" },
): ToolRouterExportBundle {
  const tenantId = options?.tenantId ?? "default";
  const environment = options?.environment ?? "prod";
  const signature = `${catalogSignature(catalog)}|${tenantId}|${environment}`;
  const cached = exportCache.get(signature);
  if (cached) return cached;
  const resources = catalog.entries.map((entry) => exportEntryToResource(entry, tenantId, environment));
  const resourceTypes: Record<string, number> = {};
  for (const resource of resources) {
    const type = resource.level1.resource_type;
    resourceTypes[type] = (resourceTypes[type] ?? 0) + 1;
  }
  const bundle: ToolRouterExportBundle = {
    signature,
    resources,
    edges: [],
    summary: {
      total: resources.length,
      resource_types: resourceTypes,
    },
  };
  exportCache.set(signature, bundle);
  return bundle;
}

export function invalidateToolRouterExportCache(): void {
  exportCache.clear();
}

function exportEntryToResource(
  entry: DeferredToolEntry,
  tenantId: string,
  environment: "dev" | "staging" | "prod",
): ToolRouterExportResource {
  const fn = getFunction(entry);
  const name = entry.registryName;
  const description = fn?.description ?? "";
  const resourceType = inferResourceType(entry);
  const domains = inferDomains(name, resourceType);
  const primaryDomain = domains[0] ?? "misc";
  const capabilities = inferCapabilities(name, domains, resourceType);
  const now = new Date(0).toISOString();
  const tags = inferTags(entry, domains, resourceType);

  return {
    level1: {
      resource_id: name,
      tenant_id: tenantId,
      resource_type: resourceType,
      name,
      description,
      domain: primaryDomain,
      capability: capabilities,
      tags,
      version: "1.0.0",
      environment,
      status: "online",
      base_score: resourceType === "mcp_server" ? 0.5 : 0.55,
      embedding: hashTextToVector(entry.embeddingInput || entry.searchText, 64),
      latency_ms: inferLatencyMs(primaryDomain, resourceType),
      created_at: now,
    },
    level2: {
      input_type: entry.parameterNames.length ? `object:${name}Input` : "object:empty",
      output_type: "json",
      use_cases: dedupe([description, ...entry.examples, ...entry.searchAliases]).slice(0, 12),
      limitations: inferLimitations(resourceType),
      preconditions: inferPreconditions(resourceType),
      dependencies: [],
    },
    level3: {
      tool: resourceType === "tool"
        ? {
            parameters: (fn?.parameters as Record<string, unknown> | undefined) ?? {
              type: "object",
              properties: {},
            },
            required: entry.requiredParameters,
            timeout_ms: 30_000,
          }
        : null,
      skill: resourceType === "skill"
        ? {
            workflow: ["intent_router", "retrieval", "plan", "deliver"],
            child_resources: [],
            retry_policy: { max_retries: 0, backoff_ms: 250 },
            fallback_resources: [],
          }
        : null,
      mcp_server: resourceType === "mcp_server"
        ? {
            transport: "stdio",
            endpoint: `mcp://${name.split(".")[1] ?? "default"}`,
            rpc_methods: [name.split(".").slice(2).join(".") || name],
            auth_config: {},
            connection_pool: { size: 4 },
            heartbeat_interval_seconds: 30,
          }
        : null,
    },
    auth_level: "default",
    history_success_score: 0.5,
    failure_penalty: 0,
    latency_score: 0.5,
    consecutive_failures: 0,
  };
}

function inferResourceType(entry: DeferredToolEntry): "tool" | "skill" | "mcp_server" {
  const name = entry.registryName;
  if (name.startsWith("mcp.")) return "mcp_server";
  if (isRegisteredSkillChatToolName(name) || looksLikeSessionSkill(entry)) return "skill";
  return "tool";
}

function looksLikeSessionSkill(entry: DeferredToolEntry): boolean {
  const name = entry.registryName;
  if (name.startsWith("self.")) return false;
  if (/^(agent|aip|browser|calendar|clock|desktop|embodiment|fetch|info|phone|search|shopping|wallet|weather|world)\b/.test(name)) {
    return false;
  }
  const text = `${getFunction(entry)?.description ?? ""} ${entry.searchText}`.toLowerCase();
  return /\bskill\b|\bcustom capability\b|\bcommunity skill\b/.test(text);
}

function inferDomains(name: string, resourceType: "tool" | "skill" | "mcp_server"): string[] {
  const domains = new Set<string>(getEntryCategoryNames(name, TOOL_CATEGORIES));
  const namespace = firstNamespace(name);

  if (name === "search_web") domains.add("search");
  if (name === "fetch_web") {
    domains.add("search");
    domains.add("browser");
  }
  if (namespace === "info") {
    domains.add("search");
    domains.add("browser");
  }
  if (resourceType === "mcp_server") {
    domains.add("mcp");
    const alias = name.split(".")[1];
    if (alias) domains.add(cleanDomain(alias));
  }
  if (resourceType === "skill") {
    domains.add("self");
    domains.add(cleanDomain(namespace));
  }
  if (domains.size === 0) domains.add(namespaceToDomain(namespace));
  return dedupe([...domains].map(cleanDomain).filter(Boolean));
}

function inferCapabilities(
  name: string,
  domains: string[],
  resourceType: "tool" | "skill" | "mcp_server",
): string[] {
  const capabilities = new Set<string>();
  const dotParts = name.split(".").filter(Boolean);
  const leaf = dotParts[dotParts.length - 1] ?? name;
  const leafParts = leaf.split("_").filter(Boolean);
  const action = leafParts[0] ?? leaf;
  const second = dotParts[1];

  for (const domain of domains) {
    capabilities.add(`${domain}.general`);
    if (second) capabilities.add(`${domain}.${cleanCapability(second)}`);
    capabilities.add(`${domain}.${cleanCapability(leaf)}`);
    capabilities.add(`${domain}.${cleanCapability(action)}`);
    for (const normalized of normalizeActionAliases(action, leaf)) {
      capabilities.add(`${domain}.${normalized}`);
    }
  }

  if (name === "search_web") capabilities.add("search.search");
  if (name === "fetch_web") {
    capabilities.add("browser.read");
    capabilities.add("search.query");
  }
  if (name.includes("automation")) capabilities.add("desktop.automation");
  if (name.includes("screenshot")) capabilities.add("desktop.screenshot");
  if (name.startsWith("mcp.")) capabilities.add("mcp.general");
  if (resourceType === "skill") capabilities.add("self.skill");

  return dedupe([...capabilities].filter(Boolean));
}

function normalizeActionAliases(action: string, leaf: string): string[] {
  const values = new Set<string>();
  const a = cleanCapability(action);
  const l = cleanCapability(leaf);
  if (a) values.add(a);
  if (l) values.add(l);
  if (["get", "list", "fetch", "read", "query", "inspect", "search"].includes(a)) values.add("query");
  if (["create", "add", "schedule", "plan", "set"].includes(a)) values.add("create");
  if (["send", "call", "dispatch", "invoke"].includes(a)) values.add("send");
  if (["run", "execute", "open"].includes(a)) values.add("execute");
  if (l.includes("balance")) values.add("balance");
  if (l.includes("transaction")) values.add("transaction");
  if (l.includes("task")) values.add("task");
  if (l.includes("skill")) values.add("skill");
  return [...values];
}

function inferTags(
  entry: DeferredToolEntry,
  domains: string[],
  resourceType: "tool" | "skill" | "mcp_server",
): string[] {
  const text = `${entry.registryName} ${entry.searchText}`.toLowerCase();
  const fileTags = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "json", "txt", "md", "png", "jpg", "jpeg"]
    .filter((ext) => text.includes(ext));
  return dedupe([
    resourceType,
    ...domains,
    ...entry.parameterNames,
    ...entry.registryName.split(/[._-]+/),
    ...fileTags,
  ]);
}

function inferLimitations(resourceType: "tool" | "skill" | "mcp_server"): string[] {
  if (resourceType === "mcp_server") return ["remote availability and latency vary by server"];
  if (resourceType === "skill") return ["skill dependencies must be online before execution"];
  return [];
}

function inferPreconditions(resourceType: "tool" | "skill" | "mcp_server"): string[] {
  if (resourceType === "mcp_server") return ["MCP connection pool must be healthy"];
  if (resourceType === "skill") return ["skill must be enabled for the current actor"];
  return [];
}

function inferLatencyMs(domain: string, resourceType: "tool" | "skill" | "mcp_server"): number {
  if (resourceType === "mcp_server") return 30;
  const map: Record<string, number> = {
    clock: 10,
    weather: 18,
    calendar: 15,
    search: 24,
    browser: 20,
    phone: 32,
    budget: 14,
    shopping: 18,
    self: 12,
    reminder: 16,
    agent: 19,
    wallet: 13,
    aip: 26,
    embodiment: 23,
    desktop: 27,
    world: 28,
    travel: 22,
    mcp: 30,
  };
  return map[domain] ?? 20;
}

function namespaceToDomain(namespace: string): string {
  const map: Record<string, string> = {
    fetch: "search",
    search: "search",
    info: "search",
    agent: "agent",
    aip: "aip",
    browser: "browser",
    calendar: "calendar",
    clock: "clock",
    desktop: "desktop",
    embodiment: "embodiment",
    phone: "phone",
    reminder: "reminder",
    shopping: "shopping",
    wallet: "wallet",
    weather: "weather",
    world: "world",
    self: "self",
  };
  return map[namespace] ?? cleanDomain(namespace);
}

function catalogSignature(catalog: DeferredToolCatalog): string {
  const hash = createHash("sha1");
  for (const entry of [...catalog.entries].sort((a, b) => a.registryName.localeCompare(b.registryName))) {
    hash.update(entry.registryName);
    hash.update("\0");
    hash.update(String(entry.parameterNames.length));
    hash.update("\0");
    hash.update(String(entry.requiredParameters.length));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function getFunction(entry: DeferredToolEntry): {
  name: string;
  description?: string;
  parameters?: unknown;
} | null {
  return entry.tool.type === "function" ? entry.tool.function : null;
}

function firstNamespace(name: string): string {
  return name.split(/[._-]/)[0]?.toLowerCase() || "misc";
}

function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function cleanCapability(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hashTextToVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[\u4e00-\u9fa5]+|[a-z0-9_.-]+/g) ?? [text];
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    for (let i = 0; i < dim; i++) {
      const byte = hash[i % hash.length] ?? 0;
      out[i] += byte / 127.5 - 1;
    }
  }
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? out.map((value) => value / norm) : out;
}
