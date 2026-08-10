import { createHash } from "node:crypto";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  describeDeferredTool,
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
import { tokenize } from "./bm25.js";
import { IntentRouter, type ParsedIntent, type QueryConstraints } from "./intent-router/intent-router.js";
import { isRegisteredSkillChatToolName } from "../../skills/skill-openai-bridge.js";
import {
  type Level3McpSchema,
  type Level3Parameter,
  type Level3SkillSchema,
  type Level3ToolSchema,
  ResourceStatus,
  ResourceType,
  type ResourceRecord,
} from "./registry/models.js";
import { getToolEmbeddingsForCatalog } from "./tool-embedding.js";
import { getEntryCategoryNames, TOOL_CATEGORIES } from "./tool-category.js";
import {
  HybridRetrievalEngine,
  type HybridRetrievedResource,
} from "./retrieval/hybrid-retrieval.js";
import { AdaptiveTopPSelector } from "./top-p-selector/top-p-selector.js";
import { ToolRerankingPipeline } from "./reranking/reranking-pipeline.js";

export type AdaptiveDeferredToolSearchMatch = DeferredToolSearchMatch & {
  resource_type: ResourceType;
  domain: string[];
  capability: string[];
  routing: {
    intent: string;
    confidence: number;
    top_p: number;
    domain_groups: string[];
    domain_candidates: string[];
    primary_capability: string;
  };
};

export type AdaptiveSearchOptions = {
  includeSchema?: boolean;
  queryVector?: number[] | Float32Array;
  tenantId?: string;
  agentContextHash?: string;
  previousToolResult?: unknown;
  blacklistResourceIds?: string[];
};

export type AdaptiveCatalogSummary = {
  total: number;
  resource_types: Record<ResourceType, number>;
  domains: Record<string, number>;
  capabilities: Record<string, number>;
};

type RouteResult = {
  domain_groups: string[];
  domains: string[];
  capabilities: string[];
  resources: ResourceRecord[];
  cache_hit: boolean;
  filtered_count: number;
};

type RouteCacheEntry = {
  expiresAt: number;
  resourceIds: string[];
  filteredCount: number;
};

type AdaptiveCatalogIndex = {
  signature: string;
  recordsById: Map<string, ResourceRecord>;
  entriesById: Map<string, DeferredToolEntry>;
  byDomainGroup: Map<string, string[]>;
  byDomainGroupDomain: Map<string, string[]>;
  byDomain: Map<string, string[]>;
  byCapability: Map<string, string[]>;
  byDomainCapability: Map<string, string[]>;
  domainGroupsByDomain: Map<string, string[]>;
  byActionKey: Map<string, string[]>;
  routeCache: Map<string, RouteCacheEntry>;
  summary: AdaptiveCatalogSummary;
};

type FunctionToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

const DEFAULT_TENANT_ID = "default";
const DEFAULT_CONTEXT_HASH = "tool-search-bridge";
const ROUTE_CACHE_TTL_MS = 20_000;
const MAX_INDEX_CACHE = 32;
const intentRouter = new IntentRouter({ redisUrl: undefined });
const retrievalEngine = new HybridRetrievalEngine();
const topPSelector = new AdaptiveTopPSelector();
const rerankingPipeline = new ToolRerankingPipeline();
const indexCache = new Map<string, { index: AdaptiveCatalogIndex; createdAt: number }>();

export async function adaptiveSearchDeferredTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: AdaptiveSearchOptions,
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || catalog.entries.length === 0 || limit <= 0) return [];

  const index = getOrCreateAdaptiveCatalogIndex(catalog);
  const contextHash = options?.agentContextHash?.trim() || DEFAULT_CONTEXT_HASH;
  const parsedIntent = await intentRouter.decompose({
    raw_user_query: trimmedQuery,
    agent_context_hash: contextHash,
  });

  const subIntents =
    parsedIntent.is_compound_task && parsedIntent.sub_intents.length > 0
      ? parsedIntent.sub_intents
      : [parsedIntent];

  const selectedById = new Map<string, HybridRetrievedResource>();
  const routingParts: Array<{
    intent: ParsedIntent;
    route: RouteResult;
    topP: number;
  }> = [];

  for (const intent of subIntents) {
    const route = routeAdaptiveCatalog(index, intent, options?.tenantId);
    if (route.resources.length === 0) {
      routingParts.push({ intent, route, topP: topPForIntent(intent) });
      continue;
    }

    const retrieved = await retrievalEngine.search({
      query: intent.intent || trimmedQuery,
      candidates: route.resources,
      queryVector: options?.queryVector,
      limit: Math.min(100, Math.max(25, limit * 8)),
    });
    const boostedRetrieved = applyAdaptiveIntentBoost(index, retrieved, intent.intent || trimmedQuery);
    const topP = topPSelector.select(
      boostedRetrieved.map((item) => ({ item, score: item.final_score })),
      { confidence: intent.confidence },
    );
    routingParts.push({ intent, route, topP: topP.top_p });

    for (const selected of topP.selected) {
      const id = selected.item.resource.level1.resource_id;
      const prev = selectedById.get(id);
      if (!prev || selected.item.final_score > prev.final_score) {
        selectedById.set(id, selected.item);
      }
    }
  }

  if (selectedById.size === 0) return [];

  const expandedRecords = expandWithKnowledgeGraph(
    index,
    [...selectedById.values()].map((hit) => hit.resource),
    25,
  );
  const expandedRetrieved = await retrievalEngine.search({
    query: trimmedQuery,
    candidates: expandedRecords,
    queryVector: options?.queryVector,
    limit: 25,
  });
  const reranked = await rerankingPipeline.rerank({
    raw_query: trimmedQuery,
    agent_context_hash: contextHash,
    previous_tool_result: options?.previousToolResult,
    query_constraints: parsedIntent.query_constraints,
    candidates: expandedRetrieved,
    blacklist_resource_ids: options?.blacklistResourceIds,
  });

  const primaryRoute = routingParts[0];
  const routing = {
    intent: parsedIntent.intent,
    confidence: parsedIntent.confidence,
    top_p: primaryRoute?.topP ?? topPForIntent(parsedIntent),
    domain_groups: primaryRoute?.route.domain_groups ?? [],
    domain_candidates: primaryRoute?.route.domains ?? parsedIntent.domain_candidates,
    primary_capability: parsedIntent.primary_capability,
  };

  const boosted = applyAdaptiveIntentBoost(index, reranked.candidates, trimmedQuery);

  return boosted
    .slice(0, Math.max(1, limit))
    .map((candidate) => matchFromCandidate(catalog, index, candidate, routing, options));
}

export function summarizeAdaptiveCatalog(
  catalog: DeferredToolCatalog,
): AdaptiveCatalogSummary {
  return getOrCreateAdaptiveCatalogIndex(catalog).summary;
}

export function loadAdaptiveCatalogSchema(
  catalog: DeferredToolCatalog,
  resourceId: string,
): Level3ToolSchema | Level3SkillSchema | Level3McpSchema | null {
  const index = getOrCreateAdaptiveCatalogIndex(catalog);
  const record = index.recordsById.get(resourceId);
  const entry = index.entriesById.get(resourceId);
  if (!record || !entry) return null;
  if (record.level1.resource_type === ResourceType.McpServer) {
    return buildMcpSchema(entry);
  }
  if (record.level1.resource_type === ResourceType.Skill) {
    return buildSkillSchema(entry);
  }
  return buildToolSchema(entry);
}

function getOrCreateAdaptiveCatalogIndex(catalog: DeferredToolCatalog): AdaptiveCatalogIndex {
  const signature = catalogSignature(catalog);
  const cached = indexCache.get(signature);
  if (cached) {
    indexCache.delete(signature);
    indexCache.set(signature, cached);
    return cached.index;
  }

  const index = buildAdaptiveCatalogIndex(catalog, signature);
  if (indexCache.size >= MAX_INDEX_CACHE) {
    const firstKey = indexCache.keys().next().value;
    if (firstKey !== undefined) indexCache.delete(firstKey);
  }
  indexCache.set(signature, { index, createdAt: Date.now() });
  return index;
}

function buildAdaptiveCatalogIndex(
  catalog: DeferredToolCatalog,
  signature: string,
): AdaptiveCatalogIndex {
  const embeddings = getToolEmbeddingsForCatalog(
    catalog.entries.map((entry) => entry.registryName),
  );
  const index: AdaptiveCatalogIndex = {
    signature,
    recordsById: new Map(),
    entriesById: new Map(),
    byDomainGroup: new Map(),
    byDomainGroupDomain: new Map(),
    byDomain: new Map(),
    byCapability: new Map(),
    byDomainCapability: new Map(),
    domainGroupsByDomain: new Map(),
    byActionKey: new Map(),
    routeCache: new Map(),
    summary: emptySummary(),
  };

  for (const entry of catalog.entries) {
    const record = resourceRecordFromEntry(entry, embeddings.get(entry.registryName));
    index.recordsById.set(record.level1.resource_id, record);
    index.entriesById.set(record.level1.resource_id, entry);
    countSummary(index.summary, record);
    const domainGroups = inferDomainGroups(record.level1.domain, record.level1.resource_type);

    for (const domainGroup of domainGroups) {
      pushIndex(index.byDomainGroup, domainGroup, record.level1.resource_id);
    }
    for (const domain of record.level1.domain) {
      pushIndex(index.byDomain, domain, record.level1.resource_id);
      for (const domainGroup of domainGroups) {
        pushIndex(
          index.byDomainGroupDomain,
          routeKey(domainGroup, domain),
          record.level1.resource_id,
        );
        pushIndex(index.domainGroupsByDomain, domain, domainGroup);
      }
      for (const capability of record.level1.capability) {
        pushIndex(
          index.byDomainCapability,
          routeKey(domain, capability),
          record.level1.resource_id,
        );
      }
    }
    for (const capability of record.level1.capability) {
      pushIndex(index.byCapability, capability, record.level1.resource_id);
    }
    for (const key of actionKeys(record)) {
      pushIndex(index.byActionKey, key, record.level1.resource_id);
    }
  }

  return index;
}

function routeAdaptiveCatalog(
  index: AdaptiveCatalogIndex,
  intent: ParsedIntent,
  tenantId?: string,
): RouteResult {
  const domainGroups = resolveRouteDomainGroups(index, intent);
  const domains = resolveRouteDomains(index, intent, domainGroups);
  const capabilities = resolveRouteCapabilities(intent, domains);
  const constraints = intent.query_constraints;
  const cacheKey = [
    tenantId || DEFAULT_TENANT_ID,
    domainGroups.join(","),
    domains.join(","),
    capabilities.join(","),
    constraints.auth_level,
    constraints.read_only ? "ro" : "rw",
    constraints.file_type ?? "",
  ].join("|");
  const cached = index.routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      domain_groups: domainGroups,
      domains,
      capabilities,
      resources: idsToFilteredRecords(index, cached.resourceIds, constraints, tenantId),
      cache_hit: true,
      filtered_count: cached.filteredCount,
    };
  }

  const ids = new Set<string>();
  for (const domainGroup of domainGroups) {
    for (const domain of domains) {
      const groupedIds = index.byDomainGroupDomain.get(routeKey(domainGroup, domain));
      if (!groupedIds?.length) continue;
      const groupedIdSet = new Set(groupedIds);
      for (const capability of capabilities) {
        for (const id of index.byDomainCapability.get(routeKey(domain, capability)) ?? []) {
          if (groupedIdSet.has(id)) ids.add(id);
        }
      }
    }
  }

  if (ids.size === 0) {
    for (const domainGroup of domainGroups) {
      for (const id of index.byDomainGroup.get(domainGroup) ?? []) ids.add(id);
    }
  }

  if (ids.size === 0) {
    for (const domain of domains) {
      for (const id of index.byDomain.get(domain) ?? []) ids.add(id);
    }
  }

  if (ids.size === 0) {
    for (const capability of capabilities) {
      for (const id of index.byCapability.get(capability) ?? []) ids.add(id);
    }
  }

  if (ids.size === 0) {
    for (const key of queryActionKeys(intent.intent)) {
      for (const id of index.byActionKey.get(key) ?? []) ids.add(id);
    }
  }

  const allIds = [...ids].slice(0, 500);
  const resources = idsToFilteredRecords(index, allIds, constraints, tenantId);
  index.routeCache.set(cacheKey, {
    expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
    resourceIds: allIds,
    filteredCount: allIds.length - resources.length,
  });

  return {
    domain_groups: domainGroups,
    domains,
    capabilities,
    resources,
    cache_hit: false,
    filtered_count: allIds.length - resources.length,
  };
}

function expandWithKnowledgeGraph(
  index: AdaptiveCatalogIndex,
  seedRecords: ResourceRecord[],
  limit: number,
): ResourceRecord[] {
  const out = new Map<string, ResourceRecord>();
  const add = (id: string): void => {
    if (out.size >= limit) return;
    const record = index.recordsById.get(id);
    if (record?.level1.status === ResourceStatus.Online) out.set(id, record);
  };

  for (const record of seedRecords) add(record.level1.resource_id);
  for (const record of seedRecords) {
    if (out.size >= limit) break;
    for (const dependency of record.level2.dependencies) add(dependency);
    for (const key of actionKeys(record)) {
      for (const domain of record.level1.domain) {
        for (const id of index.byDomainCapability.get(routeKey(domain, `${domain}.${key}`)) ?? []) {
          if (out.size >= limit) break;
          add(id);
        }
      }
    }
    for (const capability of record.level1.capability.slice(0, 6)) {
      for (const id of index.byCapability.get(capability) ?? []) {
        if (out.size >= limit) break;
        add(id);
      }
    }
  }
  return [...out.values()].slice(0, limit);
}

function applyAdaptiveIntentBoost(
  index: AdaptiveCatalogIndex,
  candidates: HybridRetrievedResource[],
  query: string,
): HybridRetrievedResource[] {
  const q = query.toLowerCase();
  const qTokens = new Set(tokenize(q));
  return candidates
    .map((candidate) => {
      const id = candidate.resource.level1.resource_id;
      const entry = index.entriesById.get(id);
      const boost = clamp(
        lexicalToolBoost(id, q, qTokens, entry) + specialToolBoost(id, q),
        -0.25,
        0.45,
      );
      if (boost === 0) return candidate;
      return {
        ...candidate,
        final_score: round4(clamp(candidate.final_score + boost, 0, 1)),
      };
    })
    .sort((a, b) => b.final_score - a.final_score);
}

function lexicalToolBoost(
  resourceId: string,
  query: string,
  queryTokens: Set<string>,
  entry?: DeferredToolEntry,
): number {
  const nameTokens = tokenize(resourceId.replace(/[._-]+/g, " "));
  let boost = 0;
  for (const token of nameTokens) {
    if (token.length < 3) continue;
    if (queryTokens.has(token) || query.includes(token)) {
      boost += token.length >= 5 ? 0.055 : 0.025;
    }
  }
  if (entry) {
    const positives = [...entry.searchAliases, ...entry.examples];
    for (const phrase of positives) {
      const overlap = tokenize(phrase).filter((token) => queryTokens.has(token)).length;
      if (overlap > 0) boost += Math.min(0.08, overlap * 0.025);
    }
    const negatives = [...entry.negativeAliases, ...entry.negativeExamples];
    for (const phrase of negatives) {
      const overlap = tokenize(phrase).filter((token) => queryTokens.has(token)).length;
      if (overlap > 0) boost -= Math.min(0.12, overlap * 0.04);
    }
  }
  return boost;
}

function specialToolBoost(resourceId: string, query: string): number {
  let boost = 0;
  const has = (pattern: RegExp): boolean => pattern.test(query);

  if (resourceId === "calendar.list_tasks" && has(/\btasks?\b|\btodo\b/)) boost += 0.32;
  if (resourceId === "search_web" && has(/\bsearch\b|\bnews\b|\blatest\b/)) boost += 0.42;
  if (resourceId === "fetch_web" && has(/\bread\b|\bfetch\b|\bpage\b|\bcontent\b|\burl\b/)) boost += 0.42;
  if (resourceId === "info.inspect_webpage" && has(/\bsearch\b|\bnews\b|\blatest\b/)) boost -= 0.1;
  if (resourceId === "info.inspect_webpage" && has(/\bread\b|\bfetch\b|\bcontent\b/) && !has(/\binspect\b/)) boost -= 0.08;
  if (resourceId === "agent.query_capabilities" && has(/\bcapabilit(?:y|ies)\b|\btools?\b|\bcan you\b/)) boost += 0.3;
  if (resourceId === "self.list_custom_skills" && has(/\bcustom\b|\bskills?\b/)) boost += 0.34;
  if (resourceId === "wallet.get_transactions" && has(/\btransactions?\b|\brecent\b|\bhistory\b/)) boost += 0.32;
  if (resourceId === "embodiment.roam" && has(/\broam\b|\baround\b/) && !has(/\bwindow\b/)) boost += 0.2;
  if (resourceId === "embodiment.window_roam" && has(/\broam\b|\baround\b/) && !has(/\bwindow\b/)) boost -= 0.12;
  if (resourceId === "desktop.run_automation" && has(/\bautomation\b|\bscript\b|\btask\b/)) boost += 0.22;
  if (resourceId === "desktop.visual.run_task" && has(/\bautomation\b|\bscript\b/) && !has(/\bvisual\b|\bscreenshot\b/)) boost -= 0.12;

  return boost;
}

function matchFromCandidate(
  catalog: DeferredToolCatalog,
  index: AdaptiveCatalogIndex,
  candidate: HybridRetrievedResource,
  routing: AdaptiveDeferredToolSearchMatch["routing"],
  options?: AdaptiveSearchOptions,
): AdaptiveDeferredToolSearchMatch {
  const record = candidate.resource;
  const entry = index.entriesById.get(record.level1.resource_id);
  const match: AdaptiveDeferredToolSearchMatch = {
    name: record.level1.resource_id,
    description: record.level1.description,
    score: Math.round(candidate.final_score * 1000) / 1000,
    parameterNames: entry?.parameterNames ?? [],
    requiredParameters: entry?.requiredParameters ?? [],
    resource_type: record.level1.resource_type,
    domain: record.level1.domain,
    capability: record.level1.capability,
    routing,
  };
  if (options?.includeSchema) {
    const schema = describeDeferredTool(catalog, record.level1.resource_id);
    if (schema) {
      match.parameters =
        (schema.parameters as Record<string, unknown> | undefined) ?? {
          type: "object",
          properties: {},
        };
    }
  }
  return match;
}

function resourceRecordFromEntry(
  entry: DeferredToolEntry,
  cachedEmbedding?: number[],
): ResourceRecord {
  const fn = getFunction(entry.tool);
  const name = entry.registryName;
  const description = fn?.description ?? "";
  const resourceType = inferResourceType(entry);
  const domains = inferDomains(name, resourceType);
  const capabilities = inferCapabilities(name, domains, resourceType);
  const now = new Date(0).toISOString();
  const tags = inferTags(entry, domains, resourceType);
  return {
    level1: {
      resource_id: name,
      resource_type: resourceType,
      name,
      description,
      domain: domains,
      capability: capabilities,
      tags,
      version: "1.0.0",
      status: ResourceStatus.Online,
      base_score: resourceType === ResourceType.McpServer ? 0.5 : 0.55,
      embedding: cachedEmbedding ?? hashTextToVector(entry.embeddingInput || entry.searchText, 64),
    },
    level2: {
      resource_id: name,
      input_type: entry.parameterNames.length ? `object:${name}Input` : "object:empty",
      output_type: "json",
      use_cases: dedupe([
        description,
        ...entry.examples,
        ...entry.searchAliases,
      ]).slice(0, 12),
      limitations: inferLimitations(resourceType),
      preconditions: inferPreconditions(resourceType),
      dependencies: [],
    },
    level3_pointer: name,
    versions: [
      {
        version: "1.0.0",
        released_at: now,
        is_canary: false,
        is_active: true,
      },
    ],
    environment: "prod",
    tenant_id: DEFAULT_TENANT_ID,
    auth_level: "default",
    created_at: now,
    updated_at: now,
  };
}

function inferResourceType(entry: DeferredToolEntry): ResourceType {
  const name = entry.registryName;
  if (name.startsWith("mcp.")) return ResourceType.McpServer;
  if (isRegisteredSkillChatToolName(name)) return ResourceType.Skill;
  if (looksLikeSessionSkill(entry)) return ResourceType.Skill;
  return ResourceType.Tool;
}

function looksLikeSessionSkill(entry: DeferredToolEntry): boolean {
  const name = entry.registryName;
  if (name.startsWith("self.")) return false;
  if (/^(agent|aip|browser|calendar|clock|desktop|embodiment|fetch|info|phone|search|shopping|wallet|weather|world)\b/.test(name)) {
    return false;
  }
  const text = `${getFunction(entry.tool)?.description ?? ""} ${entry.searchText}`.toLowerCase();
  return /\bskill\b|\bcustom capability\b|\bcommunity skill\b/.test(text);
}

function inferDomains(name: string, resourceType: ResourceType): string[] {
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
  if (resourceType === ResourceType.McpServer) {
    domains.add("mcp");
    domains.add("misc");
    const alias = name.split(".")[1];
    if (alias) domains.add(cleanDomain(alias));
  }
  if (resourceType === ResourceType.Skill) {
    domains.add("self");
    domains.add(cleanDomain(namespace));
    if (domains.size === 0) domains.add("misc");
  }
  if (domains.size === 0) domains.add(namespaceToDomain(namespace));
  return dedupe([...domains].map(cleanDomain).filter(Boolean));
}

function inferCapabilities(
  name: string,
  domains: string[],
  resourceType: ResourceType,
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

  if (name === "search_web") {
    capabilities.add("search.query");
    capabilities.add("search.web");
  }
  if (name === "fetch_web") {
    capabilities.add("search.fetch");
    capabilities.add("browser.navigate");
    capabilities.add("browser.read");
  }
  if (name.includes("automation")) capabilities.add("desktop.automation");
  if (name.includes("screenshot")) capabilities.add("desktop.screenshot");
  if (name.startsWith("mcp.")) capabilities.add("mcp.general");
  if (resourceType === ResourceType.Skill) capabilities.add("self.skill");

  capabilities.add(cleanCapability(name));
  return dedupe([...capabilities].filter(Boolean));
}

function normalizeActionAliases(action: string, leaf: string): string[] {
  const values = new Set<string>();
  const a = cleanCapability(action);
  const l = cleanCapability(leaf);
  if (a) values.add(a);
  if (l) values.add(l);
  if (["get", "list", "fetch", "read", "query", "inspect"].includes(a)) values.add("query");
  if (["create", "add", "schedule", "plan"].includes(a)) values.add("create");
  if (["send", "call", "dispatch", "invoke"].includes(a)) values.add("call");
  if (["run", "execute", "open"].includes(a)) values.add("execute");
  if (l.includes("call")) values.add("call");
  if (l.includes("message")) values.add("message");
  if (l.includes("balance")) {
    values.add("balance");
    values.add("query");
  }
  if (l.includes("transaction")) {
    values.add("transaction");
    values.add("query");
  }
  if (l.includes("task")) values.add("task");
  if (l.includes("skill")) values.add("skill");
  return [...values];
}

function inferTags(
  entry: DeferredToolEntry,
  domains: string[],
  resourceType: ResourceType,
): string[] {
  const fileTags = new Set<string>();
  const text = `${entry.registryName} ${entry.searchText}`.toLowerCase();
  for (const ext of ["pdf", "doc", "docx", "xls", "xlsx", "csv", "json", "txt", "md", "png", "jpg", "jpeg"]) {
    if (text.includes(ext)) fileTags.add(ext);
  }
  return dedupe([
    resourceType,
    ...domains,
    ...entry.parameterNames,
    ...entry.registryName.split(/[._-]+/),
    ...fileTags,
  ]);
}

function inferLimitations(resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["remote availability and latency vary by server"];
  if (resourceType === ResourceType.Skill) return ["skill dependencies must be online before execution"];
  return [];
}

function inferPreconditions(resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["MCP connection pool must be healthy"];
  if (resourceType === ResourceType.Skill) return ["skill must be enabled for the current actor"];
  return [];
}

function idsToFilteredRecords(
  index: AdaptiveCatalogIndex,
  ids: string[],
  constraints: QueryConstraints,
  tenantId?: string,
): ResourceRecord[] {
  const out: ResourceRecord[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = index.recordsById.get(id);
    if (!record) continue;
    if (!passesRouteFilters(record, constraints, tenantId)) continue;
    out.push(record);
  }
  return out;
}

function passesRouteFilters(
  record: ResourceRecord,
  constraints: QueryConstraints,
  tenantId?: string,
): boolean {
  if (record.level1.status !== ResourceStatus.Online) return false;
  if (
    tenantId &&
    tenantId !== DEFAULT_TENANT_ID &&
    record.tenant_id !== DEFAULT_TENANT_ID &&
    record.tenant_id !== tenantId
  ) {
    return false;
  }
  if (!authAllows(record.auth_level, constraints.auth_level)) return false;
  if (constraints.read_only && isLikelyWriteResource(record)) return false;
  if (
    constraints.file_type &&
    record.level1.tags.length > 0 &&
    !record.level1.tags.some((tag) => tag.toLowerCase() === constraints.file_type)
  ) {
    return false;
  }
  return true;
}

function authAllows(resourceAuth: string, requestedAuth: string): boolean {
  if (resourceAuth === "guest") return true;
  if (resourceAuth === "default") return requestedAuth !== "guest";
  return requestedAuth === "admin";
}

function isLikelyWriteResource(record: ResourceRecord): boolean {
  const name = record.level1.name.toLowerCase();
  return /(?:^|[._-])(?:accept|call|comment|create|delete|deliver|dispatch|execute|like|pay|post|purchase|reject|remove|respond|run|send|submit|transfer|update|upload|write)(?:[._-]|$)/.test(
    name,
  );
}

function resolveRouteDomainGroups(index: AdaptiveCatalogIndex, intent: ParsedIntent): string[] {
  const groups = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const normalized = cleanDomainGroup(value);
    if (normalized) groups.add(normalized);
  };

  const domains = dedupe([
    ...intent.domain_candidates.map((domain) => cleanDomain(domain)),
    primaryCapabilityDomain(intent.primary_capability),
    ...domainsFromQuery(intent.intent),
  ]).filter(Boolean);

  for (const domain of domains) {
    for (const group of groupsForDomain(index, domain)) add(group);
  }
  for (const group of domainGroupsFromQuery(intent.intent)) add(group);

  const available = [...groups].filter((group) => index.byDomainGroup.has(group));
  if (available.length > 0) return dedupe(available);
  if (index.byDomainGroup.has("general")) return ["general"];
  return dedupe([...groups]);
}

function resolveRouteDomains(
  index: AdaptiveCatalogIndex,
  intent: ParsedIntent,
  domainGroups: string[],
): string[] {
  const queryDomains = domainsFromQuery(intent.intent).filter((domain) =>
    index.byDomain.has(domain),
  );
  const groupedQueryDomains = queryDomains.filter((domain) => domainMatchesAnyGroup(index, domain, domainGroups));
  if (groupedQueryDomains.length > 0) return dedupe(groupedQueryDomains);

  const domains = new Set<string>();
  for (const domain of intent.domain_candidates) {
    const cleaned = cleanDomain(domain);
    if (cleaned) domains.add(cleaned);
  }
  const capDomain = intent.primary_capability.split(".")[0];
  if (capDomain) domains.add(cleanDomain(capDomain));
  for (const domain of domainsFromQuery(intent.intent)) domains.add(domain);

  const available = [...domains].filter((domain) =>
    index.byDomain.has(domain) && domainMatchesAnyGroup(index, domain, domainGroups),
  );
  if (available.length > 0) return dedupe(available);
  if (index.byDomain.has("misc")) return ["misc"];
  return dedupe([...domains]);
}

function resolveRouteCapabilities(intent: ParsedIntent, domains: string[]): string[] {
  const capabilities = new Set<string>();
  if (intent.primary_capability) capabilities.add(cleanCapability(intent.primary_capability));
  const capSuffix = intent.primary_capability.split(".")[1];
  for (const domain of domains) {
    capabilities.add(`${domain}.general`);
    if (capSuffix) capabilities.add(`${domain}.${cleanCapability(capSuffix)}`);
  }
  for (const key of queryActionKeys(intent.intent)) {
    for (const domain of domains) capabilities.add(`${domain}.${key}`);
  }
  return dedupe([...capabilities].filter(Boolean));
}

function domainsFromQuery(query: string): string[] {
  const q = query.toLowerCase();
  const out = new Set<string>();
  const rules: Array<[RegExp, string[]]> = [
    [/\bmcp\b|\bexternal tool\b|\bintegration\b|\bserver\b/, ["mcp", "misc"]],
    [/\bweb\b|\bbrowser\b|\burl\b|\bpage\b|\bsite\b|\blink\b/, ["browser", "search"]],
    [/\bsearch\b|\bgoogle\b|\bquery\b|\bnews\b/, ["search"]],
    [/\bweather\b|\bforecast\b|\btemperature\b/, ["weather"]],
    [/\bcalendar\b|\bschedule\b|\bmeeting\b|\bremind\b|\btodo\b|\btasks?\b/, ["calendar", "reminder"]],
    [/\bphone\b|\bcall\b|\bmessage\b|\bsms\b|\bdial\b/, ["phone"]],
    [/\bwallet\b|\bbalance\b|\btransaction\b|\bpayment\b/, ["wallet"]],
    [/\bavatar\b|\bembodiment\b|\broam\b|(?:\bplace\b.*\bwindow\b)|(?:\bwindow\b.*\bplace\b)/, ["embodiment", "desktop"]],
    [/\bdesktop\b|\bshell\b|\bscreenshot\b|\bautomation\b|\bwindow\b/, ["desktop"]],
    [/\bskill\b|\bcapabilit(?:y|ies)\b|\bcustom\b|\btools?\b|\bcan you\b/, ["agent", "self"]],
    [/\bworld\b|\bregistry\b|\bagent\b/, ["world", "agent"]],
  ];
  for (const [pattern, domains] of rules) {
    if (!pattern.test(q)) continue;
    for (const domain of domains) out.add(domain);
  }
  return [...out];
}

function domainGroupsFromQuery(query: string): string[] {
  return inferDomainGroups(domainsFromQuery(query), ResourceType.Tool);
}

function inferDomainGroups(domains: string[], resourceType: ResourceType): string[] {
  const groups = new Set<string>();
  if (resourceType === ResourceType.McpServer) groups.add("integration");
  for (const domain of domains) {
    switch (cleanDomain(domain)) {
      case "search":
      case "browser":
        groups.add("information");
        break;
      case "calendar":
      case "reminder":
      case "self":
        groups.add("productivity");
        break;
      case "phone":
      case "agent":
        groups.add("communication");
        break;
      case "world":
      case "aip":
        groups.add("coordination");
        break;
      case "wallet":
      case "budget":
      case "shopping":
        groups.add("commerce");
        break;
      case "desktop":
      case "embodiment":
      case "device":
      case "smart_home":
      case "vision":
        groups.add("execution");
        break;
      case "weather":
      case "clock":
        groups.add("signals");
        break;
      case "mcp":
        groups.add("integration");
        break;
      default:
        groups.add("general");
        break;
    }
  }
  if (groups.size === 0) groups.add("general");
  return [...groups];
}

function domainMatchesAnyGroup(
  index: AdaptiveCatalogIndex,
  domain: string,
  domainGroups: string[],
): boolean {
  if (domainGroups.length === 0) return true;
  const groups = new Set(groupsForDomain(index, domain));
  return domainGroups.some((group) => groups.has(group));
}

function primaryCapabilityDomain(primaryCapability: string): string {
  return cleanDomain(primaryCapability.split(".")[0]);
}

function groupsForDomain(index: AdaptiveCatalogIndex, domain: string): string[] {
  const cleaned = cleanDomain(domain);
  if (!cleaned) return [];
  return index.domainGroupsByDomain.get(cleaned) ?? inferDomainGroups([cleaned], ResourceType.Tool);
}

function queryActionKeys(query: string): string[] {
  const q = query.toLowerCase();
  const out = new Set<string>();
  const rules: Array<[RegExp, string]> = [
    [/\bsearch\b|\bfind\b|\bquery\b|\blook up\b|\blist\b|\bshow\b|\bread\b|\bfetch\b/, "query"],
    [/\bopen\b|\bnavigate\b|\bbrowse\b/, "navigate"],
    [/\bcreate\b|\badd\b|\bschedule\b|\bplan\b|\bset\b/, "create"],
    [/\bsend\b|\bcall\b|\bdial\b|\bdispatch\b/, "call"],
    [/\brun\b|\bexecute\b|\bshell\b|\bautomation\b/, "execute"],
    [/\bscreenshot\b|\bscreen\b/, "screenshot"],
  ];
  for (const [pattern, key] of rules) {
    if (pattern.test(q)) out.add(key);
  }
  return [...out];
}

function actionKeys(record: ResourceRecord): string[] {
  const keys = new Set<string>();
  for (const capability of record.level1.capability) {
    const suffix = capability.split(".")[1];
    if (suffix) keys.add(suffix);
  }
  const nameParts = record.level1.name.split(/[._-]+/).filter(Boolean);
  for (const part of nameParts) keys.add(cleanCapability(part));
  return [...keys].filter(Boolean);
}

function buildToolSchema(entry: DeferredToolEntry): Level3ToolSchema {
  const parameters = jsonSchemaToParameters(getFunction(entry.tool)?.parameters, entry.requiredParameters);
  return {
    resource_id: entry.registryName,
    parameters,
    required_fields: parameters.filter((p) => p.required).map((p) => p.name),
    validation_rules: {},
    timeout_ms: 30_000,
  };
}

function buildSkillSchema(entry: DeferredToolEntry): Level3SkillSchema {
  return {
    resource_id: entry.registryName,
    workflow: {
      kind: "single_skill_handler",
      entrypoint: entry.registryName,
    },
    subtools: [],
    branch_conditions: {},
    retry_policy: { max_retries: 0, backoff_ms: 250 },
    fallback_resource_id: null,
  };
}

function buildMcpSchema(entry: DeferredToolEntry): Level3McpSchema {
  const parts = entry.registryName.split(".");
  const alias = parts[1] ?? "default";
  const method = parts.slice(2).join(".") || entry.registryName;
  return {
    resource_id: entry.registryName,
    transport: "stdio",
    endpoint: `mcp://${alias}`,
    rpc_methods: [method],
    auth_config: {},
    pool_size: 4,
    heartbeat_interval_ms: 30_000,
  };
}

function jsonSchemaToParameters(
  parameters: unknown,
  requiredParameters: string[],
): Level3Parameter[] {
  const schema = parameters && typeof parameters === "object" ? parameters as JsonSchemaObject : null;
  const props = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = new Set(requiredParameters);
  const out: Level3Parameter[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const property = raw && typeof raw === "object" ? raw as JsonSchemaObject : {};
    out.push({
      name,
      type: jsonTypeToParameterType(property.type),
      required: required.has(name),
      description: typeof property.description === "string" ? property.description : undefined,
      enum: Array.isArray(property.enum) ? property.enum : undefined,
    });
  }
  return out;
}

type JsonSchemaObject = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  description?: unknown;
  enum?: unknown[];
};

function jsonTypeToParameterType(type: unknown): Level3Parameter["type"] {
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  if (type === "object") return "object";
  return "string";
}

function getFunction(tool: ChatCompletionTool): FunctionToolDefinition | null {
  if (tool.type !== "function") return null;
  const maybeFunction = (tool as { function?: FunctionToolDefinition }).function;
  return maybeFunction?.name ? maybeFunction : null;
}

function topPForIntent(intent: ParsedIntent): number {
  if (intent.confidence > 0.85) return 0.7;
  if (intent.confidence > 0.6) return 0.9;
  return 0.95;
}

function catalogSignature(catalog: DeferredToolCatalog): string {
  const hash = createHash("sha1");
  for (const entry of [...catalog.entries].sort((a, b) =>
    a.registryName.localeCompare(b.registryName),
  )) {
    hash.update(entry.registryName);
    hash.update("\0");
    hash.update(String(entry.parameterNames.length));
    hash.update("\0");
    hash.update(String(entry.requiredParameters.length));
    hash.update("\0");
  }
  return hash.digest("hex");
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
    smart: "smart_home",
    device: "device",
    voice: "voice",
    vision: "vision",
  };
  return map[namespace] ?? cleanDomain(namespace || "misc");
}

function firstNamespace(name: string): string {
  if (name === "search_web") return "search";
  if (name === "fetch_web") return "fetch";
  return name.split(/[._-]/)[0]?.toLowerCase() ?? "misc";
}

function cleanDomainGroup(value: string | null | undefined): string {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "";
}

function cleanDomain(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "misc";
}

function cleanCapability(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function routeKey(domain: string, capability: string): string {
  return `${domain}\0${capability}`;
}

function pushIndex(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(id)) list.push(id);
    return;
  }
  map.set(key, [id]);
}

function emptySummary(): AdaptiveCatalogSummary {
  return {
    total: 0,
    resource_types: {
      [ResourceType.Tool]: 0,
      [ResourceType.Skill]: 0,
      [ResourceType.McpServer]: 0,
    },
    domains: {},
    capabilities: {},
  };
}

function countSummary(summary: AdaptiveCatalogSummary, record: ResourceRecord): void {
  summary.total += 1;
  summary.resource_types[record.level1.resource_type] += 1;
  for (const domain of record.level1.domain) {
    summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
  }
  for (const capability of record.level1.capability) {
    summary.capabilities[capability] = (summary.capabilities[capability] ?? 0) + 1;
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
