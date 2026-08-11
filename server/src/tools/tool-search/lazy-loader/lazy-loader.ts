import { createClient, type RedisClientType } from "redis";

import type { Level3Schema } from "../registry/models.js";
import type { ToolRegistryStore } from "../registry/store.js";
import type { ToolKnowledgeGraphService } from "../knowledge-graph/neo4j-client.js";

export type LazyLoadResult = {
  ok: boolean;
  resource_id: string;
  schema: Level3Schema | null;
  cache_hit: boolean;
  dependency_substitutions: Array<{
    dependency_resource_id: string;
    alternative_resource_id: string;
  }>;
  error_code?: string;
  error_message?: string;
};

export type LazyLoaderOptions = {
  redisUrl?: string;
  cacheTtlMs?: number;
  memoryMaxEntries?: number;
};

const CACHE_PREFIX = "tool:l3-schema:";
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class ResourceLazyLoader {
  private readonly redisUrl: string | undefined;
  private readonly cacheTtlMs: number;
  private readonly memoryMaxEntries: number;
  private readonly memory = new Map<string, { schema: Level3Schema; expiresAt: number }>();
  private redis: RedisClientType | null = null;
  private redisConnectPromise: Promise<void> | null = null;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly store: ToolRegistryStore,
    private readonly graph: ToolKnowledgeGraphService,
    options?: LazyLoaderOptions,
  ) {
    this.redisUrl =
      (options?.redisUrl ?? process.env.AGENT_REDIS_URL?.trim()) || undefined;
    this.cacheTtlMs = Math.max(1000, options?.cacheTtlMs ?? DEFAULT_TTL_MS);
    this.memoryMaxEntries = Math.max(10, options?.memoryMaxEntries ?? 500);
  }

  async load(resourceId: string): Promise<LazyLoadResult> {
    const cached = await this.getCached(resourceId);
    if (cached) {
      this.hits += 1;
      return {
        ok: true,
        resource_id: resourceId,
        schema: cached,
        cache_hit: true,
        dependency_substitutions: [],
      };
    }
    this.misses += 1;

    const record = await this.store.getRecord(resourceId);
    if (!record) {
      return fail(resourceId, "RESOURCE_NOT_FOUND", `resource ${resourceId} not found`);
    }
    if (record.level1.status !== "online") {
      return fail(
        resourceId,
        "RESOURCE_NOT_ONLINE",
        `resource ${resourceId} status=${record.level1.status}`,
      );
    }

    const substitutions = await this.resolveDependencySubstitutions(
      record.level2.dependencies,
    );
    const schema = await this.store.getLevel3(record.level3_pointer);
    if (!schema) {
      return fail(resourceId, "SCHEMA_NOT_FOUND", `Level-3 schema missing for ${resourceId}`);
    }

    await this.setCached(resourceId, schema);
    return {
      ok: true,
      resource_id: resourceId,
      schema,
      cache_hit: false,
      dependency_substitutions: substitutions,
    };
  }

  async invalidate(resourceId: string): Promise<void> {
    this.memory.delete(resourceId);
    const redis = await this.getRedis();
    if (!redis) return;
    try {
      await redis.del(CACHE_PREFIX + resourceId);
    } catch (e) {
      console.warn("[tool-search:lazy-loader] redis invalidate failed", e);
    }
  }

  cacheStats(): { hits: number; misses: number; hit_rate: number; memory_entries: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hit_rate: total > 0 ? this.hits / total : 0,
      memory_entries: this.memory.size,
    };
  }

  private async resolveDependencySubstitutions(
    dependencyIds: string[],
  ): Promise<LazyLoadResult["dependency_substitutions"]> {
    const substitutions: LazyLoadResult["dependency_substitutions"] = [];
    for (const dependencyId of dependencyIds) {
      const dep = await this.store.getRecord(dependencyId);
      if (!dep || dep.level1.status === "online") continue;
      const alternatives = await this.graph.getAlternatives(dependencyId, 1);
      const alternative = alternatives[0];
      if (alternative) {
        substitutions.push({
          dependency_resource_id: dependencyId,
          alternative_resource_id: alternative.level1.resource_id,
        });
      }
    }
    return substitutions;
  }

  private async getCached(resourceId: string): Promise<Level3Schema | null> {
    const now = Date.now();
    const mem = this.memory.get(resourceId);
    if (mem && mem.expiresAt > now) {
      // refresh LRU order
      this.memory.delete(resourceId);
      this.memory.set(resourceId, mem);
      return mem.schema;
    }
    if (mem) this.memory.delete(resourceId);

    const redis = await this.getRedis();
    if (!redis) return null;
    try {
      const raw = await redis.get(CACHE_PREFIX + resourceId);
      if (!raw) return null;
      const schema = JSON.parse(raw) as Level3Schema;
      this.setMemory(resourceId, schema);
      return schema;
    } catch (e) {
      console.warn("[tool-search:lazy-loader] redis read failed", e);
      return null;
    }
  }

  private async setCached(resourceId: string, schema: Level3Schema): Promise<void> {
    this.setMemory(resourceId, schema);
    const redis = await this.getRedis();
    if (!redis) return;
    try {
      await redis.set(CACHE_PREFIX + resourceId, JSON.stringify(schema), {
        PX: this.cacheTtlMs,
      });
    } catch (e) {
      console.warn("[tool-search:lazy-loader] redis write failed", e);
    }
  }

  private setMemory(resourceId: string, schema: Level3Schema): void {
    if (this.memory.size >= this.memoryMaxEntries) {
      const first = this.memory.keys().next().value;
      if (first !== undefined) this.memory.delete(first);
    }
    this.memory.set(resourceId, {
      schema,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  private async getRedis(): Promise<RedisClientType | null> {
    if (!this.redisUrl) return null;
    if (this.redis?.isOpen) return this.redis;
    if (!this.redisConnectPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on("error", (err) =>
        console.warn("[tool-search:lazy-loader] redis error", err),
      );
      this.redis = client as RedisClientType;
      this.redisConnectPromise = client.connect().then(
        () => undefined,
        (e) => {
          console.warn("[tool-search:lazy-loader] redis connect failed", e);
          this.redis = null;
        },
      );
    }
    await this.redisConnectPromise;
    return this.redis?.isOpen ? this.redis : null;
  }
}

function fail(
  resourceId: string,
  errorCode: string,
  errorMessage: string,
): LazyLoadResult {
  return {
    ok: false,
    resource_id: resourceId,
    schema: null,
    cache_hit: false,
    dependency_substitutions: [],
    error_code: errorCode,
    error_message: errorMessage,
  };
}
