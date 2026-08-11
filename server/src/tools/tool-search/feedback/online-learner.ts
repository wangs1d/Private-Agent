import { createClient, type RedisClientType } from "redis";

import type { FeedbackReport } from "./feedback-models.js";
import { HistoryScoreStore } from "../retrieval/history-score.js";

export type OnlineLearnerOptions = {
  historyStore?: HistoryScoreStore;
  redisUrl?: string;
};

const INTENT_RESOURCE_WEIGHT_PREFIX = "tool:intent-resource-weight:";

/**
 * Phase-5 在线学习器。
 *
 * 负责：
 *   - 写入 history_success_score / failure_penalty 的滑动窗口样本
 *   - 失败样本降低 intent-resource 匹配权重
 *   - 同类意图连续失败时上调默认 top_p
 */
export class OnlineLearner {
  private readonly historyStore: HistoryScoreStore;
  private readonly redisUrl: string | undefined;
  private redis: RedisClientType | null = null;
  private redisConnectPromise: Promise<void> | null = null;
  private readonly memoryIntentWeights = new Map<string, number>();

  constructor(options?: OnlineLearnerOptions) {
    this.historyStore = options?.historyStore ?? new HistoryScoreStore();
    this.redisUrl =
      (options?.redisUrl ?? process.env.AGENT_REDIS_URL?.trim()) || undefined;
  }

  async report(feedback: FeedbackReport): Promise<{
    ok: true;
    top_p_override: number | null;
    intent_resource_weight: number;
  }> {
    await this.historyStore.record({
      resource_id: feedback.resource_id,
      success: feedback.success,
      latency_ms: feedback.latency_ms,
      result_quality_score: feedback.result_quality_score,
      call_timestamp: feedback.call_timestamp,
    });

    const intentKey = intentGroupKey(feedback);
    let topPOverride: number | null = null;
    let weight = await this.getIntentResourceWeight(intentKey, feedback.resource_id);
    if (!feedback.success) {
      weight = await this.adjustIntentResourceWeight(
        intentKey,
        feedback.resource_id,
        -0.08,
      );
      const history = await this.historyStore.getScore(feedback.resource_id);
      if (history.failure_rate >= 0.4 || history.consecutive_failures >= 2) {
        topPOverride = await this.historyStore.bumpIntentTopP(intentKey);
      }
    } else {
      weight = await this.adjustIntentResourceWeight(
        intentKey,
        feedback.resource_id,
        0.03 * feedback.result_quality_score,
      );
    }

    return { ok: true, top_p_override: topPOverride, intent_resource_weight: weight };
  }

  getHistoryStore(): HistoryScoreStore {
    return this.historyStore;
  }

  async getIntentResourceWeight(
    intentKey: string,
    resourceId: string,
  ): Promise<number> {
    const key = pairKey(intentKey, resourceId);
    const redis = await this.getRedis();
    if (redis) {
      try {
        const raw = await redis.get(INTENT_RESOURCE_WEIGHT_PREFIX + key);
        const n = raw == null ? Number.NaN : Number(raw);
        if (Number.isFinite(n)) return clamp(n, 0, 1);
      } catch (e) {
        console.warn("[tool-search:learner] redis read intent weight failed", e);
      }
    }
    return this.memoryIntentWeights.get(key) ?? 0.5;
  }

  private async adjustIntentResourceWeight(
    intentKey: string,
    resourceId: string,
    delta: number,
  ): Promise<number> {
    const key = pairKey(intentKey, resourceId);
    const current = await this.getIntentResourceWeight(intentKey, resourceId);
    const next = clamp(current + delta, 0, 1);
    this.memoryIntentWeights.set(key, next);

    const redis = await this.getRedis();
    if (redis) {
      try {
        await redis.set(INTENT_RESOURCE_WEIGHT_PREFIX + key, String(next), {
          EX: 7 * 24 * 60 * 60,
        });
      } catch (e) {
        console.warn("[tool-search:learner] redis write intent weight failed", e);
      }
    }
    return next;
  }

  private async getRedis(): Promise<RedisClientType | null> {
    if (!this.redisUrl) return null;
    if (this.redis?.isOpen) return this.redis;
    if (!this.redisConnectPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on("error", (err) =>
        console.warn("[tool-search:learner] redis error", err),
      );
      this.redis = client as RedisClientType;
      this.redisConnectPromise = client.connect().then(
        () => undefined,
        (e) => {
          console.warn("[tool-search:learner] redis connect failed", e);
          this.redis = null;
        },
      );
    }
    await this.redisConnectPromise;
    return this.redis?.isOpen ? this.redis : null;
  }
}

export function intentGroupKey(feedback: Pick<FeedbackReport, "parsed_intent">): string {
  return (
    feedback.parsed_intent.primary_capability ||
    feedback.parsed_intent.domain_candidates[0] ||
    "misc.general"
  );
}

function pairKey(intentKey: string, resourceId: string): string {
  return `${intentKey}:${resourceId}`;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
