import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExternalChatProvider } from "../external-model/types.js";
import { recordLlmUsageByChars } from "./llm-token-audit.js";

export type MoodInferenceSource = "conversation" | "behavior" | "context";

export type MoodInference = {
  sessionId: string;
  /** -1 (very negative) to 1 (very positive) */
  sentimentScore: number;
  /** 0 to 1, how confident the inference is */
  confidence: number;
  /** Chinese emotion tags like ["压力", "疲惫", "焦虑", "开心", "放松"] */
  emotionTags: string[];
  source: MoodInferenceSource;
  /** Snapshot of raw signals used to derive this inference */
  rawSignals: Record<string, unknown>;
  /** Optional Agent's private note to itself */
  agentNote?: string;
  timestamp: string;
};

export type DailyMoodAggregate = {
  date: string; // YYYY-MM-DD
  sessionId: string;
  avgSentiment: number;
  dominantTags: string[];
  sampleCount: number;
};

export type MoodCareDecision =
  | {
      shouldCare: true;
      reason: "negative" | "positive";
      sentimentScore: number;
      emotionTags: string[];
    }
  | { shouldCare: false };

export type MoodInferenceServiceDeps = {
  externalChat: ExternalChatProvider | null;
  /** Path to JSONL persistence file. If null, persistence is disabled. */
  persistFilePath?: string | null;
  /** Optional logger */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export class MoodInferenceService {
  /** sessionId -> inferences (chronological) */
  private readonly inferences = new Map<string, MoodInference[]>();
  /** Max inferences per session in memory */
  private readonly maxPerSession = 5000; // Increased from 500
  /** Care rate limit: sessionId+reason -> last sent timestamp */
  private readonly lastCareAt = new Map<string, number>();
  /** Analysis cache: hash -> { ts, topics }（topics 供 TopicExtractor 合并复用，省一次每轮 LLM 调用） */
  private readonly analysisCache = new Map<string, { ts: number; topics: string[] }>();
  private readonly analysisCacheTtlMs = 5 * 60 * 1000;
  /** Write queue: serialize file appends */
  private writeQueue: Promise<void> = Promise.resolve();
  private writeQueueSize = 0;
  private readonly maxQueueSize = 1000;
  private loaded = false;

  constructor(private readonly deps: MoodInferenceServiceDeps = { externalChat: null }) {}

  /** Load persisted inferences from JSONL file. Call once at startup. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.deps.persistFilePath) return;
    try {
      const raw = await readFile(this.deps.persistFilePath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const inf = JSON.parse(line) as MoodInference;
          if (!inf.sessionId || !inf.timestamp) continue;
          const list = this.inferences.get(inf.sessionId) ?? [];
          list.push(inf);
          if (list.length > this.maxPerSession) {
            list.splice(0, list.length - this.maxPerSession);
          }
          this.inferences.set(inf.sessionId, list);
        } catch {
          // skip malformed line
        }
      }
      this.deps.logger?.info(`[MoodInference] Loaded ${this.countTotal()} inferences from ${this.deps.persistFilePath}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        this.deps.logger?.warn(`[MoodInference] load failed: ${err.message}`);
      }
    }
  }

  /** Record a new mood inference. */
  record(inference: Omit<MoodInference, "timestamp">): MoodInference {
    const full: MoodInference = { ...inference, timestamp: new Date().toISOString() };
    const list = this.inferences.get(full.sessionId) ?? [];
    list.push(full);
    if (list.length > this.maxPerSession) {
      list.splice(0, list.length - this.maxPerSession);
    }
    this.inferences.set(full.sessionId, list);
    this.schedulePersist(full);
    return full;
  }

  private schedulePersist(inference: MoodInference): void {
    if (!this.deps.persistFilePath) return;
    if (this.writeQueueSize >= this.maxQueueSize) {
      // Drop oldest writes to prevent unbounded growth
      this.deps.logger?.warn("[MoodInference] persist queue full, dropping write");
      return;
    }
    this.writeQueueSize += 1;
    this.writeQueue = this.writeQueue
      .then(() => this.persistOne(inference))
      .catch((e) => {
        this.deps.logger?.warn(`[MoodInference] persist failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.writeQueueSize -= 1;
      });
  }

  private async persistOne(inference: MoodInference): Promise<void> {
    if (!this.deps.persistFilePath) return;
    await mkdir(dirname(this.deps.persistFilePath), { recursive: true });
    await appendFile(this.deps.persistFilePath, JSON.stringify(inference) + "\n", "utf-8");
  }

  /** Wait for all pending writes to flush. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /** Get all inferences for a session. */
  listForSession(sessionId: string, limit = 50): MoodInference[] {
    const list = this.inferences.get(sessionId) ?? [];
    return [...list].slice(-limit).reverse();
  }

  /** Get daily aggregates for the last N days. */
  dailyAggregates(sessionId: string, days = 7): DailyMoodAggregate[] {
    const list = this.inferences.get(sessionId) ?? [];
    const byDate = new Map<string, MoodInference[]>();
    for (const inf of list) {
      const date = inf.timestamp.slice(0, 10);
      const arr = byDate.get(date) ?? [];
      arr.push(inf);
      byDate.set(date, arr);
    }
    const allDates = [...byDate.keys()].sort().reverse().slice(0, days);
    return allDates.map((date) => {
      const arr = byDate.get(date)!;
      const totalWeight = Math.max(1e-9, arr.reduce((s, x) => s + x.confidence, 0));
      const avg = arr.reduce((s, x) => s + x.sentimentScore * x.confidence, 0) / totalWeight;
      const tagCounts = new Map<string, number>();
      for (const x of arr) for (const t of x.emotionTags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      const dominantTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
      return {
        date,
        sessionId,
        avgSentiment: Number(avg.toFixed(3)),
        dominantTags,
        sampleCount: arr.length,
      };
    });
  }

  /** Get today's current mood. */
  todayMood(sessionId: string): DailyMoodAggregate | null {
    return this.dailyAggregates(sessionId, 1)[0] ?? null;
  }

  /**
   * Decide whether the agent should proactively care based on a single inference.
   * Triggers on extreme low or notable positive emotions, not on streaks.
   */
  decideCare(inference: MoodInference): MoodCareDecision {
    if (inference.confidence < 0.6) return { shouldCare: false };
    if (inference.sentimentScore < -0.2) {
      return {
        shouldCare: true,
        reason: "negative",
        sentimentScore: inference.sentimentScore,
        emotionTags: inference.emotionTags,
      };
    }
    if (inference.sentimentScore > 0.3) {
      return {
        shouldCare: true,
        reason: "positive",
        sentimentScore: inference.sentimentScore,
        emotionTags: inference.emotionTags,
      };
    }
    return { shouldCare: false };
  }

  /** Returns true if the user is not in a recent care cooldown. Records the timestamp if so. */
  shouldSendCare(sessionId: string, reason: "negative" | "positive"): boolean {
    const key = `${sessionId}:${reason}`;
    const last = this.lastCareAt.get(key) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < 24 * 60 * 60 * 1000) return false;
    this.lastCareAt.set(key, Date.now());
    return true;
  }

  /** Total number of inferences in memory. */
  countTotal(): number {
    let sum = 0;
    for (const list of this.inferences.values()) sum += list.length;
    return sum;
  }

  /**
   * Use LLM to analyze a user message and infer mood.
   * Returns null if LLM is unavailable, analysis fails, or message is cached.
   *
   * 与 TopicExtractor 合并（每轮 LLM 调用削减）：同一次调用顺带提取 1-3 个
   * 话题关键词，缓存于 analysisCache；brain-center 通过 getTopicsFromCache
   * 读取并写入 working memory 主题槽，仅在本调用未覆盖时才回退独立 TopicExtractor。
   */
  async analyzeMessage(sessionId: string, userMessage: string): Promise<MoodInference | null> {
    if (!this.deps.externalChat || !this.deps.externalChat.isEnabled()) return null;
    const text = userMessage.trim();
    if (!text) return null;

    // Cache check
    const cacheKey = createHash("sha256").update(`${sessionId}:${text}`).digest("hex").slice(0, 32);
    const cached = this.analysisCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.analysisCacheTtlMs) {
      return null;
    }
    this.analysisCache.set(cacheKey, { ts: Date.now(), topics: [] });
    // Trim cache periodically
    if (this.analysisCache.size > 1000) {
      const cutoff = Date.now() - this.analysisCacheTtlMs;
      for (const [k, v] of this.analysisCache) {
        if (v.ts < cutoff) this.analysisCache.delete(k);
      }
    }

    try {
      const prompt = `分析用户消息的情感，并提取话题关键词，输出 JSON 格式（仅输出 JSON，无其他内容）：
{"sentimentScore": <-1 到 1 的小数，-1 极差、0 中性、1 极好>, "confidence": <0 到 1>, "emotionTags": [<中文标签，最多 3 个>], "topics": [<1-3 个业务领域/话题关键词，如 "旅行","编程","健康">], "agentNote": "<给 Agent 自己看的一句话>"}

用户消息：${text.slice(0, 1000)}`;
      let auditInputChars = prompt.length;
      const result = await this.deps.externalChat.streamCompletion(
        `mood-inference:${sessionId}`,
        { text: prompt },
        () => {},
        undefined,
        { systemPromptOverride: "你是一个情感分析助手，只输出 JSON，不要任何解释。" },
      );
      // Token 用量审计：情绪推断（每轮用户消息最多一次）
      try {
        recordLlmUsageByChars({
          stage: "mood_inference",
          sessionId,
          inputChars: auditInputChars,
          outputChars: result?.length ?? 0,
        });
      } catch {
        /* 审计失败静默 */
      }
      if (!result) return null;
      const jsonMatch = String(result).match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const score = Number(parsed.sentimentScore);
      const conf = Number(parsed.confidence);
      if (!Number.isFinite(score) || !Number.isFinite(conf)) return null;
      const tags = Array.isArray(parsed.emotionTags)
        ? parsed.emotionTags.map((t) => String(t)).filter(Boolean).slice(0, 3)
        : [];
      const topics = Array.isArray(parsed.topics)
        ? parsed.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
        : [];
      // 回填 topics 到缓存（供 TopicExtractor 合并消费；含空结果，避免重复回退调用）
      const entry = this.analysisCache.get(cacheKey);
      if (entry) entry.topics = topics;
      return this.record({
        sessionId,
        sentimentScore: Math.max(-1, Math.min(1, score)),
        confidence: Math.max(0, Math.min(1, conf)),
        emotionTags: tags,
        source: "conversation",
        rawSignals: { userMessagePreview: text.slice(0, 200) },
        agentNote: parsed.agentNote ? String(parsed.agentNote) : undefined,
      });
    } catch (e) {
      this.deps.logger?.warn(`[MoodInference] analyzeMessage failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * 读取最近一次 analyzeMessage 顺带提取的话题关键词（不触发 LLM）。
   * 缓存未命中 / 已过期 / 该次调用未产出话题时返回 null（调用方回退独立 TopicExtractor）。
   */
  getTopicsFromCache(sessionId: string, userMessage: string): string[] | null {
    const text = userMessage.trim();
    if (!text) return null;
    const cacheKey = createHash("sha256").update(`${sessionId}:${text}`).digest("hex").slice(0, 32);
    const cached = this.analysisCache.get(cacheKey);
    if (!cached || Date.now() - cached.ts >= this.analysisCacheTtlMs) return null;
    return cached.topics.length > 0 ? cached.topics : null;
  }
}
