import type { HttpRateLimitRuntime } from "../http-rate-limit/http-rate-limit.js";

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return n;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export type RuntimeConfig = {
  port: number;
  allowWorldHttpMutations: boolean;
  agentRelayRequirePair: boolean;
  worldPlaceholderRegister: boolean;
  realFundsInitialBalance: number;
  realFundsDefaultCurrency: string;
};

export function getRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const portRaw = parseInteger(env.PORT, 3000);
  const port = portRaw > 0 && portRaw < 65536 ? portRaw : 3000;
  const currency = env.REAL_FUNDS_DEFAULT_CURRENCY?.trim() || "CNY";
  return {
    port,
    allowWorldHttpMutations: parseBoolean(env.ALLOW_WORLD_HTTP_MUTATIONS, false),
    agentRelayRequirePair: parseBoolean(env.AGENT_RELAY_REQUIRE_PAIR, false),
    worldPlaceholderRegister: parseBoolean(env.AGENT_WORLD_PLACEHOLDER_REGISTER, false),
    realFundsInitialBalance: parsePositiveNumber(env.REAL_FUNDS_INITIAL_BALANCE, 1000),
    realFundsDefaultCurrency: currency,
  };
}

/** 令牌桶 + 滑动窗口 HTTP 限流；默认关闭，生产可设 HTTP_RATE_LIMIT_ENABLED=1。 */
export function getHttpRateLimitRuntime(env: NodeJS.ProcessEnv = process.env): HttpRateLimitRuntime {
  const slidingWindowMs = parsePositiveNumber(env.HTTP_RATE_LIMIT_SLIDING_WINDOW_MS, 60_000);
  const slidingMax = parseInteger(env.HTTP_RATE_LIMIT_SLIDING_MAX, 600);
  const bucketCapacity = parseInteger(env.HTTP_RATE_LIMIT_BUCKET_CAPACITY, 80);
  const bucketRefillPerSecond = parsePositiveNumber(env.HTTP_RATE_LIMIT_BUCKET_REFILL_PER_SEC, 40);
  const maxTrackedClients = parseInteger(env.HTTP_RATE_LIMIT_MAX_CLIENT_KEYS, 100_000);

  const redisUrlRaw = env.HTTP_RATE_LIMIT_REDIS_URL?.trim();
  const redisKeyPrefix = env.HTTP_RATE_LIMIT_REDIS_KEY_PREFIX?.trim() || "http_rl:v1";

  return {
    enabled: parseBoolean(env.HTTP_RATE_LIMIT_ENABLED, false),
    trustForwardedFor: parseBoolean(env.HTTP_RATE_LIMIT_TRUST_FORWARDED_FOR, false),
    slidingWindowMs,
    slidingMax: slidingMax > 0 ? slidingMax : 600,
    bucketCapacity: bucketCapacity > 0 ? bucketCapacity : 80,
    bucketRefillPerSecond: bucketRefillPerSecond > 0 ? bucketRefillPerSecond : 40,
    maxTrackedClients: maxTrackedClients > 1000 ? maxTrackedClients : 100_000,
    redisUrl: redisUrlRaw && redisUrlRaw.length > 0 ? redisUrlRaw : null,
    redisKeyPrefix,
    redisFailOpen: parseBoolean(env.HTTP_RATE_LIMIT_REDIS_FAIL_OPEN, true),
  };
}
