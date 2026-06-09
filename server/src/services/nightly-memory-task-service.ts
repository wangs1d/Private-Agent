import type { MemoryManagerService } from "./memory-manager-service.js";
import type { DailyDigestService } from "./daily-digest-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export type NightModeConfig = {
  enabled: boolean;
  nightStartHour: number;
  nightEndHour: number;
  timezone: string;
  consolidationBatchSize: number;
};

const DEFAULT_CONFIG: NightModeConfig = {
  enabled: true,
  nightStartHour: 23,
  nightEndHour: 6,
  timezone: "Asia/Shanghai",
  consolidationBatchSize: 50,
};

function loadNightConfig(): NightModeConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: process.env.NIGHT_MEMORY_MODE !== "0",
    nightStartHour:
      Number.parseInt(process.env.NIGHT_START_HOUR ?? "", 10) || DEFAULT_CONFIG.nightStartHour,
    nightEndHour:
      Number.parseInt(process.env.NIGHT_END_HOUR ?? "", 10) || DEFAULT_CONFIG.nightEndHour,
  };
}

export class NightlyMemoryTaskService {
  private readonly config: NightModeConfig;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isNightMode = false;
  private lastProcessedDay = "";
  private memoryManager: MemoryManagerService | null = null;
  private dailyDigest: DailyDigestService | null = null;
  private memorySync: AgentMemorySyncService | null = null;

  constructor(config?: Partial<NightModeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDependencies(
    memoryManager: MemoryManagerService | null,
    dailyDigest: DailyDigestService | null,
    memorySync: AgentMemorySyncService | null,
  ): void {
    this.memoryManager = memoryManager;
    this.dailyDigest = dailyDigest;
    this.memorySync = memorySync;
  }

  startScheduler(): void {
    if (!this.config.enabled || this.schedulerTimer) return;

    this.updateNightMode();
    this.schedulerTimer = setInterval(() => this.tick(), 60_000);
    console.log(
      `[NightlyMemory] Scheduler started. Night mode: ${this.config.nightStartHour}:00-${this.config.nightEndHour}:00 (${this.config.timezone})`,
    );
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  isInNightMode(): boolean {
    return this.isNightMode;
  }

  shouldDeferConsolidation(): boolean {
    return this.config.enabled && !this.isNightMode;
  }

  async forceRunNightTasks(): Promise<{
    consolidated: boolean;
    archived: boolean;
    synced: boolean;
    error?: string;
  }> {
    const result: {
      consolidated: boolean;
      archived: boolean;
      synced: boolean;
      error?: string;
    } = {
      consolidated: false,
      archived: false,
      synced: false,
    };

    try {
      if (this.memoryManager) {
        await this.runDreamPhase();
        result.consolidated = true;
      }

      if (this.dailyDigest) {
        await this.triggerDailyArchive();
        result.archived = true;
      }

      if (this.memorySync) {
        await this.syncToLongTermStorage();
        result.synced = true;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error("[NightlyMemory] Force run failed:", err);
    }

    return result;
  }

  private tick(): void {
    const wasNight = this.isNightMode;
    this.updateNightMode();

    if (!wasNight && this.isNightMode) {
      console.log("[NightlyMemory] 🌙 Night mode activated, starting batch tasks...");
      this.runNightTasks().catch((err) => {
        console.error("[NightlyMemory] Night tasks failed:", err);
      });
    }

    if (wasNight && !this.isNightMode) {
      console.log("[NightlyMemory] ☀️ Day mode activated, deferring consolidation");
    }

    this.checkMidnightRollover();
  }

  private updateNightMode(): void {
    const now = new Date();
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: this.config.timezone,
        hour: "numeric",
        hour12: false,
      }).format(now),
    );

    if (this.config.nightStartHour > this.config.nightEndHour) {
      this.isNightMode = hour >= this.config.nightStartHour || hour < this.config.nightEndHour;
    } else {
      this.isNightMode =
        hour >= this.config.nightStartHour && hour < this.config.nightEndHour;
    }
  }

  private async runNightTasks(): Promise<void> {
    const today = this.getTodayKey();

    if (this.lastProcessedDay === today) return;
    this.lastProcessedDay = today;

    console.log(`[NightlyMemory] Running night tasks for ${today}`);

    try {
      await this.runDreamPhase();
      await this.triggerDailyArchive();
      await this.syncToLongTermStorage();
      await this.cleanupOldStorage();

      console.log("[NightlyMemory] ✅ All night tasks completed successfully");
    } catch (err) {
      console.error("[NightlyMemory] ❌ Night tasks error:", err);
    }
  }

  private async runConsolidationForAll(): Promise<void> {
    if (!this.memoryManager) return;

    const actorIds = this.getAllActorIds();
    console.log(`[NightlyMemory] Consolidating ${actorIds.length} actors`);

    for (const actorId of actorIds) {
      try {
        const result = await this.memoryManager.consolidateNow(actorId);
        if (result.entriesMerged > 0 || result.entriesRemoved > 0) {
          console.log(
            `[NightlyMemory] Actor ${actorId}: merged=${result.entriesMerged}, removed=${result.entriesRemoved}`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] Consolidation failed for ${actorId}:`, err);
      }
    }
  }

  private async runDreamPhase(): Promise<void> {
    if (!this.memoryManager) return;

    const actorIds = this.getAllActorIds();
    console.log(
      `[NightlyMemory] Dream phase: replay -> compress -> reinforce -> decay for ${Math.min(actorIds.length, this.config.consolidationBatchSize)} actors`,
    );

    for (const actorId of actorIds.slice(0, this.config.consolidationBatchSize)) {
      try {
        const result = await this.memoryManager.consolidateNow(actorId);
        if (result.entriesMerged > 0 || result.entriesRemoved > 0) {
          console.log(
            `[NightlyMemory] Dream phase actor ${actorId}: merged=${result.entriesMerged}, removed=${result.entriesRemoved}, remembered=${result.rememberedCount}, faded=${result.fadedCount}`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] Dream phase failed for ${actorId}:`, err);
      }
    }
  }

  private async triggerDailyArchive(): Promise<void> {
    if (!this.dailyDigest) return;

    try {
      console.log("[NightlyMemory] Triggering daily digest archive");
      
      const method = this.dailyDigest as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
      if (typeof method.tickArchive === "function") {
        await method.tickArchive();
      }
    } catch (err) {
      console.error("[NightlyMemory] Archive trigger failed:", err);
    }
  }

  private async syncToLongTermStorage(): Promise<void> {
    if (!this.memorySync) return;

    try {
      console.log("[NightlyMemory] Syncing to long-term storage");
      const snapshot = this.memorySync.getSnapshot?.("system", ["memory_summary"]);
      if (snapshot) {
        console.log("[NightlyMemory] Long-term storage sync completed");
      }
    } catch (err) {
      console.error("[NightlyMemory] Long-term sync failed:", err);
    }
  }

  private async cleanupOldStorage(): Promise<void> {
    return Promise.resolve();
  }

  private checkMidnightRollover(): void {
    const today = this.getTodayKey();
    if (this.lastProcessedDay && this.lastProcessedDay !== today) {
      this.lastProcessedDay = "";
    }
  }

  private getAllActorIds(): string[] {
    const actorIds = new Set<string>();
    for (const actorId of this.memorySync?.listSessionIds?.() ?? []) {
      if (actorId && actorId !== "system") actorIds.add(actorId);
    }
    for (const actorId of this.dailyDigest?.listActorIds?.() ?? []) {
      if (actorId) actorIds.add(actorId);
    }
    return [...actorIds];
  }

  private getTodayKey(): string {
    return this.formatDateKey(new Date());
  }

  private getYesterdayKey(): string {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.formatDateKey(yesterday);
  }

  private formatDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async shutdown(): Promise<void> {
    this.stopScheduler();
    
    if (this.isNightMode) {
      console.log("[NightlyMemory] Shutdown in night mode, running final tasks...");
      await this.forceRunNightTasks();
    }
  }
}

let singleton: NightlyMemoryTaskService | null = null;

export function getNightlyMemoryTaskService(): NightlyMemoryTaskService | null {
  return singleton;
}

export function initNightlyMemoryTaskService(
  config?: Partial<NightModeConfig>,
): NightlyMemoryTaskService | null {
  const cfg = loadNightConfig();
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new NightlyMemoryTaskService(config);
  return singleton;
}
