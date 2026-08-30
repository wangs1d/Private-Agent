// 提案持久化队列 + 决策日志（诊断接口数据源）：data/proactivity/proposals.json
import { readJson, writeJson } from "./persist-file.js";
import type { ArbitrationDecision, ProactiveProposal } from "./pipeline-types.js";

type PersistedShape = {
  pending: ProactiveProposal[];
  decisions: ArbitrationDecision[];
  recent: Array<[string, number]>;
};

/** 已投递指纹的保留窗口（防 watcher 重启重扫/同源重复提交导致重复投递） */
const RECENT_DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;

export class ProposalStore {
  /** dedupKey → 提案（待发区：延迟/离线挂起的提案在此等待重仲裁） */
  private readonly pending = new Map<string, ProactiveProposal>();
  /** dedupKey → 最近一次已投递时刻（已投递提案出队后仍防短期内重复提交） */
  private readonly recentDelivered = new Map<string, number>();
  private decisions: ArbitrationDecision[] = [];
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly maxDecisions = 200,
  ) {
    const raw = readJson<PersistedShape>(path, { pending: [], decisions: [], recent: [] });
    for (const p of raw.pending ?? []) this.pending.set(p.dedupKey, p);
    for (const [k, at] of raw.recent ?? []) this.recentDelivered.set(k, at);
    this.decisions = raw.decisions ?? [];
  }

  flush(): void {
    if (!this.dirty) return;
    writeJson(this.path, {
      pending: [...this.pending.values()],
      decisions: this.decisions,
      recent: [...this.recentDelivered],
    });
    this.dirty = false;
  }

  /** 入队；同 dedupKey 已在待发区时以新提案覆盖（保留更晚的 deliverAfter），返回 false=发生了合并 */
  enqueue(p: ProactiveProposal): boolean {
    const existing = this.pending.get(p.dedupKey);
    if (existing) {
      this.pending.set(p.dedupKey, {
        ...p,
        deliverAfter: p.deliverAfter !== undefined || existing.deliverAfter !== undefined
          ? Math.max(p.deliverAfter ?? 0, existing.deliverAfter ?? 0)
          : undefined,
      });
      this.dirty = true;
      return false;
    }
    this.pending.set(p.dedupKey, p);
    this.dirty = true;
    return true;
  }

  take(dedupKey: string): ProactiveProposal | undefined {
    const p = this.pending.get(dedupKey);
    if (p) {
      this.pending.delete(dedupKey);
      this.dirty = true;
    }
    return p;
  }

  /** 投递后记入已投递指纹（prune 超窗旧键） */
  markDelivered(dedupKey: string, at: number): void {
    this.recentDelivered.set(dedupKey, at);
    for (const [k, t] of this.recentDelivered) {
      if (at - t > RECENT_DELIVERED_TTL_MS) this.recentDelivered.delete(k);
    }
    this.dirty = true;
  }

  /** 同 dedupKey 在保留窗口内已投递过 → true（重提交应合并丢弃） */
  wasDeliveredRecently(dedupKey: string, now: number): boolean {
    const at = this.recentDelivered.get(dedupKey);
    return at !== undefined && now - at <= RECENT_DELIVERED_TTL_MS;
  }

  /** 延迟提案更新可发时刻（仍在待发区等待重仲裁） */
  reschedule(dedupKey: string, deliverAfter: number): void {
    const p = this.pending.get(dedupKey);
    if (p) {
      this.pending.set(dedupKey, { ...p, deliverAfter });
      this.dirty = true;
    }
  }

  logDecision(d: ArbitrationDecision): void {
    this.decisions.push(d);
    if (this.decisions.length > this.maxDecisions) {
      this.decisions.splice(0, this.decisions.length - this.maxDecisions);
    }
    this.dirty = true;
  }

  listPending(): ProactiveProposal[] {
    return [...this.pending.values()];
  }

  recentDecisions(limit = 30): ArbitrationDecision[] {
    return this.decisions.slice(-limit);
  }
}
