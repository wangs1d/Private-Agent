import type {
  MorningBriefingNarration,
  MorningBriefingService,
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
    const today = now.toISOString().slice(0, 10);
    for (const [sessionId, prefs] of this.subscribedSessions) {
      if (!prefs.morningBriefing.enabled) continue;
      if (prefs.morningBriefing.time !== hhmm) continue;
      if (prefs.morningBriefing.lastSentAt?.startsWith(today)) continue;
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
