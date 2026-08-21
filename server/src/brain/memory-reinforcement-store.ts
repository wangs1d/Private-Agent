/**
 * 记忆强化计数存储（Memory Reinforcement Store）—— 类人记忆巩固（P5）
 *
 * 间隔重复效应：被反复召回命中的记忆衰减更慢。每次 recall 命中按语义指纹 +1，
 * 召回打分时对高频命中条目给小幅加成（上限 +20%），模拟"常用记忆被巩固"。
 *
 * 设计约束（与 feedback/anchor store 一致）：
 * - KV 持久化（key `memory_reinforcement`），进程内 per-actor 缓存 + 懒加载；
 * - 每 actor 只保留 fingerprint → count 映射（无正文，KV 不膨胀）；
 * - 失败静默降级，不阻塞 recall 主链路。
 */

import { semanticFingerprint } from "../services/memory-record-utils.js";

export const REINFORCEMENT_KV_KEY = "memory_reinforcement";

/** 每指纹计数上限（超过视为已充分巩固，不再累积）。 */
const MAX_COUNT = 10;
/** 单次加成上限。 */
const MAX_BOOST = 0.2;

/** KV 持久化适配器（与 KvSummaryLike 同形状）。 */
export interface ReinforcementKvLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
  setEntry?(actorId: string, key: string, value: unknown): void;
}

function parseCounts(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k && typeof v === "number" && Number.isFinite(v) && v > 0) out.set(k, Math.floor(v));
    }
  }
  return out;
}

export class MemoryReinforcementStore {
  private kv: ReinforcementKvLike | null;
  private cache = new Map<string, Map<string, number>>();

  constructor(kv: ReinforcementKvLike | null = null) {
    this.kv = kv;
  }

  attach(kv: ReinforcementKvLike): void {
    this.kv = kv;
  }

  private load(actorId: string): Map<string, number> {
    const cached = this.cache.get(actorId);
    if (cached) return cached;
    let counts = new Map<string, number>();
    if (this.kv) {
      try {
        const raw = this.kv.getSnapshot(actorId, [REINFORCEMENT_KV_KEY]);
        if (raw?.entries?.[REINFORCEMENT_KV_KEY]) counts = parseCounts(raw.entries[REINFORCEMENT_KV_KEY]);
      } catch {
        /* KV 读取失败使用空计数 */
      }
    }
    this.cache.set(actorId, counts);
    return counts;
  }

  /** 命中强化：对召回注入的条目按指纹累加计数（滚动淘汰防膨胀）。 */
  record(actorId: string, contents: string[]): void {
    if (contents.length === 0) return;
    const counts = this.load(actorId);
    for (const content of contents) {
      const fp = semanticFingerprint(content);
      if (!fp) continue;
      counts.set(fp, Math.min(MAX_COUNT, (counts.get(fp) ?? 0) + 1));
    }
    if (counts.size > 500) {
      // 滚动淘汰：保计数最高的 300 条（低频指纹自然淘汰）
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
      counts.clear();
      for (const [k, v] of top) counts.set(k, v);
    }
    if (!this.kv?.setEntry) return;
    try {
      this.kv.setEntry(actorId, REINFORCEMENT_KV_KEY, Object.fromEntries(counts));
    } catch {
      /* 持久化失败不阻塞 */
    }
  }

  /** 读取某条内容的强化加成（1 = 无强化；最高 1 + MAX_BOOST）。 */
  getBoost(actorId: string, content: string): number {
    const fp = semanticFingerprint(content);
    const count = fp ? this.load(actorId).get(fp) ?? 0 : 0;
    return count > 0 ? 1 + MAX_BOOST * (count / MAX_COUNT) : 1;
  }

  /** 读取某 actor 的强化快照（诊断用）。 */
  getSnapshot(actorId: string): Record<string, number> {
    return Object.fromEntries(this.load(actorId));
  }
}
