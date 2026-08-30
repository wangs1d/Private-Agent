// 临近日程感知（UpcomingScheduleWatcher）：itinerary 类提醒任务在 nextRunAt 前
// leadMs（默认 15min）产出 schedule_upcoming 提案（零 LLM，tier=must 必达）。
// 到点本体仍由 ScheduleTaskService.tick → reminderHandler 负责，这里只做提前量。
import type { ScheduleTaskRecord } from "../services/schedule-task-service.js";
import { isTriviaTask } from "../services/schedule-task-service.js";
import type { ProactiveProposal } from "./pipeline-types.js";

export type WatcherDeps = {
  listTasks: () => ScheduleTaskRecord[];
  submit: (p: ProactiveProposal) => void;
  /** 提前量 ms（默认 15min；任务元数据可在 Phase 3 覆盖） */
  leadMs?: number;
  scanIntervalMs?: number;
};

function formatLead(deltaMs: number): string {
  const m = Math.max(1, Math.round(deltaMs / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

export class UpcomingScheduleWatcher {
  private readonly leadMs: number;
  private readonly scanIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 已提案指纹（taskId:runAt）防周期任务反复提案 */
  private readonly firedKeys = new Set<string>();

  constructor(private readonly deps: WatcherDeps) {
    this.leadMs = deps.leadMs ?? 15 * 60 * 1000;
    this.scanIntervalMs = deps.scanIntervalMs ?? 30 * 1000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.scanIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scan(now = Date.now()): ProactiveProposal[] {
    const out: ProactiveProposal[] = [];
    for (const task of this.deps.listTasks()) {
      if (task.status !== "active" || task.kind !== "reminder" || isTriviaTask(task)) continue;
      const runAtMs = Date.parse(task.nextRunAt ?? task.runAt);
      if (!Number.isFinite(runAtMs)) continue;
      const delta = runAtMs - now;
      if (delta > this.leadMs || delta < -60_000) continue; // 还早 / 已开始超过1min（到点归 reminderHandler）
      const dedupKey = `schedule_upcoming:${task.taskId}:${task.nextRunAt ?? task.runAt}`;
      if (this.firedKeys.has(dedupKey)) continue;
      this.firedKeys.add(dedupKey);
      if (this.firedKeys.size > 500) this.firedKeys.delete(this.firedKeys.values().next().value!);
      const lead = formatLead(Math.max(delta, 0));
      out.push({
        proposalId: `p_${now.toString(36)}_${dedupKey.length.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
        actorId: task.sessionId,
        kind: "schedule_upcoming",
        tier: "must",
        importance: "high",
        dedupKey,
        title: `即将开始：${task.title || task.shortTitle || "日程"}`,
        summary: `还有${lead}就开始了：${task.title}${task.description ? `（${task.description.slice(0, 80)}）` : ""}`,
        evidence: [`taskId=${task.taskId}`, `runAt=${task.nextRunAt ?? task.runAt}`, `leadMs=${this.leadMs}`],
        directText: `还有${lead}就到「${task.title || task.shortTitle || "日程"}」了，可以先准备一下。`,
        createdAt: now,
        expiresAt: runAtMs,
        source: "schedule",
      });
    }
    for (const p of out) this.deps.submit(p);
    return out;
  }
}
