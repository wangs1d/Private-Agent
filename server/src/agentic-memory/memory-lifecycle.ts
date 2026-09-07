import type { Memory } from "mem0ai/oss";

import {
  getMemoryTTLDays,
  getLifecycleIntervalMin,
  getDedupSimilarityThreshold,
  getDedupMaxChecksPerCycle,
  isMemoryReinforcementEnabled,
} from "./env.js";
import type { MemoryReinforcementStore } from "./memory-reinforcement.js";

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

interface Mem0SearchResult {
  results?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>;
}

export type Mem0DeletedNotifier = (deletedIds: string[]) => void;

/** getAll 拉取上限；命中上限说明可能被截断（告警，下轮继续从新扫描） */
const GET_ALL_TOP_K = 10_000;

/** 缺失 importance 的旧数据按中性分处理（不加分不减分） */
const NEUTRAL_IMPORTANCE = 0.5;

function importanceOf(item: Mem0MemoryItem): number {
  const raw = Number(item.metadata?.importance);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
  // 旧数据无连续分：高信号按 0.85，其余中性
  return item.metadata?.highSignal === true ? 0.85 : NEUTRAL_IMPORTANCE;
}

function effectiveTimestamp(item: Mem0MemoryItem): number {
  const created = parseTimestamp(item.createdAt);
  const updated = parseTimestamp(item.updatedAt);
  return Math.max(created, updated);
}

function parseTimestamp(ts: string | undefined): number {
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export class AgenticMemoryLifecycleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private deletedNotifier: Mem0DeletedNotifier | null = null;
  /**
   * 语义去重增量游标：只处理 updatedAt 晚于游标的记忆（新写入/被强化的），
   * 每轮至多 getDedupMaxChecksPerCycle() 次向量检索，存量首轮逐步消化。
   * 进程重启后归零 → 全量重扫一遍（幂等，重复对已合并的库近似 no-op）。
   */
  private dedupCursorMs = 0;

  constructor(
    private readonly memory: Memory,
    private readonly reinforcement: MemoryReinforcementStore | null = null,
  ) {}

  /**
   * 注入删除通知（P0-3）：TTL 清理/去重绕过 memory-bridge 直接删 Mem0 记录，
   * bootstrap 把通知接到 bridge.handleMem0Deleted 做 linkage 调和（摘除被删 id /
   * tombstone 摘空的链接），否则 bridge_links 里会积累永远扫不完的僵尸链接。
   */
  setDeletedNotifier(notifier: Mem0DeletedNotifier | null): void {
    this.deletedNotifier = notifier;
  }

  /** 仅对「确认删除成功」的 id 发通知 + 回收强化侧表行（删除失败不通知，防 bridge 摘空）。 */
  private async deleteConfirmed(ids: string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const id of ids) {
      try {
        await this.memory.delete(id);
        deleted.push(id);
      } catch (err) {
        console.warn(
          `[memory-lifecycle] 删除失败（跳过通知，下轮重试）: ${id}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (deleted.length > 0) {
      this.notifyDeleted(deleted);
      this.reinforcement?.purgeIds(deleted);
    }
    return deleted;
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

  async runCycle(): Promise<{ pruned: number; merged: number; scanned: number }> {
    // 单次全量拉取供 TTL + 去重共享（原实现两阶段各自 getAll 一次，全表扫两遍）
    const allMemories = await this.fetchAll();
    const ttlDays = getMemoryTTLDays();
    let pruned = 0;
    if (ttlDays > 0 && allMemories) {
      pruned = await this.pruneExpired(allMemories, ttlDays);
    }
    let merged = 0;
    if (allMemories) {
      merged = await this.deduplicate(allMemories);
    }
    return { pruned, merged, scanned: allMemories?.length ?? 0 };
  }

  private async fetchAll(): Promise<Mem0MemoryItem[] | null> {
    try {
      const allResult = (await this.memory.getAll({ topK: GET_ALL_TOP_K })) as unknown as Mem0GetAllResult;
      const allMemories = allResult.results ?? [];
      if (allMemories.length >= GET_ALL_TOP_K) {
        console.warn(
          `[memory-lifecycle] getAll 命中 ${GET_ALL_TOP_K} 条上限，记忆库可能被截断扫描——` +
            "建议调大 AGENT_MEMORY_LIFECYCLE_TOP_K 或依赖写入时增量去重兜底",
        );
      }
      return allMemories;
    } catch (err) {
      console.warn(
        "[memory-lifecycle] getAll 失败（本轮跳过）:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * TTL 过期清理（遗忘曲线版）：
   *   - 过期判据用 max(createdAt, updatedAt, lastAccessAt)——经常被召回的记忆
   *     不再因"创建太久"被误删（use-it-or-lose-it）；
   *   - 有效 TTL 按重要性缩放：ttl × (0.5 + importance)，高重要性活得更久、
   *     低重要性加速淡出（importance 缺失按 0.5 中性）；
   *   - importance ≥ 0.8（含旧数据 highSignal）豁免 TTL。
   */
  private async pruneExpired(allMemories: Mem0MemoryItem[], ttlDays: number): Promise<number> {
    const now = Date.now();
    const baseTtlMs = ttlDays * 86_400_000;
    const reinforcementOn = isMemoryReinforcementEnabled() && this.reinforcement;

    const candidates = allMemories.filter((mem) => importanceOf(mem) < 0.8);
    if (candidates.length === 0) return 0;

    const stats = reinforcementOn
      ? this.reinforcement!.getStats(candidates.map((m) => m.id))
      : null;

    const toDelete: string[] = [];
    for (const mem of candidates) {
      const importance = importanceOf(mem);
      const effectiveTtlMs = baseTtlMs * (0.5 + importance);
      let lastAlive = effectiveTimestamp(mem);
      const s = stats?.get(mem.id);
      if (s && s.lastAccessAt > lastAlive) lastAlive = s.lastAccessAt;
      if (now - lastAlive > effectiveTtlMs) toDelete.push(mem.id);
    }

    if (toDelete.length === 0) return 0;
    const deleted = await this.deleteConfirmed(toDelete);
    if (deleted.length > 0) {
      console.info(
        `[memory-lifecycle] pruned ${deleted.length}/${toDelete.length} expired memories ` +
          `(base TTL=${ttlDays}d, importance-scaled)`,
      );
    }
    return deleted.length;
  }

  /**
   * 语义去重（embedding 向量近邻版，替代原单字+bigram Jaccard）：
   * 文本 Jaccard 对同义改写不敏感（改两个字就绕过 0.92 阈值），且 O(n²) 全表
   * 两两比对；Mem0 search 走向量库，同义重复（"喜欢喝咖啡"/"爱喝咖啡"）能正确
   * 判重。增量扫描：只处理游标之后的新记忆，每轮限次，防 embedding API 风暴。
   *
   * 保留策略：importance 高者胜；平手保新（与 supersession 语义一致）。
   * 按 actor 分组检索（search 带 user_id 过滤），天然杜绝跨用户互删；
   * 缺失 actorId 的旧数据跳过去重（宁保留不误删）。
   */
  private async deduplicate(allMemories: Mem0MemoryItem[]): Promise<number> {
    const threshold = getDedupSimilarityThreshold();
    if (threshold <= 0) return 0;

    const cycleStart = Date.now();
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

    // 收集游标之后的待检项，按时间升序（先消化最旧的存量），全局限次
    const pending: Array<{ actorId: string; mem: Mem0MemoryItem; ts: number }> = [];
    for (const [actorId, group] of byActor) {
      for (const mem of group) {
        const ts = effectiveTimestamp(mem);
        if (ts > this.dedupCursorMs) pending.push({ actorId, mem, ts });
      }
    }
    pending.sort((a, b) => a.ts - b.ts);

    const maxChecks = getDedupMaxChecksPerCycle();
    const batch = pending.slice(0, maxChecks);

    let removed = 0;
    let processedThrough = this.dedupCursorMs;
    for (const { actorId, mem, ts } of batch) {
      processedThrough = Math.max(processedThrough, ts);
      removed += await this.dedupeOneMemory(actorId, mem, threshold);
    }

    // 游标推进到本轮最后处理的条目时间；未消化的（限次截断/失败）下轮继续。
    // 本轮完整跑完（batch 未触顶）时推进到 cycleStart，避免旧数据被反复重扫。
    this.dedupCursorMs = batch.length < maxChecks ? cycleStart : processedThrough;

    if (removed > 0) {
      console.info(`[memory-lifecycle] merged ${removed} duplicate memories (semantic)`);
    }
    return removed;
  }

  private async dedupeOneMemory(
    actorId: string,
    mem: Mem0MemoryItem,
    threshold: number,
  ): Promise<number> {
    let result: Mem0SearchResult;
    try {
      result = (await this.memory.search(mem.memory, {
        filters: { user_id: actorId },
        topK: 6,
      })) as unknown as Mem0SearchResult;
    } catch (err) {
      console.warn(
        "[memory-lifecycle] 去重检索失败（该条下轮重试）:",
        err instanceof Error ? err.message : err,
      );
      return 0;
    }

    const selfImportance = importanceOf(mem);
    const selfTs = effectiveTimestamp(mem);
    const toDelete: string[] = [];

    for (const hit of result.results ?? []) {
      if (!hit.id || hit.id === mem.id) continue;
      const sim = hit.score ?? 0;
      if (sim < threshold) continue;
      const hitImportance = Number.isFinite(Number(hit.metadata?.importance))
        ? Math.max(0, Math.min(1, Number(hit.metadata?.importance)))
        : hit.metadata?.highSignal === true
          ? 0.85
          : NEUTRAL_IMPORTANCE;
      const hitTs = Math.max(
        parseTimestamp(hit.metadata?.createdAt as string | undefined),
        parseTimestamp(hit.metadata?.updatedAt as string | undefined),
      );

      // 保留规则：importance 高者胜；平手保新。mem 是待检方——
      // 若对方更该保留，删 mem 并终止（mem 已消失，无需再比其余命中）；
      // 若 mem 更该保留，删对方。
      const memWins =
        selfImportance > hitImportance ||
        (selfImportance === hitImportance && selfTs >= (hitTs || selfTs));
      if (memWins) {
        toDelete.push(hit.id);
      } else {
        toDelete.length = 0; // 不再删别人，只删自己
        toDelete.push(mem.id);
        break;
      }
    }

    if (toDelete.length === 0) return 0;
    const deleted = await this.deleteConfirmed(toDelete);
    return deleted.length;
  }
}
