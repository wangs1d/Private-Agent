import { createHash } from "node:crypto";

import { createClient } from "redis";

import type { PathRateLimitLimits } from "./path-rate-limit-rules.js";

/** 与内存限流一致：令牌桶 + 滑动窗口；Redis TIME 作为时钟。 */
const RATE_LIMIT_LUA = `
local zkey = KEYS[1]
local hkey = KEYS[2]
local window_ms = tonumber(ARGV[1])
local sliding_max = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local refill_per_sec = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])

local t = redis.call('TIME')
local now = math.floor(tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000)

local tokens_raw = redis.call('HGET', hkey, 'tokens')
local last_raw = redis.call('HGET', hkey, 'last')
local tokens
local last
if not tokens_raw then
  tokens = capacity
  last = now
else
  tokens = tonumber(tokens_raw)
  last = tonumber(last_raw)
end

local elapsed_sec = (now - last) / 1000
if elapsed_sec > 0 then
  tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)
  last = now
end

if tokens < cost then
  local need = cost - tokens
  local retry_ms = math.ceil((need / refill_per_sec) * 1000)
  if retry_ms < 1 then retry_ms = 1 end
  redis.call('HSET', hkey, 'tokens', tostring(tokens), 'last', tostring(last))
  return {0, retry_ms, 'token_bucket'}
end

redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now - window_ms)
local count = redis.call('ZCARD', zkey)
if count >= sliding_max then
  local oldest = redis.call('ZRANGE', zkey, 0, 0, 'WITHSCORES')
  local oldest_ms = tonumber(oldest[2])
  local retry_ms = math.ceil(oldest_ms + window_ms - now)
  if retry_ms < 1 then retry_ms = 1 end
  redis.call('HSET', hkey, 'tokens', tostring(tokens), 'last', tostring(last))
  return {0, retry_ms, 'sliding_window'}
end

tokens = tokens - cost
redis.call('HSET', hkey, 'tokens', tostring(tokens), 'last', tostring(now))
local zid = redis.call('HINCRBY', hkey, 'zid', 1)
local member = tostring(now) .. ':' .. tostring(zid)
redis.call('ZADD', zkey, now, member)

local ttl_z = math.floor(window_ms / 1000) + 60
local ttl_h = math.max(ttl_z, 3600)
redis.call('EXPIRE', zkey, ttl_z)
redis.call('EXPIRE', hkey, ttl_h)

return {1, 0, ''}
`;

export type RedisConnectionParams = {
  redisUrl: string;
  redisKeyPrefix: string;
  redisFailOpen: boolean;
};

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterMs: number; layer: "token_bucket" | "sliding_window" };

function slotTag(clientKey: string): string {
  return createHash("sha256").update(clientKey, "utf8").digest("hex").slice(0, 16);
}

function safeTierSegment(tierId: string): string {
  return tierId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tier";
}

function redisKeys(prefix: string, clientKey: string, tierId: string): [string, string] {
  const tag = slotTag(clientKey);
  const tier = safeTierSegment(tierId);
  const base = `${prefix}{${tag}}:${tier}`;
  return [`${base}:z`, `${base}:h`];
}

/** @internal 供单元测试校验 RESP 解析 */
export function parseEvalResult(raw: unknown): RateLimitDecision {
  if (!Array.isArray(raw) || raw.length < 3) {
    return { ok: false, retryAfterMs: 1000, layer: "token_bucket" };
  }
  const allowed = Number(raw[0]);
  const retryAfterMs = Math.max(1, Number(raw[1]));
  const layerRaw = String(raw[2] ?? "");
  if (allowed === 1) return { ok: true };
  const layer = layerRaw === "sliding_window" ? "sliding_window" : "token_bucket";
  return { ok: false, retryAfterMs, layer };
}

export type RedisHttpRateLimiter = {
  tryConsume(clientKey: string, tierId: string, limits: PathRateLimitLimits): Promise<RateLimitDecision>;
  close(): Promise<void>;
};

export async function createRedisHttpRateLimiter(params: RedisConnectionParams): Promise<RedisHttpRateLimiter> {
  const client = createClient({ url: params.redisUrl });
  client.on("error", (err) => {
    console.error("[http-rate-limit] redis client error", err);
  });
  await client.connect();
  const sha = await client.scriptLoad(RATE_LIMIT_LUA);

  return {
    async tryConsume(clientKey: string, tierId: string, limits: PathRateLimitLimits): Promise<RateLimitDecision> {
      const [zkey, hkey] = redisKeys(params.redisKeyPrefix, clientKey, tierId);
      try {
        const raw = await client.evalSha(sha, {
          keys: [zkey, hkey],
          arguments: [
            String(Math.floor(limits.slidingWindowMs)),
            String(limits.slidingMax),
            String(limits.bucketCapacity),
            String(limits.bucketRefillPerSecond),
            "1",
          ],
        });
        return parseEvalResult(raw);
      } catch (e) {
        console.error("[http-rate-limit] redis eval failed", e);
        if (params.redisFailOpen) return { ok: true };
        return { ok: false, retryAfterMs: 2000, layer: "token_bucket" };
      }
    },
    async close(): Promise<void> {
      if (client.isOpen) await client.quit();
    },
  };
}
