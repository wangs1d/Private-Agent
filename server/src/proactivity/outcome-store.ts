// 主动触达结果反馈：落库（data/proactivity/outcomes.json）+ 自适应冷却依据
import { readJson, writeJson } from "./persist-file.js";
import type { ProactiveOutcome } from "./pipeline-types.js";

export type OutcomeRecord = {
  deliveryId: string;
  actorId: string;
  kind: string;
  channel: string;
  outcome: ProactiveOutcome;
  at: number;
};

const POSITIVE_OUTCOMES = new Set<ProactiveOutcome>(["accepted", "replied", "snoozed"]);

export class OutcomeStore {
  private records: OutcomeRecord[] = [];
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly maxRecords = 2000,
  ) {
    this.records = readJson<OutcomeRecord[]>(path, []);
  }

  flush(): void {
    if (!this.dirty) return;
    writeJson(this.path, this.records);
    this.dirty = false;
  }

  record(r: OutcomeRecord): void {
    // 同 deliveryId 以最新 outcome 覆盖（delivered → accepted/dismissed/... 的状态机）
    this.records = this.records.filter((x) => x.deliveryId !== r.deliveryId);
    this.records.push(r);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.dirty = true;
  }

  findByDeliveryId(deliveryId: string): OutcomeRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].deliveryId === deliveryId) return this.records[i];
    }
    return undefined;
  }

  /** 某 kind 近 withinMs 的接受率（accepted/replied/snoozed 算正反馈）；样本不足返回 null */
  acceptanceRate(kind: string, withinMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()): number | null {
    const recent = this.records.filter((r) => r.kind === kind && now - r.at <= withinMs);
    if (recent.length < 5) return null;
    const positive = recent.filter((r) => POSITIVE_OUTCOMES.has(r.outcome)).length;
    return positive / recent.length;
  }

  recent(limit = 30): OutcomeRecord[] {
    return this.records.slice(-limit);
  }
}
