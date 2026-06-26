/**
 * Jarvis Self-Scan Trigger — 自发性扫描器
 *
 * 这是「贾维斯感」的核心：Agent 不再只是响应外部事件，
 * 而是周期性跨数据源扫描，主动发现「值得说」的事。
 *
 * 借鉴思路：ProactiveAgent research project + Mem0 cross-source recall
 *
 * 扫描项：
 *  1. stale_topic       — 旧话题未完结（memory 中的 episodic）
 *  2. habit_gap         — 习惯缺口（最近 N 天未做某事）
 *  3. knowledge_gap     — 笔记里有未解的问题
 *  4. relationship_gap  — 太久没主动聊
 *  5. upcoming_deadline — 日程反推
 *  6. weekend_ritual    — 周末/节假日的轻问候
 *  7. follow_up_resume  — 续上次未完话题
 *
 * 输出 JarvisSelfScanCandidate，由 JarvisHarness 决定是否升级为 trigger。
 */

import type { NotesService } from "../notes-service.js";
import type { ScheduleTaskService } from "../schedule-task-service.js";
import type { LifeSignalHubService } from "../life-signal-hub-service.js";
import type { JarvisMemoryBank } from "./memory-bank.js";
import type {
  JarvisSelfScanCandidate,
  JarvisSelfScanKind,
  JarvisTrigger,
} from "./types.js";
import {
  inferTriggerCategoryFromLifeSignal,
  toUrgencyBand,
} from "./types.js";

export type SelfScanTriggerDeps = {
  notes: NotesService | null;
  schedule: ScheduleTaskService | null;
  lifeSignalHub: LifeSignalHubService | null;
  memory: JarvisMemoryBank;
  /** 获取已知 actor id 列表（如 lifeSignalHub 历史 + 主动消息历史） */
  resolveActorIds: () => string[];
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function isWeekendEvening(date: Date): boolean {
  return isWeekend(date) && date.getHours() >= 19 && date.getHours() <= 22;
}

export class JarvisSelfScanTrigger {
  private readonly lastScanAt = new Map<string, number>();
  private readonly recentlyEmitted = new Map<string, number>();
  /** 同 kind 在 N 小时内只发一次（防刷屏） */
  private readonly dedupWindowMs = 6 * HOUR_MS;

  constructor(private readonly deps: SelfScanTriggerDeps) {}

  /**
   * 一次完整扫描：返回所有候选
   */
  async scan(now: Date = new Date()): Promise<JarvisSelfScanCandidate[]> {
    const out: JarvisSelfScanCandidate[] = [];
    const actorIds = this.deps.resolveActorIds();
    for (const actorId of actorIds) {
      const lastScan = this.lastScanAt.get(actorId) ?? 0;
      if (Date.now() - lastScan < 30 * 60_000) continue; // 30 分钟内同 actor 不重复
      this.lastScanAt.set(actorId, Date.now());
      try {
        const candidates = await this.scanForActor(actorId, now);
        out.push(...candidates);
      } catch (err) {
        this.deps.logger?.warn(
          `[JarvisSelfScan] actor=${actorId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  private async scanForActor(actorId: string, now: Date): Promise<JarvisSelfScanCandidate[]> {
    const candidates: JarvisSelfScanCandidate[] = [];
    candidates.push(...this.detectRelationshipGap(actorId, now));
    candidates.push(...this.detectStaleTopic(actorId, now));
    candidates.push(...(await this.detectKnowledgeGap(actorId, now)));
    candidates.push(...(await this.detectUpcomingDeadlines(actorId, now)));
    candidates.push(...this.detectWeekendRitual(actorId, now));
    candidates.push(...this.detectFollowUpResume(actorId, now));
    candidates.push(...this.detectHabitGap(actorId, now));
    return candidates;
  }

  // ────────────────────── 关系缺口 ──────────────────────

  /**
   * 太久没主动发消息（>= 6 小时）→ 主动冒个泡
   */
  private detectRelationshipGap(actorId: string, now: Date): JarvisSelfScanCandidate[] {
    const lastOutbound = this.lastOutboundAt(actorId);
    const sinceMs = Date.now() - lastOutbound;
    if (sinceMs < 6 * HOUR_MS) return [];
    const days = sinceMs / DAY_MS;
    return [
      {
        kind: "relationship_gap",
        actorId,
        title: "想到你",
        rationale: `距离上次主动联系已 ${Math.floor(days)} 天，主动问候可维持关系温度。`,
        suggestedAction: "发起一个轻问候或跟进上次话题",
        confidence: 0.55,
        urgency: days > 3 ? 5.5 : 4.5,
        tags: ["presence", "relationship"],
        evidence: [`last_outbound_at=${new Date(lastOutbound).toISOString()}`],
        detectedAt: now.toISOString(),
        meta: { sinceMs },
      },
    ];
  }

  // ────────────────────── 旧话题未完结 ──────────────────────

  /**
   * 查 episodic memory 中最近有 follow_up tag 的未完话题
   */
  private detectStaleTopic(actorId: string, now: Date): JarvisSelfScanCandidate[] {
    const episodic = this.deps.memory.episodicFor(actorId, 50);
    const followUps = episodic.filter(
      (e) => e.tags.includes("category:follow_up") || e.tags.includes("follow_up"),
    );
    if (followUps.length === 0) return [];
    const latest = followUps[followUps.length - 1];
    const ageMs = Date.now() - Date.parse(latest.createdAt);
    if (ageMs < 12 * HOUR_MS || ageMs > 14 * DAY_MS) return [];
    return [
      {
        kind: "stale_topic",
        actorId,
        title: "上次聊的还没结论",
        rationale: `${Math.floor(ageMs / HOUR_MS)}h 前发起了一个 follow_up 类话题，至今没续上。`,
        suggestedAction: "主动问一句后续",
        confidence: 0.6,
        urgency: 4.5,
        tags: ["follow_up", "continuity"],
        evidence: [latest.body],
        detectedAt: now.toISOString(),
        meta: { episodicId: latest.id },
      },
    ];
  }

  // ────────────────────── 知识缺口（笔记） ──────────────────────

  private async detectKnowledgeGap(actorId: string, now: Date): Promise<JarvisSelfScanCandidate[]> {
    if (!this.deps.notes) return [];
    try {
      // 找最近 7 天的笔记，看是否有未复习的
      const recent = this.deps.notes.listNotes({
        sessionId: actorId,
        from: new Date(Date.now() - 7 * DAY_MS).toISOString(),
        limit: 30,
      });
      const notReviewed = recent.filter(
        (n) => !n.lastReviewedAt || Date.now() - Date.parse(n.lastReviewedAt) > 3 * DAY_MS,
      );
      if (notReviewed.length < 3) return [];
      return [
        {
          kind: "knowledge_gap",
          actorId,
          title: "笔记复习提醒",
          rationale: `你最近记了 ${recent.length} 条笔记，其中 ${notReviewed.length} 条 3 天没复习。`,
          suggestedAction: "挑一两条复习或更新",
          confidence: 0.7,
          urgency: 3.8,
          tags: ["study", "knowledge", "notes"],
          evidence: notReviewed.slice(0, 3).map((n) => `note:${n.title}`),
          detectedAt: now.toISOString(),
          meta: { noteCount: notReviewed.length },
        },
      ];
    } catch {
      return [];
    }
  }

  // ────────────────────── 即将到期日程 ──────────────────────

  private async detectUpcomingDeadlines(actorId: string, now: Date): Promise<JarvisSelfScanCandidate[]> {
    if (!this.deps.schedule) return [];
    try {
      const from = new Date(now.getTime() + 30 * 60_000).toISOString(); // 30 分钟后开始
      const to = new Date(now.getTime() + 4 * HOUR_MS).toISOString(); // 4 小时内
      const tasks = this.deps.schedule.listTasksBySession(actorId, { from, to });
      if (tasks.length === 0) return [];
      return [
        {
          kind: "upcoming_deadline",
          actorId,
          title: "日程快到了",
          rationale: `${tasks.length} 个任务在 4h 内到期。`,
          suggestedAction: "提醒用户准备",
          confidence: 0.8,
          urgency: 5.5,
          tags: ["planning", "schedule"],
          evidence: tasks.slice(0, 3).map((t) => `task:${t.title}`),
          detectedAt: now.toISOString(),
          meta: { taskCount: tasks.length },
        },
      ];
    } catch {
      return [];
    }
  }

  // ────────────────────── 周末仪式 ──────────────────────

  private detectWeekendRitual(actorId: string, now: Date): JarvisSelfScanCandidate[] {
    if (!isWeekendEvening(now)) return [];
    return [
      {
        kind: "weekend_ritual",
        actorId,
        title: "周末快乐",
        rationale: "周末晚上是放松的时间，可以发起一个轻问候。",
        suggestedAction: "问候周末状态、聊聊这周",
        confidence: 0.5,
        urgency: 3.2,
        tags: ["presence", "weekend"],
        evidence: [`now=${now.toISOString()} day=${now.getDay()}`],
        detectedAt: now.toISOString(),
      },
    ];
  }

  // ────────────────────── 续上次未完话题 ──────────────────────

  private detectFollowUpResume(actorId: string, now: Date): JarvisSelfScanCandidate[] {
    // 复用 stale_topic
    return [];
  }

  // ────────────────────── 习惯缺口 ──────────────────────

  /**
   * 基于 episodic memory 推测习惯：例如「完成类」信号最近 5 天都没出现
   */
  private detectHabitGap(actorId: string, now: Date): JarvisSelfScanCandidate[] {
    const episodic = this.deps.memory.episodicFor(actorId, 100);
    const completions = episodic.filter((e) => e.tags.includes("category:completion"));
    if (completions.length < 5) return []; // 数据不够
    const recent = completions.filter(
      (e) => Date.now() - Date.parse(e.createdAt) <= 5 * DAY_MS,
    );
    if (recent.length > 0) return [];
    return [
      {
        kind: "habit_gap",
        actorId,
        title: "好久没完成任务了",
        rationale: "近 5 天没有观察到任何完成类信号。",
        suggestedAction: "关心一下用户是不是状态不好",
        confidence: 0.4,
        urgency: 4.2,
        tags: ["completion", "habit_gap", "care"],
        evidence: [`completions_last_5d=${recent.length}`],
        detectedAt: now.toISOString(),
      },
    ];
  }

  // ────────────────────── 辅助：上次主动消息时间 ──────────────────────

  private lastOutboundAt(actorId: string): number {
    const episodic = this.deps.memory.episodicFor(actorId, 100);
    const outboundTags = episodic.filter(
      (e) => e.tags.includes("decision:speak") && e.tags.includes("delivery"),
    );
    if (outboundTags.length === 0) return 0;
    return Date.parse(outboundTags[outboundTags.length - 1].createdAt);
  }

  // ────────────────────── 升级为 Trigger ──────────────────────

  /**
   * 把自发性扫描候选升级为标准 JarvisTrigger
   */
  toTrigger(candidate: JarvisSelfScanCandidate): JarvisTrigger | null {
    if (this.isDeduped(candidate)) return null;
    this.recentlyEmitted.set(
      `${candidate.actorId}:${candidate.kind}`,
      Date.now(),
    );
    const category = this.inferCategory(candidate);
    return {
      id: `self:${candidate.kind}:${candidate.actorId}:${Date.now()}`,
      source: "self_scan",
      actorId: candidate.actorId,
      category,
      title: candidate.title,
      summary: candidate.suggestedAction,
      description: candidate.rationale,
      tags: [...candidate.tags, `self_scan:${candidate.kind}`],
      urgency: candidate.urgency,
      confidence: candidate.confidence,
      importance: toUrgencyBand(candidate.urgency),
      evidence: candidate.evidence,
      occurredAt: candidate.detectedAt,
      ttlMs: 30 * 60_000,
      metadata: { selfScanKind: candidate.kind, ...(candidate.meta ?? {}) },
    };
  }

  private inferCategory(candidate: JarvisSelfScanCandidate): JarvisTrigger["category"] {
    if (candidate.kind === "habit_gap" || candidate.tags.includes("care")) return "care";
    if (candidate.kind === "knowledge_gap") return "planning";
    if (candidate.kind === "upcoming_deadline") return "planning";
    if (candidate.kind === "weekend_ritual" || candidate.kind === "relationship_gap")
      return "presence";
    if (candidate.kind === "stale_topic" || candidate.kind === "follow_up_resume")
      return "follow_up";
    return "general";
  }

  private isDeduped(candidate: JarvisSelfScanCandidate): boolean {
    const key = `${candidate.actorId}:${candidate.kind}`;
    const last = this.recentlyEmitted.get(key) ?? 0;
    return Date.now() - last < this.dedupWindowMs;
  }
}

// 占位 export 让 import 不报 unused
export { inferTriggerCategoryFromLifeSignal, clamp };
