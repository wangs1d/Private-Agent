/**
 * Jarvis Memory Bank — 统一记忆层
 *
 * 借鉴 mem0 + Letta 设计：
 *  - episodic：每次主动消息 / 决策 / 反馈的事件流
 *  - reflection：异步凝练的「学到的规律」
 *  - rule：高置信度的行为规则（由 reflection 提升而来）
 *
 * 三类记忆都按 actorId 分桶，支持：
 *  - 写入即持久化（JSONL 追加 + 异步落盘）
 *  - 按 tag / 时间窗 recall
 *  - 与 trigger 关联（refs）
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  JarvisDecisionResult,
  JarvisDeliveryResult,
  JarvisFeedback,
  JarvisMemoryEntry,
  JarvisMemoryKind,
  JarvisTrigger,
} from "./types.js";

type PersistedShape = {
  episodic: JarvisMemoryEntry[];
  reflection: JarvisMemoryEntry[];
  rule: JarvisMemoryEntry[];
};

const EMPTY_PERSISTED: PersistedShape = {
  episodic: [],
  reflection: [],
  rule: [],
};

export type MemoryBankDeps = {
  persistFilePath?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

function makeEntryId(kind: JarvisMemoryKind, actorId: string): string {
  return `${kind}:${actorId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class JarvisMemoryBank {
  private readonly episodic = new Map<string, JarvisMemoryEntry[]>();
  private readonly reflection = new Map<string, JarvisMemoryEntry[]>();
  private readonly rule = new Map<string, JarvisMemoryEntry[]>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MemoryBankDeps = {}) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.deps.persistFilePath) return;
    try {
      const raw = await readFile(this.deps.persistFilePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      for (const entry of parsed.episodic ?? []) this.pushInMemory(entry);
      for (const entry of parsed.reflection ?? []) this.pushInMemory(entry);
      for (const entry of parsed.rule ?? []) this.pushInMemory(entry);
      this.deps.logger?.info(
        `[JarvisMemory] loaded episodic=${parsed.episodic?.length ?? 0} ` +
          `reflection=${parsed.reflection?.length ?? 0} rule=${parsed.rule?.length ?? 0}`,
      );
    } catch (err) {
      // 文件不存在是正常情况
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ENOENT/.test(msg)) {
        this.deps.logger?.warn(`[JarvisMemory] load failed: ${msg}`);
      }
    }
  }

  // ────────────────────── 写入 ──────────────────────

  async recordTrigger(trigger: JarvisTrigger): Promise<JarvisMemoryEntry> {
    const entry: JarvisMemoryEntry = {
      id: makeEntryId("episodic", trigger.actorId),
      kind: "episodic",
      actorId: trigger.actorId,
      body: `TRIGGER[${trigger.source}] ${trigger.title} — ${trigger.summary}`,
      tags: [...trigger.tags, trigger.category, `source:${trigger.source}`],
      confidence: clamp(trigger.confidence, 0, 1),
      createdAt: nowIso(),
      source: trigger.source,
      refs: [trigger.id],
    };
    await this.persist(entry);
    return entry;
  }

  async recordDecision(
    trigger: JarvisTrigger,
    decision: JarvisDecisionResult,
  ): Promise<JarvisMemoryEntry> {
    const entry: JarvisMemoryEntry = {
      id: makeEntryId("episodic", trigger.actorId),
      kind: "episodic",
      actorId: trigger.actorId,
      body:
        `DECISION[${decision.decision}] ${trigger.title} → ` +
        `${decision.content ?? "(silent)"} | ` +
        `value=${decision.value.composite.toFixed(2)} disturb=${decision.disturb.composite.toFixed(2)}`,
      tags: [
        ...trigger.tags,
        trigger.category,
        `decision:${decision.decision}`,
        `channel:${decision.channel ?? "n/a"}`,
      ],
      confidence: clamp(trigger.confidence, 0, 1),
      createdAt: nowIso(),
      source: trigger.source,
      refs: [trigger.id, decision.triggerId],
    };
    await this.persist(entry);
    return entry;
  }

  async recordDelivery(
    delivery: JarvisDeliveryResult,
  ): Promise<JarvisMemoryEntry> {
    const entry: JarvisMemoryEntry = {
      id: makeEntryId("episodic", delivery.actorId),
      kind: "episodic",
      actorId: delivery.actorId,
      body: `DELIVERY[${delivery.channel}] sent=${delivery.sent} reason=${delivery.reason}`,
      tags: ["delivery", `channel:${delivery.channel}`, delivery.sent ? "sent" : "dropped"],
      confidence: 1,
      createdAt: nowIso(),
      source: "event",
      refs: [delivery.triggerId, delivery.decisionId, delivery.outboundId ?? ""].filter(Boolean),
    };
    await this.persist(entry);
    return entry;
  }

  async recordFeedback(feedback: JarvisFeedback): Promise<JarvisMemoryEntry> {
    const entry: JarvisMemoryEntry = {
      id: makeEntryId("episodic", feedback.actorId),
      kind: "episodic",
      actorId: feedback.actorId,
      body:
        `FEEDBACK[${feedback.kind}] trigger=${feedback.triggerId} ` +
        `rt=${feedback.responseTimeMs ?? "-"}ms sentiment_after=${feedback.sentimentAfter ?? "-"}`,
      tags: ["feedback", `kind:${feedback.kind}`],
      confidence: 1,
      createdAt: nowIso(),
      source: "event",
      refs: [feedback.triggerId, feedback.decisionId],
    };
    await this.persist(entry);
    return entry;
  }

  async recordReflection(
    actorId: string,
    body: string,
    tags: string[],
    confidence: number,
    source: JarvisMemoryEntry["source"],
    refs: string[] = [],
  ): Promise<JarvisMemoryEntry> {
    const entry: JarvisMemoryEntry = {
      id: makeEntryId("reflection", actorId),
      kind: "reflection",
      actorId,
      body,
      tags,
      confidence: clamp(confidence, 0, 1),
      createdAt: nowIso(),
      source,
      refs,
    };
    await this.persist(entry);
    return entry;
  }

  async recordRule(
    actorId: string,
    body: string,
    tags: string[],
    confidence: number,
    refs: string[] = [],
  ): Promise<JarvisMemoryEntry> {
    const entry: JarvisMemoryEntry = {
      id: makeEntryId("rule", actorId),
      kind: "rule",
      actorId,
      body,
      tags,
      confidence: clamp(confidence, 0, 1),
      createdAt: nowIso(),
      source: "reflection",
      refs,
    };
    await this.persist(entry);
    return entry;
  }

  // ────────────────────── 读取 ──────────────────────

  episodicFor(actorId: string, limit = 50): JarvisMemoryEntry[] {
    return [...(this.episodic.get(actorId) ?? [])].slice(-limit);
  }

  reflectionFor(actorId: string, limit = 30): JarvisMemoryEntry[] {
    return [...(this.reflection.get(actorId) ?? [])].slice(-limit);
  }

  rulesFor(actorId: string, limit = 30): JarvisMemoryEntry[] {
    return [...(this.rule.get(actorId) ?? [])].slice(-limit);
  }

  /**
   * 召回与当前 trigger 相关的所有记忆（用于决策时 recall）。
   * 匹配规则：tag 重叠 或 source 相同 或 body 关键词命中。
   */
  recall(actorId: string, trigger: JarvisTrigger, limit = 12): JarvisMemoryEntry[] {
    const all: JarvisMemoryEntry[] = [
      ...this.rulesFor(actorId, 100),
      ...this.reflectionFor(actorId, 100),
      ...this.episodicFor(actorId, 100),
    ];
    const tagSet = new Set(trigger.tags.concat([trigger.category]));
    const scored = all
      .map((entry) => {
        let score = 0;
        for (const tag of entry.tags) if (tagSet.has(tag)) score += 2;
        if (entry.source === trigger.source) score += 1;
        if (entry.refs.includes(trigger.id)) score += 5;
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((item) => item.entry);
  }

  /** 当 actor 的某个 category 在最近 N 条 episodic 里的负面/沉默占比 */
  recentNegativeRatio(actorId: string, category: string, lookback = 20): number {
    const recent = this.episodicFor(actorId, lookback).filter((entry) =>
      entry.tags.includes(category),
    );
    if (recent.length === 0) return 0;
    const negative = recent.filter(
      (entry) =>
        entry.tags.includes("kind:ignored") ||
        entry.tags.includes("kind:negative") ||
        entry.tags.includes("decision:silent"),
    ).length;
    return clamp(negative / recent.length, 0, 1);
  }

  // ────────────────────── 内部 ──────────────────────

  private pushInMemory(entry: JarvisMemoryEntry): void {
    const bucket = this.bucketFor(entry.kind);
    const list = this[bucket].get(entry.actorId) ?? [];
    list.push(entry);
    if (list.length > 1000) list.splice(0, list.length - 1000);
    this[bucket].set(entry.actorId, list);
  }

  private bucketFor(kind: JarvisMemoryKind): "episodic" | "reflection" | "rule" {
    if (kind === "reflection") return "reflection";
    if (kind === "rule") return "rule";
    return "episodic";
  }

  private async persist(entry: JarvisMemoryEntry): Promise<void> {
    this.pushInMemory(entry);
    if (!this.deps.persistFilePath) return;
    this.writeQueue = this.writeQueue
      .then(async () => {
        try {
          const dir = dirname(this.deps.persistFilePath!);
          await mkdir(dir, { recursive: true });
          await appendFile(this.deps.persistFilePath!, JSON.stringify(entry) + "\n", "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.logger?.warn(`[JarvisMemory] persist failed: ${msg}`);
        }
      })
      .catch(() => {
        /* swallow */
      });
  }

  /**
   * 全量快照（用于调试接口 / 测试）
   */
  snapshot(actorId: string): PersistedShape {
    return {
      episodic: this.episodicFor(actorId),
      reflection: this.reflectionFor(actorId),
      rule: this.rulesFor(actorId),
    };
  }

  async flushForShutdown(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  /** 测试辅助：清空 */
  reset(): void {
    this.episodic.clear();
    this.reflection.clear();
    this.rule.clear();
    this.loaded = false;
  }
}
