import { createClient, type RedisClientType } from "redis";

import type { ParsedIntent, QueryConstraints } from "../intent-router/intent-router.js";
import type { ResourceRecord } from "../registry/models.js";
import type { ToolRegistryStore } from "../registry/store.js";
import { getCurrentToolRegistryEnvironment } from "../registry/registry-service.js";

export type DomainGroupName =
  | "communication"
  | "productivity"
  | "system"
  | "knowledge"
  | "commerce"
  | "world"
  | "misc";

export type HierarchicalRouteInput = {
  tenant_id: string;
  parsed_intent: ParsedIntent;
  max_resources?: number;
};

export type HierarchicalRouteResult = {
  domain_groups: DomainGroupName[];
  domains: string[];
  capabilities: string[];
  resources: ResourceRecord[];
  cache_hit: boolean;
  filtered_count: number;
};

export type HierarchicalRouterOptions = {
  redisUrl?: string;
  cacheTtlMs?: number;
  expandDomains?: (domains: string[], intent: ParsedIntent) => Promise<string[]>;
};

const DEFAULT_CACHE_TTL_MS = 20_000;
const CACHE_PREFIX = "tool:route:";

const DOMAIN_GROUPS: Record<DomainGroupName, string[]> = {
  communication: ["phone", "agent", "calendar", "reminder"],
  productivity: ["calendar", "reminder", "file", "notes", "self"],
  system: ["desktop", "browser", "embodiment", "clock", "aip"],
  knowledge: ["search", "browser", "weather", "file", "notes"],
  commerce: ["shopping", "wallet", "budget"],
  world: ["world", "agent"],
  misc: ["misc"],
};

/**
 * Phase-2 Hierarchical Router.
 *
 * 只通过 registry route index 读取 domain/capability 切片，禁止调用全资源列表做检索。
 */
export class HierarchicalRouter {
  private readonly redisUrl: string | undefined;
  private readonly cacheTtlMs: number;
  private readonly expandDomains?: (domains: string[], intent: ParsedIntent) => Promise<string[]>;
  private redis: RedisClientType | null = null;
  private redisConnectPromise: Promise<void> | null = null;

  constructor(
    private readonly store: ToolRegistryStore,
    options?: HierarchicalRouterOptions,
  ) {
    this.redisUrl =
      (options?.redisUrl ?? process.env.AGENT_REDIS_URL?.trim()) || undefined;
    this.cacheTtlMs = Math.max(1000, options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.expandDomains = options?.expandDomains;
  }

  async route(input: HierarchicalRouteInput): Promise<HierarchicalRouteResult> {
    const maxResources = Math.max(1, Math.min(500, input.max_resources ?? 100));
    const domains = await this.resolveDomains(input.parsed_intent);
    const domainGroups = resolveDomainGroups(domains);
    const capabilities = resolveCapabilities(input.parsed_intent, domains);
    const cacheKey = buildCacheKey(input.tenant_id, domains, capabilities);

    const cached = await this.readHotCache(cacheKey);
    if (cached.length > 0) {
      const records = await this.recordsFromIds(cached, input.parsed_intent.query_constraints);
      if (records.length > 0) {
        return {
          domain_groups: domainGroups,
          domains,
          capabilities,
          resources: records.slice(0, maxResources),
          cache_hit: true,
          filtered_count: records.length,
        };
      }
    }

    const env = getCurrentToolRegistryEnvironment();
    let resources = await this.store.listRecordsByRoute({
      tenantId: input.tenant_id,
      env,
      domains,
      capabilities,
      limit: maxResources,
    });

    // 精确 capability 无结果时，只在同 domain 内降级，仍然不进入全局扫描。
    if (resources.length === 0 && capabilities.length > 0) {
      resources = await this.store.listRecordsByRoute({
        tenantId: input.tenant_id,
        env,
        domains,
        limit: maxResources,
      });
    }

    const filtered = filterByConstraints(resources, input.parsed_intent.query_constraints);
    await this.writeHotCache(cacheKey, filtered.map((r) => r.level1.resource_id));

    return {
      domain_groups: domainGroups,
      domains,
      capabilities,
      resources: filtered,
      cache_hit: false,
      filtered_count: resources.length - filtered.length,
    };
  }

  private async resolveDomains(intent: ParsedIntent): Promise<string[]> {
    const base = unique(
      intent.domain_candidates.length > 0 ? intent.domain_candidates : ["misc"],
    );
    if (!this.expandDomains) return base;
    try {
      return unique([...(await this.expandDomains(base, intent)), ...base]);
    } catch (e) {
      console.warn("[tool-search:route] graph domain expansion failed", e);
      return base;
    }
  }

  private async recordsFromIds(
    ids: string[],
    constraints: QueryConstraints,
  ): Promise<ResourceRecord[]> {
    const records: ResourceRecord[] = [];
    for (const id of ids) {
      const record = await this.store.getRecord(id);
      if (record) records.push(record);
    }
    return filterByConstraints(records, constraints);
  }

  private async readHotCache(key: string): Promise<string[]> {
    const redis = await this.getRedis();
    if (!redis) return [];
    try {
      const raw = await redis.get(key);
      if (!raw) return [];
      const ids = JSON.parse(raw) as unknown;
      return Array.isArray(ids) ? ids.map(String) : [];
    } catch (e) {
      console.warn("[tool-search:route] hot cache read failed", e);
      return [];
    }
  }

  private async writeHotCache(key: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const redis = await this.getRedis();
    if (!redis) return;
    try {
      await redis.set(key, JSON.stringify(ids), { PX: this.cacheTtlMs });
    } catch (e) {
      console.warn("[tool-search:route] hot cache write failed", e);
    }
  }

  private async getRedis(): Promise<RedisClientType | null> {
    if (!this.redisUrl) return null;
    if (this.redis?.isOpen) return this.redis;
    if (!this.redisConnectPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on("error", (err) =>
        console.warn("[tool-search:route] redis error", err),
      );
      this.redis = client as RedisClientType;
      this.redisConnectPromise = client.connect().then(
        () => undefined,
        (e) => {
          console.warn("[tool-search:route] redis connect failed", e);
          this.redis = null;
        },
      );
    }
    await this.redisConnectPromise;
    return this.redis?.isOpen ? this.redis : null;
  }
}

function resolveDomainGroups(domains: string[]): DomainGroupName[] {
  const out: DomainGroupName[] = [];
  for (const [group, groupDomains] of Object.entries(DOMAIN_GROUPS) as Array<
    [DomainGroupName, string[]]
  >) {
    if (domains.some((d) => groupDomains.includes(d))) out.push(group);
  }
  return out.length ? out : ["misc"];
}

function resolveCapabilities(intent: ParsedIntent, domains: string[]): string[] {
  const out = new Set<string>();
  if (intent.primary_capability) out.add(intent.primary_capability);
  for (const domain of domains) {
    out.add(`${domain}.general`);
    const prefix = intent.primary_capability.split(".")[1];
    if (prefix) out.add(`${domain}.${prefix}`);
  }
  return Array.from(out);
}

function filterByConstraints(
  records: ResourceRecord[],
  constraints: QueryConstraints,
): ResourceRecord[] {
  const requestedAuth = constraints.auth_level;
  return records.filter((record) => {
    if (record.level1.status !== "online") return false;
    if (!authAllows(record.auth_level, requestedAuth)) return false;
    if (constraints.read_only && isLikelyWriteResource(record)) return false;
    if (
      constraints.file_type &&
      record.level1.tags.length > 0 &&
      !record.level1.tags.some((tag) => tag.toLowerCase() === constraints.file_type)
    ) {
      return false;
    }
    return true;
  });
}

function authAllows(resourceAuth: string, requestedAuth: string): boolean {
  if (resourceAuth === "guest") return true;
  if (resourceAuth === "default") return requestedAuth !== "guest";
  return requestedAuth === "admin";
}

function isLikelyWriteResource(record: ResourceRecord): boolean {
  const text = [
    record.level1.name,
    record.level1.description,
    ...record.level1.tags,
    ...record.level2.use_cases,
  ]
    .join(" ")
    .toLowerCase();
  return /delete|remove|write|send|create|update|transfer|pay|删除|发送|创建|更新|转账|支付/.test(
    text,
  );
}

function buildCacheKey(
  tenantId: string,
  domains: string[],
  capabilities: string[],
): string {
  return `${CACHE_PREFIX}${tenantId}:${domains.join(",")}:${capabilities.join(",")}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}
