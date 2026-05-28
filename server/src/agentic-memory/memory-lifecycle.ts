import type { Memory } from "mem0ai/oss";

import {
  getMemoryTTLDays,
  getLifecycleIntervalMin,
  getDedupSimilarityThreshold,
} from "./env.js";

interface Mem0MemoryItem {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  score?: number;
}

interface Mem0GetAllResult {
  results: Mem0MemoryItem[];
}

export class AgenticMemoryLifecycleService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly memory: Memory) {}

  start(): void {
    const ttlDays = getMemoryTTLDays();
    const intervalMin = getLifecycleIntervalMin();
    if (ttlDays <= 0 || intervalMin <= 0) return;

    const intervalMs = intervalMin * 60_000;
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) =>
        console.warn("[memory-lifecycle] cycle error:", err instanceof Error ? err.message : err),
      );
    }, intervalMs);
    this.timer.unref();

    console.info(
      `[memory-lifecycle] started (TTL=${ttlDays}d, interval=${intervalMin}min)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runCycle(): Promise<{ pruned: number; merged: number }> {
    const ttlDays = getMemoryTTLDays();
    let pruned = 0;
    if (ttlDays > 0) {
      pruned = await this.pruneExpired(ttlDays);
    }
    const merged = await this.deduplicate();
    return { pruned, merged };
  }

  private async pruneExpired(ttlDays: number): Promise<number> {
    const cutoff = Date.now() - ttlDays * 86_400_000;

    try {
      const allResult = (await this.memory.getAll({ topK: 10000 })) as unknown as Mem0GetAllResult;
      const allMemories = allResult.results ?? [];
      if (!allMemories.length) return 0;

      const toDelete: string[] = [];
      for (const mem of allMemories) {
        const isHighSignal = mem.metadata?.highSignal === true;
        if (isHighSignal) continue;

        const ts = mem.createdAt ?? mem.updatedAt;
        if (typeof ts === "string") {
          const parsed = Date.parse(ts);
          if (Number.isFinite(parsed) && parsed < cutoff) {
            toDelete.push(mem.id);
          }
        }
      }

      for (const id of toDelete) {
        await this.memory.delete(id).catch(() => {});
      }

      if (toDelete.length > 0) {
        console.info(
          `[memory-lifecycle] pruned ${toDelete.length} expired memories (cutoff=${new Date(cutoff).toISOString().slice(0, 10)})`,
        );
      }
      return toDelete.length;
    } catch {
      return 0;
    }
  }

  private async deduplicate(): Promise<number> {
    const threshold = getDedupSimilarityThreshold();
    if (threshold <= 0) return 0;

    try {
      const allResult = (await this.memory.getAll({ topK: 10000 })) as unknown as Mem0GetAllResult;
      const allMemories = allResult.results ?? [];
      if (allMemories.length < 2) return 0;

      const keep = new Set<string>();
      const remove = new Set<string>();

      for (let i = 0; i < allMemories.length; i++) {
        const a = allMemories[i]!;
        if (remove.has(a.id)) continue;

        for (let j = i + 1; j < allMemories.length; j++) {
          const b = allMemories[j]!;
          if (remove.has(b.id) || keep.has(b.id)) continue;

          const similarity = await this.computeJaccardSimilarity(a.memory, b.memory);
          if (similarity >= threshold) {
            const aIsHighSignal = a.metadata?.highSignal === true;
            const bIsHighSignal = b.metadata?.highSignal === true;

            const aAge = this.parseTimestamp(a.createdAt ?? a.updatedAt);
            const bAge = this.parseTimestamp(b.createdAt ?? b.updatedAt);

            if (aIsHighSignal && !bIsHighSignal) {
              remove.add(b.id);
            } else if (!aIsHighSignal && bIsHighSignal) {
              remove.add(a.id);
            } else if (aAge > bAge) {
              remove.add(b.id);
            } else {
              remove.add(a.id);
            }
          }
        }
        if (!remove.has(a.id)) {
          keep.add(a.id);
        }
      }

      if (remove.size > 0) {
        for (const id of remove) {
          await this.memory.delete(id).catch(() => {});
        }
        console.info(`[memory-lifecycle] merged ${remove.size} duplicate memories`);
      }
      return remove.size;
    } catch {
      return 0;
    }
  }

  private parseTimestamp(ts: string | undefined): number {
    if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  private async computeJaccardSimilarity(a: string, b: string): Promise<number> {
    const normalize = (s: string) => {
      const chars = new Set(s.replace(/\s+/g, ""));
      return chars;
    };

    const setA = normalize(a);
    const setB = normalize(b);

    let intersect = 0;
    for (const ch of setA) {
      if (setB.has(ch)) intersect++;
    }

    const union = setA.size + setB.size - intersect;
    return union === 0 ? 0 : intersect / union;
  }
}
