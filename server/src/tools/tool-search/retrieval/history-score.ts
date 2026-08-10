import { createClient, type RedisClientType } from "redis";

export type HistoryFeedbackSample = {
  resource_id: string;
  success: boolean;
  latency_ms: number;
  result_quality_score: number;
  call_timestamp: string;
};

export type ResourceHistoryScore = {
  history_success_score: number;
  failure_penalty: number;
  latency_score: number;
  failure_rate: number;
  sample_count: number;
  consecutive_failures: number;
};

export type HistoryScoreStoreOptions = {
  redisUrl?: string;
  windowMs?: number;
  maxLatencyMs?: number;
};

const KEY_PREFIX = "tool:history:";
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LATENCY_MS = 5_000;

/**
 * Phase-3 滑动窗口历史评分。
 *
 * Redis 可用时使用 sorted set(timestamp score, JSON sample value)，并在每次写入时
 * ZREMRANGEBYSCORE 剪掉窗口外样本。Redis 不可用时用进程内 Map 降级。
 */
export class HistoryScoreStore {
  private readonly redisUrl: string | undefined;
  private readonly windowMs: number;
  private readonly maxLatencyMs: number;
  private redis: RedisClientType | null = null;
  private redisConnectPromise: Promise<void> | null = null;
  private readonly memory = new Map<string, HistoryFeedbackSample[]>();

  constructor(options?: HistoryScoreStoreOptions) {
    this.redisUrl =
      (options?.redisUrl ?? process.env.AGENT_REDIS_URL?.trim()) || undefined;
    this.windowMs = Math.max(60_000, options?.windowMs ?? DEFAULT_WINDOW_MS);
    this.maxLatencyMs = Math.max(1, options?.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS);
  }

  async record(sample: HistoryFeedbackSample): Promise<void> {
    const normalized: HistoryFeedbackSample = {
      ...sample,
      latency_ms: clamp(sample.latency_ms, 0, 60_000),
      result_quality_score: clamp01(sample.result_quality_score),
      call_timestamp: new Date(sample.call_timestamp).toISOString(),
    };
    this.recordMemory(normalized);

    const redis = await this.getRedis();
    if (!redis) return;
    const ts = Date.parse(normalized.call_timestamp);
    const minTs = Date.now() - this.windowMs;
    try {
      const key = KEY_PREFIX + normalized.resource_id;
      await redis.sendCommand(["ZADD", key, String(ts), JSON.stringify(normalized)]);
      await redis.sendCommand(["ZREMRANGEBYSCORE", key, "-inf", String(minTs)]);
    } catch (e) {
      console.warn("[tool-search:history] redis record failed", e);
    }
  }

  async getScore(resourceId: string): Promise<ResourceHistoryScore> {
    const redis = await this.getRedis();
    if (redis) {
      try {
        const minTs = Date.now() - this.windowMs;
        const raw = await redis.sendCommand([
          "ZRANGEBYSCORE",
          KEY_PREFIX + resourceId,
          String(minTs),
          "+inf",
        ]);
        if (Array.isArray(raw)) {
          return computeScore(
            raw
              .map((v) => parseSample(String(v)))
              .filter((v): v is HistoryFeedbackSample => v != null),
            this.windowMs,
            this.maxLatencyMs,
          );
        }
      } catch (e) {
        console.warn("[tool-search:history] redis getScore failed", e);
      }
    }
    return computeScore(this.readMemory(resourceId), this.windowMs, this.maxLatencyMs);
  }

  async getIntentTopPOverride(intentKey: string): Promise<number | null> {
    const redis = await this.getRedis();
    if (!redis) return null;
    try {
      const raw = await redis.get(`tool:intent-top-p:${intentKey}`);
      const n = raw == null ? Number.NaN : Number(raw);
      return Number.isFinite(n) ? clamp(n, 0.7, 0.99) : null;
    } catch (e) {
      console.warn("[tool-search:history] redis get top_p override failed", e);
      return null;
    }
  }

  async bumpIntentTopP(intentKey: string, delta = 0.03): Promise<number> {
    const redis = await this.getRedis();
    if (!redis) return 0.95;
    const current = (await this.getIntentTopPOverride(intentKey)) ?? 0.9;
    const next = clamp(current + delta, 0.7, 0.99);
    try {
      await redis.set(`tool:intent-top-p:${intentKey}`, String(next), {
        EX: 7 * 24 * 60 * 60,
      });
    } catch (e) {
      console.warn("[tool-search:history] redis set top_p override failed", e);
    }
    return next;
  }

  private recordMemory(sample: HistoryFeedbackSample): void {
    const arr = this.memory.get(sample.resource_id) ?? [];
    arr.push(sample);
    const minTs = Date.now() - this.windowMs;
    this.memory.set(
      sample.resource_id,
      arr.filter((s) => Date.parse(s.call_timestamp) >= minTs).slice(-500),
    );
  }

  private readMemory(resourceId: string): HistoryFeedbackSample[] {
    const minTs = Date.now() - this.windowMs;
    return (this.memory.get(resourceId) ?? []).filter(
      (s) => Date.parse(s.call_timestamp) >= minTs,
    );
  }

  private async getRedis(): Promise<RedisClientType | null> {
    if (!this.redisUrl) return null;
    if (this.redis?.isOpen) return this.redis;
    if (!this.redisConnectPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on("error", (err) =>
        console.warn("[tool-search:history] redis error", err),
      );
      this.redis = client as RedisClientType;
      this.redisConnectPromise = client.connect().then(
        () => undefined,
        (e) => {
          console.warn("[tool-search:history] redis connect failed", e);
          this.redis = null;
        },
      );
    }
    await this.redisConnectPromise;
    return this.redis?.isOpen ? this.redis : null;
  }
}

function computeScore(
  samples: HistoryFeedbackSample[],
  windowMs: number,
  maxLatencyMs: number,
): ResourceHistoryScore {
  if (samples.length === 0) {
    return {
      history_success_score: 0.5,
      failure_penalty: 0,
      latency_score: 0.5,
      failure_rate: 0,
      sample_count: 0,
      consecutive_failures: 0,
    };
  }

  const now = Date.now();
  let weightSum = 0;
  let successQualitySum = 0;
  let failureWeight = 0;
  let latencyWeightedSum = 0;

  const sorted = [...samples].sort(
    (a, b) => Date.parse(a.call_timestamp) - Date.parse(b.call_timestamp),
  );
  for (const sample of sorted) {
    const age = Math.max(0, now - Date.parse(sample.call_timestamp));
    const weight = Math.exp(-age / windowMs);
    weightSum += weight;
    if (sample.success) {
      successQualitySum += weight * sample.result_quality_score;
    } else {
      failureWeight += weight;
    }
    latencyWeightedSum += weight * clamp(1 - sample.latency_ms / maxLatencyMs, 0, 1);
  }

  let consecutiveFailures = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.success) break;
    consecutiveFailures += 1;
  }

  const failureRate = weightSum > 0 ? failureWeight / weightSum : 0;
  return {
    history_success_score:
      weightSum > 0 ? clamp01(successQualitySum / weightSum) : 0.5,
    failure_penalty: clamp01(failureRate),
    latency_score: weightSum > 0 ? clamp01(latencyWeightedSum / weightSum) : 0.5,
    failure_rate: clamp01(failureRate),
    sample_count: samples.length,
    consecutive_failures: consecutiveFailures,
  };
}

function parseSample(raw: string): HistoryFeedbackSample | null {
  try {
    const obj = JSON.parse(raw) as HistoryFeedbackSample;
    if (typeof obj.resource_id !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
