import {
  isWithinBriefingWindow,
  type MorningBriefingNarration,
  type MorningBriefingService,
} from "./morning-briefing-service.js";
import type { UserPreferences } from "../routes/http/user-preferences.js";

type SchedulerDeps = {
  briefingService: MorningBriefingService;
  onBriefingTriggered: (
    sessionId: string,
    payload: MorningBriefingNarration & { mode: string },
  ) => void | Promise<void>;
  getSessionPrefs: (sessionId: string) => UserPreferences;
};

/** 本地日期键（YYYY-MM-DD）：窗口判断与当日去重都按服务器本地时区，
 *  不能用 toISOString 的 UTC 日期——UTC+8 的早晨 8 点前 UTC 日期仍是"昨天"，
 *  按 UTC 去重会导致同日重复播报。 */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export class MorningBriefingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private subscribedSessions = new Map<string, UserPreferences>();

  constructor(private readonly deps: SchedulerDeps) {}

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

  subscribe(sessionId: string, prefs: UserPreferences): void {
    this.subscribedSessions.set(sessionId, prefs);
  }

  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;
    // 只在早上固定时段播报：窗口（05:00–12:00）外一律不触发，
    // 历史配置的非早晨时间也因此永不播报。
    if (!isWithinBriefingWindow(hhmm)) return;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const today = localDateKey(now);
    const isSameDay = (iso: string | null): boolean =>
      !!iso && Number.isFinite(new Date(iso).getTime()) && localDateKey(new Date(iso)) === today;
    for (const [sessionId, prefs] of this.subscribedSessions) {
      if (!prefs.morningBriefing.enabled) continue;
      const cfg = prefs.morningBriefing.time;
      const m = cfg.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const cfgMin = Number(m[1]) * 60 + Number(m[2]);
      // 配置时间本身不在晨间窗口（历史脏配置）→ 永不播报
      if (!isWithinBriefingWindow(cfg)) continue;
      // 到点即播；服务重启/断线错过精确分钟时，窗口内补播一次
      if (nowMin < cfgMin) continue;
      if (isSameDay(prefs.morningBriefing.lastSentAt)) continue;
      // 当日已从任意渠道投递过（如客户端启动简报已展示）→ 不再重复播报
      if (isSameDay(prefs.morningBriefing.deliveredAt)) continue;
      try {
        const payload = await this.deps.briefingService.narrateBriefing(sessionId);
        await this.deps.onBriefingTriggered(sessionId, {
          ...payload,
          mode: prefs.morningBriefing.mode,
        });
        prefs.morningBriefing.lastSentAt = new Date().toISOString();
      } catch (e) {
        // ignore single failure
      }
    }
  }
}
