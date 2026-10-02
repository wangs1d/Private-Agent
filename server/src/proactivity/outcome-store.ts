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
  /** 话题键（2026-10-01：投递时从提案标题归一，话题级 dismiss 追踪用） */
  topic?: string;
};

const POSITIVE_OUTCOMES = new Set<ProactiveOutcome>(["accepted", "replied", "snoozed"]);
/** 已产生用户决策的 outcome（delivered/viewed 只是展示事实，不进时段画像） */
const DECIDED_OUTCOMES = new Set<ProactiveOutcome>([
  "accepted",
  "replied",
  "snoozed",
  "dismissed",
  "ignored",
]);

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
    // viewed（应用内 impression）不进分母——它是展示事实而非用户决策，计入会稀释接受率
    const recent = this.records.filter(
      (r) => r.kind === kind && now - r.at <= withinMs && r.outcome !== "viewed",
    );
    if (recent.length < 5) return null;
    const positive = recent.filter((r) => POSITIVE_OUTCOMES.has(r.outcome)).length;
    return positive / recent.length;
  }

  recent(limit = 30): OutcomeRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * 按小时接受率画像（2026-10-01，零 LLM 统计）：近 withinMs 内该 actor 各时段
   * 的已决策 outcome 接受率（Laplace 平滑，样本 ≥3 才值得信）。
   * 只统计已决策记录（accepted/replied/snoozed 正、dismissed/ignored 负），
   * delivered/viewed 不进分母。供 ArbiterV2 receptivity 与 rhythm 画像融合。
   */
  hourlyReceptivity(
    actorId: string,
    now = Date.now(),
    withinMs = 30 * 24 * 60 * 60 * 1000,
  ): Map<number, { rate: number; samples: number }> {
    const buckets = new Map<number, { pos: number; total: number }>();
    for (const r of this.records) {
      if (r.actorId !== actorId || now - r.at > withinMs) continue;
      if (!DECIDED_OUTCOMES.has(r.outcome)) continue;
      const hour = new Date(r.at).getHours();
      const b = buckets.get(hour) ?? { pos: 0, total: 0 };
      b.total += 1;
      if (POSITIVE_OUTCOMES.has(r.outcome)) b.pos += 1;
      buckets.set(hour, b);
    }
    const out = new Map<number, { rate: number; samples: number }>();
    for (const [hour, b] of buckets) {
      out.set(hour, { rate: (b.pos + 1) / (b.total + 2), samples: b.total });
    }
    return out;
  }
}
