/**
 * 路径前缀限流：最长前缀优先匹配，最后一条 `prefix: ""` 为默认层。
 * 默认层数值由 `getHttpRateLimitRuntime` / 环境变量提供。
 */
export type PathRateLimitLimits = {
  slidingWindowMs: number;
  slidingMax: number;
  bucketCapacity: number;
  bucketRefillPerSecond: number;
};

export type PathRateLimitRule = PathRateLimitLimits & {
  id: string;
  /** 空前缀表示默认层（仅应出现在排序表末尾） */
  prefix: string;
};

/** 固定前缀配额（与仓库 HTTP 路由前缀对齐） */
const FIXED_PATH_RULES: PathRateLimitRule[] = [
  { id: "accounts", prefix: "/accounts", slidingWindowMs: 60_000, slidingMax: 30, bucketCapacity: 12, bucketRefillPerSecond: 2 },
  { id: "protocol_unified", prefix: "/protocol/unified", slidingWindowMs: 60_000, slidingMax: 180, bucketCapacity: 45, bucketRefillPerSecond: 20 },
  { id: "chat", prefix: "/chat", slidingWindowMs: 60_000, slidingMax: 120, bucketCapacity: 30, bucketRefillPerSecond: 12 },
  { id: "tools", prefix: "/tools", slidingWindowMs: 60_000, slidingMax: 120, bucketCapacity: 30, bucketRefillPerSecond: 12 },
  { id: "info", prefix: "/info", slidingWindowMs: 60_000, slidingMax: 200, bucketCapacity: 50, bucketRefillPerSecond: 18 },
  { id: "world", prefix: "/world", slidingWindowMs: 60_000, slidingMax: 400, bucketCapacity: 100, bucketRefillPerSecond: 50 },
  { id: "agent", prefix: "/agent", slidingWindowMs: 60_000, slidingMax: 200, bucketCapacity: 50, bucketRefillPerSecond: 20 },
  { id: "wallet", prefix: "/wallet", slidingWindowMs: 60_000, slidingMax: 60, bucketCapacity: 20, bucketRefillPerSecond: 5 },
  { id: "schedule", prefix: "/schedule", slidingWindowMs: 60_000, slidingMax: 240, bucketCapacity: 60, bucketRefillPerSecond: 24 },
  { id: "weather", prefix: "/weather", slidingWindowMs: 60_000, slidingMax: 120, bucketCapacity: 40, bucketRefillPerSecond: 15 },
  { id: "phone", prefix: "/phone", slidingWindowMs: 60_000, slidingMax: 90, bucketCapacity: 25, bucketRefillPerSecond: 8 },
  { id: "well_known", prefix: "/.well-known", slidingWindowMs: 60_000, slidingMax: 120, bucketCapacity: 40, bucketRefillPerSecond: 20 },
  { id: "system", prefix: "/system", slidingWindowMs: 60_000, slidingMax: 60, bucketCapacity: 20, bucketRefillPerSecond: 10 },
];

export function buildOrderedPathRateLimitRules(defaultTier: PathRateLimitLimits): PathRateLimitRule[] {
  const defaultRule: PathRateLimitRule = { id: "default", prefix: "", ...defaultTier };
  const sorted = [...FIXED_PATH_RULES].sort((a, b) => b.prefix.length - a.prefix.length);
  return [...sorted, defaultRule];
}

export function resolvePathRateLimitRule(path: string, ordered: readonly PathRateLimitRule[]): PathRateLimitRule {
  const p = path.split("?", 1)[0] ?? path;
  let fallback: PathRateLimitRule | undefined;
  for (const r of ordered) {
    if (r.prefix === "") {
      fallback = r;
      continue;
    }
    if (p === r.prefix || p.startsWith(`${r.prefix}/`)) return r;
  }
  if (fallback) return fallback;
  throw new Error("path rate limit: missing default rule");
}
