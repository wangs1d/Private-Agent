import type { MemoryTreeStore } from "./store.js";

/**
 * UTC 每日 global digest + stale buffer flush（仅入队，由 worker 执行）。
 */
export class MemoryTreeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastDigestDay = "";

  constructor(private readonly store: MemoryTreeStore) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();

    if (utcHour === 0 && utcMin < 2 && this.lastDigestDay !== day) {
      this.lastDigestDay = day;
      const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      this.store.enqueueJob("digest_daily", `digest:global:${yesterday}`, {
        actorId: "_global",
        day: yesterday,
      });
      this.store.enqueueJob("digest_daily", `digest:global:${day}`, {
        actorId: "_global",
        day,
      });
    }

    if (utcMin % 15 === 0) {
      this.store.enqueueJob("flush_stale", `flush:${day}:${utcHour}:${utcMin}`, {
        actorId: "_broadcast",
      });
    }
  }
}
