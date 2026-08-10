import { createHash } from "node:crypto";

import { createClient, type RedisClientType } from "redis";

import { Bm25Index, tokenize } from "../bm25.js";
import { TOOL_CATEGORIES } from "../tool-category.js";

export type QueryConstraints = {
  max_latency_ms: number;
  read_only: boolean;
  file_type: string | null;
  auth_level: "default" | "admin" | "guest";
};

export type ParsedIntent = {
  intent: string;
  domain_candidates: string[];
  primary_capability: string;
  confidence: number;
  query_constraints: QueryConstraints;
  param_extract: Record<string, unknown>;
  is_compound_task: boolean;
  sub_intents: ParsedIntent[];
};

export type IntentRouterInput = {
  raw_user_query: string;
  agent_context_hash: string;
};

export type SemanticIntentRouter = (
  input: IntentRouterInput,
) => Promise<ParsedIntent | null>;

export type IntentRouterOptions = {
  redisUrl?: string;
  cacheTtlMs?: number;
  semanticRouter?: SemanticIntentRouter;
};

const DEFAULT_CACHE_TTL_MS = 30_000;
const CACHE_PREFIX = "tool:intent:";

const categoryIndex = new Bm25Index(
  TOOL_CATEGORIES.map((cat) => ({
    id: cat.name,
    text: [...cat.aliases, ...cat.prefixes, ...cat.secondaryTools].join(" "),
  })),
);

/**
 * Phase-2 Intent Router.
 *
 * 运行顺序：
 *   1. Redis query+context 缓存命中则直接返回
 *   2. 可选 semanticRouter（LLM）返回 confidence >= 0.6 时采用
 *   3. confidence 不足或无 LLM 时使用 BM25/规则兜底
 *   4. 复合任务按子句独立路由，再合并 domain/capability
 */
export class IntentRouter {
  private readonly redisUrl: string | undefined;
  private readonly cacheTtlMs: number;
  private readonly semanticRouter: SemanticIntentRouter | undefined;
  private redis: RedisClientType | null = null;
  private redisConnectPromise: Promise<void> | null = null;

  constructor(options?: IntentRouterOptions) {
    this.redisUrl =
      (options?.redisUrl ?? process.env.AGENT_REDIS_URL?.trim()) || undefined;
    this.cacheTtlMs = Math.max(1000, options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.semanticRouter = options?.semanticRouter;
  }

  async decompose(input: IntentRouterInput): Promise<ParsedIntent> {
    const normalized: IntentRouterInput = {
      raw_user_query: input.raw_user_query.trim(),
      agent_context_hash: input.agent_context_hash.trim() || "default",
    };
    const cached = await this.getCached(normalized);
    if (cached) return cached;

    const semantic = await this.trySemanticRoute(normalized);
    const result =
      semantic && semantic.confidence >= 0.6
        ? normalizeIntent(semantic)
        : this.routeByKeywords(normalized.raw_user_query);

    await this.setCached(normalized, result);
    return result;
  }

  private async trySemanticRoute(
    input: IntentRouterInput,
  ): Promise<ParsedIntent | null> {
    if (!this.semanticRouter) return null;
    try {
      return await this.semanticRouter(input);
    } catch (e) {
      console.warn("[tool-search:intent] semantic router failed, fallback to BM25", e);
      return null;
    }
  }

  private routeByKeywords(query: string): ParsedIntent {
    const parts = splitCompoundQuery(query);
    if (parts.length > 1) {
      const subIntents = parts.map((part) => this.routeSingle(part, true));
      const domains = unique(subIntents.flatMap((i) => i.domain_candidates));
      const best = subIntents.reduce((a, b) =>
        a.confidence >= b.confidence ? a : b,
      );
      return {
        intent: query,
        domain_candidates: domains.length ? domains : ["misc"],
        primary_capability: best.primary_capability,
        confidence: clamp01(
          subIntents.reduce((sum, item) => sum + item.confidence, 0) /
            subIntents.length,
        ),
        query_constraints: mergeConstraints(subIntents.map((i) => i.query_constraints)),
        param_extract: Object.assign({}, ...subIntents.map((i) => i.param_extract)),
        is_compound_task: true,
        sub_intents: subIntents,
      };
    }
    return this.routeSingle(query, false);
  }

  private routeSingle(query: string, asSubIntent: boolean): ParsedIntent {
    const hits = categoryIndex.search(query, 3);
    const bm25Domains = hits.length > 0 ? hits.map((h) => h.id) : ["misc"];
    const topScore = hits[0]?.score ?? 0;
    const tokenCount = tokenize(query).length;
    const confidence = clamp01(topScore > 0 ? 0.62 + Math.min(0.3, topScore / 8) : 0.45);
    const inferredCapability = inferCapability(bm25Domains[0] ?? "misc", query);
    const preferredDomain = inferredCapability.split(".")[0] || "misc";
    const domains = prioritizeDomain(bm25Domains, preferredDomain);
    return {
      intent: query.trim(),
      domain_candidates: domains,
      primary_capability: inferredCapability,
      confidence: tokenCount <= 2 ? Math.max(confidence, 0.6) : confidence,
      query_constraints: inferConstraints(query),
      param_extract: extractParams(query),
      is_compound_task: false,
      sub_intents: asSubIntent ? [] : [],
    };
  }

  private async getCached(input: IntentRouterInput): Promise<ParsedIntent | null> {
    const redis = await this.getRedis();
    if (!redis) return null;
    try {
      const raw = await redis.get(cacheKey(input));
      if (!raw) return null;
      return normalizeIntent(JSON.parse(raw) as ParsedIntent);
    } catch (e) {
      console.warn("[tool-search:intent] redis cache read failed", e);
      return null;
    }
  }

  private async setCached(
    input: IntentRouterInput,
    result: ParsedIntent,
  ): Promise<void> {
    const redis = await this.getRedis();
    if (!redis) return;
    try {
      await redis.set(cacheKey(input), JSON.stringify(result), {
        PX: this.cacheTtlMs,
      });
    } catch (e) {
      console.warn("[tool-search:intent] redis cache write failed", e);
    }
  }

  private async getRedis(): Promise<RedisClientType | null> {
    if (!this.redisUrl) return null;
    if (this.redis?.isOpen) return this.redis;
    if (!this.redisConnectPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on("error", (err) =>
        console.warn("[tool-search:intent] redis error", err),
      );
      this.redis = client as RedisClientType;
      this.redisConnectPromise = client.connect().then(
        () => undefined,
        (e) => {
          console.warn("[tool-search:intent] redis connect failed", e);
          this.redis = null;
        },
      );
    }
    await this.redisConnectPromise;
    return this.redis?.isOpen ? this.redis : null;
  }
}

function cacheKey(input: IntentRouterInput): string {
  const hash = createHash("sha1")
    .update(input.raw_user_query)
    .update("\0")
    .update(input.agent_context_hash)
    .digest("hex");
  return CACHE_PREFIX + hash;
}

function splitCompoundQuery(query: string): string[] {
  const parts = query
    .split(/(?:，|,|；|;|然后|并且|同时|以及|\band\b|\bthen\b)/i)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  return parts.length > 1 ? parts.slice(0, 8) : [query.trim()];
}

function inferCapability(domain: string, query: string): string {
  const q = query.toLowerCase();
  const capabilityRules: Array<[RegExp, string]> = [
    [/电话|拨号|call|ring/, "phone.call"],
    [/短信|消息|message|send/, "phone.message"],
    [/网页|浏览|打开|browser|网址|url/, "browser.navigate"],
    [/天气|weather|预报|气温/, "weather.query"],
    [/提醒|闹钟|remind|timer|alert/, "reminder.schedule"],
    [/钱包|余额|转账|支付|wallet|balance|transaction/, "wallet.transaction"],
    [/桌面|截图|鼠标|键盘|desktop|screenshot|automation/, "desktop.automation"],
    [/文件|pdf|docx|xlsx|文档|file/, "file.document"],
    [/技能|skill|能力|自定义/, "self.skill"],
    [/搜索|查询|search|查一下|搜一下/, "search.query"],
  ];
  for (const [pattern, capability] of capabilityRules) {
    if (pattern.test(q)) return capability;
  }
  return `${domain}.general`;
}

function inferConstraints(query: string): QueryConstraints {
  const q = query.toLowerCase();
  const readOnly = /查询|查看|读取|搜索|search|read|show|list|inspect/.test(q);
  const fast = /快|马上|立刻|快速|fast|quick|asap/.test(q);
  const fileTypeMatch = q.match(/\b(pdf|docx?|xlsx?|csv|json|txt|md|png|jpe?g)\b/i);
  const admin = /删除|管理|权限|系统|admin|delete|configure/.test(q);
  return {
    max_latency_ms: fast ? 100 : 200,
    read_only: readOnly,
    file_type: fileTypeMatch?.[1]?.toLowerCase() ?? null,
    auth_level: admin ? "admin" : "default",
  };
}

function mergeConstraints(items: QueryConstraints[]): QueryConstraints {
  return {
    max_latency_ms: Math.min(...items.map((i) => i.max_latency_ms)),
    read_only: items.every((i) => i.read_only),
    file_type: items.find((i) => i.file_type)?.file_type ?? null,
    auth_level: items.some((i) => i.auth_level === "admin") ? "admin" : "default",
  };
}

function extractParams(query: string): Record<string, unknown> {
  const urls = Array.from(query.matchAll(/https?:\/\/[^\s，,；;]+/gi)).map(
    (m) => m[0],
  );
  const emails = Array.from(
    query.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
  ).map((m) => m[0]);
  const phoneNumbers = Array.from(query.matchAll(/\b\+?\d[\d -]{6,}\d\b/g)).map(
    (m) => m[0],
  );
  const numbers = Array.from(query.matchAll(/\b\d+(?:\.\d+)?\b/g)).map((m) =>
    Number(m[0]),
  );
  return { urls, emails, phone_numbers: phoneNumbers, numbers };
}

function normalizeIntent(intent: ParsedIntent): ParsedIntent {
  return {
    intent: String(intent.intent ?? "").trim(),
    domain_candidates: unique(intent.domain_candidates ?? []).length
      ? unique(intent.domain_candidates ?? [])
      : ["misc"],
    primary_capability: String(intent.primary_capability ?? "misc.general"),
    confidence: clamp01(Number(intent.confidence ?? 0)),
    query_constraints: {
      max_latency_ms: Math.max(1, Number(intent.query_constraints?.max_latency_ms ?? 200)),
      read_only: Boolean(intent.query_constraints?.read_only),
      file_type: intent.query_constraints?.file_type ?? null,
      auth_level: intent.query_constraints?.auth_level ?? "default",
    },
    param_extract: intent.param_extract ?? {},
    is_compound_task: Boolean(intent.is_compound_task),
    sub_intents: Array.isArray(intent.sub_intents)
      ? intent.sub_intents.map(normalizeIntent)
      : [],
  };
}

function prioritizeDomain(domains: string[], preferredDomain: string): string[] {
  const uniqueDomains = unique(domains);
  if (!preferredDomain || preferredDomain === "misc") return uniqueDomains;
  return [
    preferredDomain,
    ...uniqueDomains.filter((domain) => domain !== preferredDomain),
  ];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
