/**
 * 晚间 digest 调度器（Task 15 场景A 生活节律）。
 *
 * 调度模式参考 MorningBriefingScheduler：每分钟 tick，对已订阅 session
 * 到点触发一次晚间 digest（今日回顾+明日预告）。
 * 差异：晨报按每用户偏好时间（prefs.morningBriefing.time）推送；
 * 晚间 digest 用全局 env EVENING_DIGEST_HOUR（默认 21 点），送达去重
 * 用调度器内部 lastSentDay 表（不侵入 user-preferences 的晨报送达状态）。
 */

import type { EveningDigest, EveningDigestService } from "./evening-digest-service.js";

type SchedulerDeps = {
  digestService: EveningDigestService;
  onDigestTriggered: (sessionId: string, digest: EveningDigest) => void | Promise<void>;
};

export class EveningDigestScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly subscribedSessions = new Set<string>();
  /** 当日已送达表：sessionId → 送达日期（YYYY-MM-DD），防同日重复推送 */
  private readonly lastSentDay = new Map<string, string>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** 晚间推送时刻（小时；env EVENING_DIGEST_HOUR 可调，默认 21） */
  private triggerHour(): number {
    const h = Number(process.env.EVENING_DIGEST_HOUR);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 21;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.tick().catch(() => {}),
      60_000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(sessionId: string): void {
    this.subscribedSessions.add(sessionId);
  }

  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    if (now.getHours() !== this.triggerHour()) return;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    for (const sessionId of this.subscribedSessions) {
      if (this.lastSentDay.get(sessionId) === today) continue;
      try {
        const digest = await this.deps.digestService.generateDigest(sessionId);
        await this.deps.onDigestTriggered(sessionId, digest);
        this.lastSentDay.set(sessionId, today);
      } catch {
        // 单个 session 失败忽略，不阻断其他 session
      }
    }
  }
}
