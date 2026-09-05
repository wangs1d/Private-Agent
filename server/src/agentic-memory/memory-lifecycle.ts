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

export type Mem0DeletedNotifier = (deletedIds: string[]) => void;

export class AgenticMemoryLifecycleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private deletedNotifier: Mem0DeletedNotifier | null = null;

  constructor(private readonly memory: Memory) {}

  /**
   * 注入删除通知（P0-3）：TTL 清理/去重绕过 memory-bridge 直接删 Mem0 记录，
   * bootstrap 把通知接到 bridge.handleMem0Deleted 做 linkage 调和（摘除被删 id /
   * tombstone 摘空的链接），否则 bridge_links 里会积累永远扫不完的僵尸链接。
   */
  setDeletedNotifier(notifier: Mem0DeletedNotifier | null): void {
    this.deletedNotifier = notifier;
  }

  private notifyDeleted(ids: string[]): void {
    if (ids.length === 0) return;
    try {
      this.deletedNotifier?.(ids);
    } catch (err) {
      console.warn("[memory-lifecycle] deleted notifier 失败（忽略）:", err);
    }
  }

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

      if (toDelete.length > 0) {
        for (const id of toDelete) {
          await this.memory.delete(id).catch(() => {});
        }
        this.notifyDeleted(toDelete);
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

      // 按 actor 分组后各自去重。getAll 未按 user_id 过滤会返回全部用户的记忆，
      // 若不分组，相似文本（"喜欢喝咖啡"这类）会跨用户互删——用户 A 的写入
      // 可能顶掉用户 B 的既有记忆。缺失 actorId 的旧数据跳过去重（宁保留不误删）。
      const byActor = new Map<string, Mem0MemoryItem[]>();
      for (const mem of allMemories) {
        const actorId =
          typeof mem.metadata?.actorId === "string"
            ? mem.metadata.actorId
            : typeof mem.metadata?.user_id === "string"
              ? mem.metadata.user_id
              : "";
        if (!actorId) continue;
        const group = byActor.get(actorId);
        if (group) group.push(mem);
        else byActor.set(actorId, [mem]);
      }

      let removed = 0;
      for (const group of byActor.values()) {
        removed += this.dedupeActorGroup(group, threshold);
      }

      if (removed > 0) {
        console.info(`[memory-lifecycle] merged ${removed} duplicate memories`);
      }
      return removed;
    } catch {
      return 0;
    }
  }

  private dedupeActorGroup(memories: Mem0MemoryItem[], threshold: number): number {
    const remove = new Set<string>();

    for (let i = 0; i < memories.length; i++) {
      const a = memories[i]!;
      if (remove.has(a.id)) continue;

      for (let j = i + 1; j < memories.length; j++) {
        const b = memories[j]!;
        if (remove.has(b.id)) continue;

        const similarity = this.computeTextSimilarity(a.memory, b.memory);
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
    }

    if (remove.size === 0) return 0;
    for (const id of remove) {
      void this.memory.delete(id).catch(() => {});
    }
    this.notifyDeleted([...remove]);
    return remove.size;
  }

  private parseTimestamp(ts: string | undefined): number {
    if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  /**
   * 文本相似度：单字 + 二元组（bigram）混合 Jaccard。
   * 原实现仅单字集合——中文单字粒度太粗（功能字"的/了/我"共享率高），
   * 改一字就绕过判重；混入 bigram 后语序/词组差异能正确拉开相似度差距。
   */
  private computeTextSimilarity(a: string, b: string): number {
    const grams = (s: string): Set<string> => {
      const t = s.replace(/\s+/g, "");
      const set = new Set<string>();
      for (const ch of t) set.add(ch);
      for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
      return set;
    };

    const setA = grams(a);
    const setB = grams(b);

    let intersect = 0;
    for (const g of setA) {
      if (setB.has(g)) intersect++;
    }

    const union = setA.size + setB.size - intersect;
    return union === 0 ? 0 : intersect / union;
  }
}
