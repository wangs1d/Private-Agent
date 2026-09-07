/**
 * 注意力台账（AttentionStore）—— 每一次「主动触达」的投递记录与 ack 归一。
 *
 * 设计要点（分级触达方案）：
 *  - 任何主动事件在 ReachRouter 投递前先落一条 record；投递到哪个通道
 *    （chat/popup/voice/phone）逐次追加到 deliveries
 *  - ack 归一：用户在对话里回话、弹窗点按钮、收件箱处理、通知点击，
 *    任何一个入口都落到同一个 ackAt/ackVia —— 升级计时看到 ack 即停
 *  - confirm 类记录携带 confirmId，与 PendingConfirmationStore 同生命周期：
 *    hub 侧 resolve 时经 router.resolveByConfirmId 同步闭合
 *  - 落盘 data/proactivity/attention.json（低频写，直接 readJson/writeJson）
 */
import { readJson, writeJson } from "./persist-file.js";

export type AttentionUrgency = "interrupt" | "alert" | "normal" | "log";

/** 紧迫度权重（升级判定用，越大越急） */
export const URGENCY_RANK: Record<AttentionUrgency, number> = {
  log: 0,
  normal: 1,
  alert: 2,
  interrupt: 3,
};

export type AttentionDecision = "confirm" | "fyi" | "none";

export type AttentionChannel = "chat" | "popup" | "voice" | "phone";

export type AttentionDelivery = {
  channel: AttentionChannel;
  at: number;
  /** 投递结果描述（delivered / offline_stored / failed:...） */
  detail?: string;
};

export type AttentionState = "open" | "acked" | "resolved" | "expired";

export type AttentionRecord = {
  id: string;
  actorId: string;
  kind: string;
  title: string;
  summary: string;
  urgency: AttentionUrgency;
  decision: AttentionDecision;
  /** 是否涉及花钱（客户端渲染确认按钮的依据） */
  spend: boolean;
  createdAt: number;
  /** 截止时间 ms；null=无期限（不参与临期升级） */
  deadlineAt: number | null;
  state: AttentionState;
  /** 关联的挂起确认 id（decision=confirm 时存在） */
  confirmId?: string;
  /** 当前已投递到的阶梯级别（-1=尚未投递） */
  level: number;
  deliveries: AttentionDelivery[];
  ackAt?: number;
  ackVia?: string;
  resolvedAt?: number;
  resolveNote?: string;
  /** 用户在哪个界面看到的（client 上报用，透传展示） */
  meta?: Record<string, unknown>;
};

type AttentionFileShape = { version: 1; records: AttentionRecord[] };

let idSeq = 0;

function nextAttentionId(): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `at_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

const MAX_RECORDS = 500;
/** closed（acked/resolved/expired）记录的保留期 */
const CLOSED_RETENTION_MS = 48 * 60 * 60_000;

export class AttentionStore {
  private readonly records = new Map<string, AttentionRecord>();
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly path?: string) {
    if (path) {
      const raw = readJson<AttentionFileShape>(path, { version: 1, records: [] });
      const now = Date.now();
      for (const r of raw.records ?? []) {
        // closed 记录过保留期即弃；open 记录带截止时间的按过期处理
        if (r.state !== "open") {
          const closedAt = r.resolvedAt ?? r.ackAt ?? 0;
          if (now - closedAt > CLOSED_RETENTION_MS) continue;
        }
        this.records.set(r.id, r);
      }
    }
  }

  /** 登记一条触达记录（投递前调用；channel ladder 由 router 回填） */
  create(input: {
    actorId: string;
    kind: string;
    title: string;
    summary: string;
    urgency: AttentionUrgency;
    decision: AttentionDecision;
    spend?: boolean;
    deadlineAt?: number | null;
    confirmId?: string;
    meta?: Record<string, unknown>;
  }): AttentionRecord {
    const record: AttentionRecord = {
      id: nextAttentionId(),
      actorId: input.actorId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      urgency: input.urgency,
      decision: input.decision,
      spend: input.spend ?? false,
      createdAt: Date.now(),
      deadlineAt: input.deadlineAt ?? null,
      state: "open",
      confirmId: input.confirmId,
      level: -1,
      deliveries: [],
      meta: input.meta,
    };
    this.records.set(record.id, record);
    this.schedulePersist();
    return record;
  }

  get(id: string): AttentionRecord | undefined {
    return this.records.get(id);
  }

  getByConfirmId(confirmId: string): AttentionRecord | undefined {
    for (const r of this.records.values()) {
      if (r.confirmId === confirmId) return r;
    }
    return undefined;
  }

  /** 追加一次投递并推进阶梯；返回最新快照 */
  recordDelivery(id: string, channel: AttentionChannel, level: number, detail?: string): AttentionRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.deliveries.push({ channel, at: Date.now(), detail });
    r.level = Math.max(r.level, level);
    this.schedulePersist();
    return r;
  }

  /** ack 归一：任何通道的用户回应都走这里；已闭合的记录幂等返回 */
  ack(id: string, via: string): AttentionRecord | undefined {
    const r = this.records.get(id);
    if (!r || r.state !== "open") return r;
    r.state = "acked";
    r.ackAt = Date.now();
    r.ackVia = via;
    this.schedulePersist();
    return r;
  }

  /** 事务闭合（确认已执行/已拒绝等），可携带说明 */
  resolve(id: string, note?: string): AttentionRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    if (r.state === "open") {
      r.state = "resolved";
      r.resolvedAt = Date.now();
    }
    if (note) r.resolveNote = note;
    this.schedulePersist();
    return r;
  }

  expire(id: string, note?: string): AttentionRecord | undefined {
    const r = this.records.get(id);
    if (!r || r.state !== "open") return r;
    r.state = "expired";
    r.resolvedAt = Date.now();
    if (note) r.resolveNote = note;
    this.schedulePersist();
    return r;
  }

  /** 某 actor 的 open 记录（新在前） */
  listOpen(actorId: string): AttentionRecord[] {
    this.prune();
    return [...this.records.values()]
      .filter((r) => r.actorId === actorId && r.state === "open")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 某 actor 的全部记录（决策中心「今天」视图；新在前） */
  listAll(actorId: string, limit = 50): AttentionRecord[] {
    this.prune();
    return [...this.records.values()]
      .filter((r) => r.actorId === actorId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** 全量 open（router 升级 tick 用） */
  listAllOpen(): AttentionRecord[] {
    this.prune();
    return [...this.records.values()].filter((r) => r.state === "open");
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, r] of this.records) {
      if (r.state === "open") {
        // 无期限的 open 记录最多留 24h（升级 tick 也会把它关掉，这里兜底）
        if (now - r.createdAt > 24 * 60 * 60_000) {
          r.state = "expired";
          r.resolvedAt = now;
          changed = true;
        }
        continue;
      }
      const closedAt = r.resolvedAt ?? r.ackAt ?? 0;
      if (now - closedAt > CLOSED_RETENTION_MS) {
        this.records.delete(id);
        changed = true;
      }
    }
    // 硬上限：超出时丢最旧的 closed
    if (this.records.size > MAX_RECORDS) {
      const sorted = [...this.records.values()].sort((a, b) => {
        const ca = a.resolvedAt ?? a.ackAt ?? a.createdAt;
        const cb = b.resolvedAt ?? b.ackAt ?? b.createdAt;
        return ca - cb;
      });
      for (const r of sorted) {
        if (this.records.size <= MAX_RECORDS) break;
        if (r.state !== "open") {
          this.records.delete(r.id);
          changed = true;
        }
      }
    }
    if (changed) this.schedulePersist();
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      if (this.path) {
        try {
          writeJson(this.path, { version: 1, records: [...this.records.values()] });
        } catch (err) {
          console.log(`[AttentionStore] 落盘失败（忽略）: ${err}`);
        }
      }
    }, 1500);
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }
}
