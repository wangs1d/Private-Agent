/**
 * 记忆相关性在线反馈存储（Memory Feedback Store）
 *
 * 实现"记忆相关性在线反馈回灌"：
 * - 记录用户对记忆的反馈（显式 API / 隐式纠正信号），按语义指纹持久化到 KV；
 * - 召回时根据反馈分数对记忆条目做加成/惩罚，调整最终排序（相关性在线学习）。
 *
 * 反馈模型：
 * - outcome: relevant(+0.2) / irrelevant(-0.25) / correction(-0.5)
 * - score ∈ [-1, 1]，越接近 1 表示越被用户认可，越接近 -1 表示越被纠正/否定。
 * - 召回加成（multiplier）：
 *   score > 0 → 1 + 0.25 × score（最多 +25%）
 *   score < 0 → max(0.05, 1 − 0.5 × |score|)（最多惩罚到 5%）
 *
 * 持久化：通过 KvLike（KvSummaryLike 子集）写入 key "memory_feedback"，
 * 结构 { revision, entries: { [fingerprint]: { score, hits, updatedAt } } }。
 * 进程内维护 per-actor 缓存，读时懒加载，写后即时回写 KV。
 */

import { normalizeMemoryLine, semanticFingerprint } from "../services/memory-record-utils.js";

export type MemoryFeedbackOutcome = "relevant" | "irrelevant" | "correction";

export interface MemoryFeedbackRecord {
  score: number;
  hits: number;
  updatedAt: string;
}

export interface MemoryFeedbackInput {
  actorId: string;
  content: string;
  outcome: MemoryFeedbackOutcome;
  /** 可选：显式覆盖增量（默认按 outcome 映射）。 */
  delta?: number;
}

export interface MemoryFeedbackSnapshot {
  revision: number;
  entries: Record<string, MemoryFeedbackRecord>;
}

/** KV 持久化适配器（KvSummaryLike 子集）。 */
export interface FeedbackKvLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
  setEntry?(actorId: string, key: string, value: unknown): void;
}

export const FEEDBACK_KV_KEY = "memory_feedback";

const OUTCOME_DELTA: Record<MemoryFeedbackOutcome, number> = {
  relevant: 0.2,
  irrelevant: -0.25,
  correction: -0.5,
};

export const FEEDBACK_BOOST_POSITIVE = 0.25;
export const FEEDBACK_PENALTY_NEGATIVE = 0.5;

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseStoredEntry(value: unknown): MemoryFeedbackRecord | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const score = typeof o.score === "number" && Number.isFinite(o.score) ? o.score : 0;
  const hits = typeof o.hits === "number" && Number.isFinite(o.hits) ? o.hits : 0;
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : nowIso();
  return { score: clampScore(score), hits, updatedAt };
}

/**
 * 语义指纹（与 memory-record-utils.semanticFingerprint 对齐，
 * 保证写入与召回查询使用同一指纹，才能命中反馈）。
 */
export function feedbackFingerprint(content: string): string {
  const fp = semanticFingerprint(content);
  if (fp) return fp;
  const normalized = normalizeMemoryLine(content);
  return normalized ? normalized.slice(0, 48) : "";
}

/**
 * 在线反馈存储：进程内 per-actor 缓存 + KV 懒加载持久化。
 * 纯逻辑可单测；KvLike 可注入 mock。
 */
export class MemoryFeedbackStore {
  private kv: FeedbackKvLike | null;
  private cache = new Map<string, { revision: number; entries: Map<string, MemoryFeedbackRecord> }>();

  constructor(kv: FeedbackKvLike | null = null) {
    this.kv = kv;
  }

  /** 绑定 KV 持久化适配器（可在注册 kvSummary 后调用）。 */
  attach(kv: FeedbackKvLike): void {
    this.kv = kv;
  }

  private load(actorId: string): Map<string, MemoryFeedbackRecord> {
    const cached = this.cache.get(actorId);
    if (cached) return cached.entries;

    const entries = new Map<string, MemoryFeedbackRecord>();
    let revision = 0;
    if (this.kv) {
      try {
        const snapshot = this.kv.getSnapshot(actorId, [FEEDBACK_KV_KEY]);
        if (snapshot) {
          revision = snapshot.revision ?? 0;
          const raw = snapshot.entries?.[FEEDBACK_KV_KEY];
          if (raw && typeof raw === "object") {
            const o = raw as Record<string, unknown>;
            const rawEntries = o.entries;
            if (rawEntries && typeof rawEntries === "object") {
              for (const [fp, value] of Object.entries(rawEntries as Record<string, unknown>)) {
                const record = parseStoredEntry(value);
                if (record) entries.set(fp, record);
              }
            }
          }
        }
      } catch {
        /* KV 读取失败时使用空缓存，不影响主流程 */
      }
    }

    this.cache.set(actorId, { revision, entries });
    return entries;
  }

  private persist(actorId: string): void {
    const cached = this.cache.get(actorId);
    if (!cached || !this.kv?.setEntry) return;
    const entries: Record<string, MemoryFeedbackRecord> = {};
    for (const [fp, record] of cached.entries) {
      entries[fp] = record;
    }
    const nextRevision = cached.revision + 1;
    cached.revision = nextRevision;
    try {
      this.kv.setEntry(actorId, FEEDBACK_KV_KEY, {
        revision: nextRevision,
        entries,
      } satisfies MemoryFeedbackSnapshot);
    } catch {
      /* 持久化失败不阻塞（下次写入重试） */
    }
  }

  /**
   * 记录一条反馈：按指纹累加 score（clamp [-1,1]），并回写 KV。
   * @returns 更新后的反馈记录；content 为空时返回 null。
   */
  record(input: MemoryFeedbackInput): MemoryFeedbackRecord | null {
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content) return null;

    const fp = feedbackFingerprint(content);
    if (!fp) return null;

    const entries = this.load(input.actorId);
    const existing = entries.get(fp);
    const delta =
      typeof input.delta === "number" && Number.isFinite(input.delta)
        ? input.delta
        : OUTCOME_DELTA[input.outcome] ?? 0;

    const record: MemoryFeedbackRecord = {
      score: clampScore((existing?.score ?? 0) + delta),
      hits: (existing?.hits ?? 0) + 1,
      updatedAt: nowIso(),
    };
    entries.set(fp, record);
    this.persist(input.actorId);
    return record;
  }

  /**
   * 查询反馈调整乘数（用于召回打分）。
   * 1 = 无反馈；>1 正向加成；<1 负向惩罚（下限 0.05）。
   */
  getMultiplier(actorId: string, content: string): number {
    const fp = feedbackFingerprint(content);
    if (!fp) return 1;
    const record = this.load(actorId).get(fp);
    if (!record) return 1;
    if (record.score > 0) return 1 + FEEDBACK_BOOST_POSITIVE * record.score;
    return Math.max(0.05, 1 - FEEDBACK_PENALTY_NEGATIVE * Math.abs(record.score));
  }

  /** 读取 actor 的完整反馈快照（调试/统计用）。 */
  snapshot(actorId: string): MemoryFeedbackSnapshot {
    const entries: Record<string, MemoryFeedbackRecord> = {};
    for (const [fp, record] of this.load(actorId)) {
      entries[fp] = record;
    }
    const cached = this.cache.get(actorId);
    return { revision: cached?.revision ?? 0, entries };
  }
}
