/**
 * 记忆强度模型（Memory Strength Model）—— 统一"相关性反馈 + 间隔重复强化 + 遗忘曲线"
 *
 * 背景：此前同一份"记忆该在召回时被加分还是降分"被三处各实现一遍：
 *   - MemoryFeedbackStore：显式/隐式反馈分 → 加成/惩罚倍率；
 *   - MemoryReinforcementStore：命中计数 → 线性加固加成；
 *   - memory-implicit-feedback（部分）：把隐式信号翻译成反馈分。
 * 三套独立存储、独立 KV key、三个倍率相乘，既重复又割裂。
 *
 * 本模型把它们合并为一个强度(score, hits, updatedAt)：
 *   - score：用户反馈累积（相关/不相关/纠正），决定加减方向，clamp[-1,1]；
 *   - hits + updatedAt：间隔重复 + 遗忘曲线。每命中一次 hits+1 并刷新 updatedAt，
 *     多次命中让"半衰期"边长（越常用记得越久），长期不再命中则强度按遗忘曲线衰减。
 *   - boostFactor()：一次算出该记忆的总加成倍率 = 反馈倍率 × 时间衰减后的加固倍率。
 *
 * 持久化：KV key `memory_strength`，进程内 per-actor 缓存 + 懒加载（KvSummaryLike 子集）。
 * 失败静默降级，不阻塞 recall 主链路。
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
export interface StrengthKvLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
  setEntry?(actorId: string, key: string, value: unknown): void;
}

export const STRENGTH_KV_KEY = "memory_strength";

/* ---------- 反馈分量 ---------- */
const OUTCOME_DELTA: Record<MemoryFeedbackOutcome, number> = {
  relevant: 0.2,
  irrelevant: -0.25,
  correction: -0.5,
};

/** score>0 时的加成幅度（上限 +25%）。 */
export const FEEDBACK_BOOST_POSITIVE = 0.25;
/** score<0 时的惩罚幅度（最多惩罚到 5%）。 */
const FEEDBACK_PENALTY_NEGATIVE = 0.5;

/* ---------- 间隔重复 / 遗忘曲线分量 ---------- */
/** 单次加固加成上限。 */
const REINFORCEMENT_MAX_BOOST = 0.2;
/** 加固点数饱和阈值（达到后视为已充分巩固）。 */
const REINFORCEMENT_SATURATION = 8;
/** 无任何命中时的基准半衰期（天）。 */
const BASE_HALF_LIFE_DAYS = 7;
/** 单条记忆 hits 硬上限（防膨胀）。 */
const MAX_COUNT = 64;
/** 每 actor 缓存的指纹条数上限。 */
const MAX_ENTRIES = 500;
/** 滚动淘汰后保留条数。 */
const KEEP_ENTRIES = 300;

const MS_PER_DAY = 86_400_000;

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
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
 * 保证写入与召回查询使用同一指纹，才能命中强度）。
 */
export function strengthFingerprint(content: string): string {
  const fp = semanticFingerprint(content);
  if (fp) return fp;
  const normalized = normalizeMemoryLine(content);
  return normalized ? normalized.slice(0, 48) : "";
}

/**
 * 统一记忆强度模型：进程内 per-actor 缓存 + KV 懒加载持久化。
 * 纯逻辑可单测；KvLike 可注入 mock。
 */
export class MemoryStrengthModel {
  private kv: StrengthKvLike | null;
  private cache = new Map<string, { revision: number; entries: Map<string, MemoryFeedbackRecord> }>();

  constructor(kv: StrengthKvLike | null = null) {
    this.kv = kv;
  }

  /** 绑定 KV 持久化适配器（可在注册 kvSummary 后调用）。 */
  attach(kv: StrengthKvLike): void {
    this.kv = kv;
  }

  private load(actorId: string): Map<string, MemoryFeedbackRecord> {
    const cached = this.cache.get(actorId);
    if (cached) return cached.entries;

    const entries = new Map<string, MemoryFeedbackRecord>();
    let revision = 0;
    if (this.kv) {
      try {
        const snapshot = this.kv.getSnapshot(actorId, [STRENGTH_KV_KEY]);
        if (snapshot) {
          revision = snapshot.revision ?? 0;
          const raw = snapshot.entries?.[STRENGTH_KV_KEY];
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
      this.kv.setEntry(actorId, STRENGTH_KV_KEY, {
        revision: nextRevision,
        entries,
      } satisfies MemoryFeedbackSnapshot);
    } catch {
      /* 持久化失败不阻塞（下次写入重试） */
    }
  }

  /** 滚动淘汰低频指纹，防 KV 膨胀。 */
  private trim(entries: Map<string, MemoryFeedbackRecord>): void {
    if (entries.size <= MAX_ENTRIES) return;
    const top = [...entries.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, KEEP_ENTRIES);
    entries.clear();
    for (const [k, v] of top) entries.set(k, v);
  }

  /**
   * 记录一条反馈：按 outcome/delta 累加 score（clamp[-1,1]），并视为一次命中
   * 刷新 hits 与 updatedAt。
   * @returns 更新后的记录；content 为空时返回 null。
   */
  recordFeedback(input: MemoryFeedbackInput): MemoryFeedbackRecord | null {
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content) return null;

    const fp = strengthFingerprint(content);
    if (!fp) return null;

    const entries = this.load(input.actorId);
    const existing = entries.get(fp);
    const delta =
      typeof input.delta === "number" && Number.isFinite(input.delta)
        ? input.delta
        : OUTCOME_DELTA[input.outcome] ?? 0;

    const record: MemoryFeedbackRecord = {
      score: clampScore((existing?.score ?? 0) + delta),
      hits: Math.min(MAX_COUNT, (existing?.hits ?? 0) + 1),
      updatedAt: nowIso(),
    };
    entries.set(fp, record);
    this.persist(input.actorId);
    return record;
  }

  /**
   * 命中强化（间隔重复）：对召回注入的条目按指纹累加计数并刷新 updatedAt。
   * 高频命中让该记忆的半衰期变长（越常用记得越久）。
   */
  recordHits(actorId: string, contents: string[], now: number = Date.now()): void {
    if (contents.length === 0) return;
    const entries = this.load(actorId);
    for (const content of contents) {
      const fp = strengthFingerprint(content);
      if (!fp) continue;
      const existing = entries.get(fp);
      entries.set(fp, {
        score: existing?.score ?? 0,
        hits: Math.min(MAX_COUNT, (existing?.hits ?? 0) + 1),
        updatedAt: new Date(now).toISOString(),
      });
    }
    this.trim(entries);
    this.persist(actorId);
  }

  /**
   * 读取某条记忆的统一加成倍率（用于召回打分）。
   * 1 = 无加成；>1 正向；<1 负向惩罚（下限 0.05）。
   *
   * = 反馈倍率 × 时间衰减后的加固倍率
   * - 反馈倍率：score>0 最多 +25%；score<0 最多惩罚到 5%。
   * - 加固倍率：hits 越多越接近 +20% 上限；但 updatedAt 距今越久越按遗忘曲线衰减，
   *   半衰期随 hits 变长——反复提及长期固化、长期不提自然遗忘。
   */
  boostFactor(actorId: string, content: string, now: number = Date.now()): number {
    const fp = strengthFingerprint(content);
    if (!fp) return 1;
    const record = this.load(actorId).get(fp);
    if (!record) return 1;

    // 1) 反馈分量
    const feedbackF =
      record.score > 0
        ? 1 + FEEDBACK_BOOST_POSITIVE * record.score
        : Math.max(0.05, 1 - FEEDBACK_PENALTY_NEGATIVE * Math.abs(record.score));

    // 2) 加固 × 遗忘曲线（间隔重复）
    const hits = record.hits;
    const updatedMs = new Date(record.updatedAt).getTime();
    const elapsedDays = Number.isFinite(updatedMs) ? (now - updatedMs) / MS_PER_DAY : 0;
    const tauDays = BASE_HALF_LIFE_DAYS * (1 + hits); // 命中越多，记得越久
    const decay = Math.exp((-Math.log(2) * Math.max(0, elapsedDays)) / tauDays);
    const strengthFactor = 1 + REINFORCEMENT_MAX_BOOST * Math.min(1, hits / REINFORCEMENT_SATURATION) * decay;

    return Math.max(0.05, feedbackF * strengthFactor);
  }

  /** 读取 actor 的完整强度快照（调试/诊断用）。 */
  snapshot(actorId: string): MemoryFeedbackSnapshot {
    const entries: Record<string, MemoryFeedbackRecord> = {};
    for (const [fp, record] of this.load(actorId)) {
      entries[fp] = record;
    }
    const cached = this.cache.get(actorId);
    return { revision: cached?.revision ?? 0, entries };
  }
}