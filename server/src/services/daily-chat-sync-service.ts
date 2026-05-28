import type { DailyDigestService } from "./daily-digest-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export type ChatSyncRecord = {
  actorId: string;
  day: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    messageId: string;
    timestamp: string;
  }>;
  clientTimestamp: string;
  serverReceivedAt: string;
};

export type ChatSyncConfig = {
  enabled: boolean;
  maxMessagesPerSync: number;
  retentionDays: number;
  autoSyncIntervalMs: number;
};

const DEFAULT_CONFIG: ChatSyncConfig = {
  enabled: true,
  maxMessagesPerSync: 500,
  retentionDays: 30,
  autoSyncIntervalMs: 5 * 60_000,
};

class DailyChatSyncService {
  private readonly config: ChatSyncConfig;
  private readonly pendingSyncs = new Map<string, ChatSyncRecord>();
  private dailyDigest: DailyDigestService | null = null;
  private memorySync: AgentMemorySyncService | null = null;

  constructor(config?: Partial<ChatSyncConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDependencies(
    dailyDigest: DailyDigestService | null,
    memorySync: AgentMemorySyncService | null,
  ): void {
    this.dailyDigest = dailyDigest;
    this.memorySync = memorySync;
  }

  receiveClientChatSync(record: ChatSyncRecord): {
    success: boolean;
    messageCount: number;
    processed: boolean;
  } {
    if (!this.config.enabled) {
      return { success: false, messageCount: 0, processed: false };
    }

    const key = `${record.actorId}::${record.day}`;
    
    const existing = this.pendingSyncs.get(key);
    if (existing && existing.messages.length >= record.messages.length) {
      return { 
        success: true, 
        messageCount: existing.messages.length, 
        processed: false 
      };
    }

    record.serverReceivedAt = new Date().toISOString();
    this.pendingSyncs.set(key, record);

    console.log(
      `[DailyChatSync] Received sync for ${record.actorId}, day=${record.day}, messages=${record.messages.length}`,
    );

    this.processSyncToMemorySystems(record).catch((err) => {
      console.error(`[DailyChatSync] Process failed for ${key}:`, err);
    });

    return {
      success: true,
      messageCount: record.messages.length,
      processed: true,
    };
  }

  async processSyncToMemorySystems(record: ChatSyncRecord): Promise<void> {
    try {
      await this.updateDailyDigest(record);
      await this.updateMemorySummary(record);
      
      console.log(
        `[DailyChatSync] ✅ Successfully synced ${record.messages.length} messages for ${record.actorId}`,
      );
    } catch (err) {
      console.error(`[DailyChatSync] Sync processing error for ${record.actorId}:`, err);
      throw err;
    }
  }

  private async updateDailyDigest(record: ChatSyncRecord): Promise<void> {
    if (!this.dailyDigest) return;

    const method = this.dailyDigest as unknown as Record<string, (...args: unknown[]) => void>;
    
    for (const msg of record.messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        const userText = msg.role === "user" ? msg.text : "";
        const assistantText = msg.role === "assistant" ? msg.text : "";
        
        if (typeof method.observeTurn === "function") {
          method.observeTurn(record.actorId, userText, assistantText);
        }
      }
    }
  }

  private async updateMemorySummary(record: ChatSyncRecord): Promise<void> {
    if (!this.memorySync) return;

    try {
      const { revision, entries } = this.memorySync.getSnapshot(record.actorId, [
        "memory_summary",
      ]);
      
      let summary = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      
      const newLines: string[] = [];
      for (const msg of record.messages.slice(-50)) {
        const timeLabel = new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeStyle: "short",
        }).format(new Date(msg.timestamp));

        if (msg.role === "user") {
          newLines.push(`[${timeLabel}] [客户端同步] 用户: ${msg.text.slice(0, 150)}`);
        } else if (msg.role === "assistant") {
          newLines.push(`[${timeLabel}] [客户端同步] Agent: ${msg.text.slice(0, 150)}`);
        }
      }

      if (newLines.length > 0) {
        summary = summary ? `${summary}\n${newLines.join("\n")}` : newLines.join("\n");
        summary = summary.slice(-32_000);

        this.memorySync.applyPatch(record.actorId, revision, [
          { key: "memory_summary", op: "put", value: summary },
        ]);
      }
    } catch (err) {
      console.error(`[DailyChatSync] Memory update failed for ${record.actorId}:`, err);
    }
  }

  getSyncStatus(actorId?: string): {
    totalPendingSyncs: number;
    totalMessages: number;
    actorStats?: Array<{
      actorId: string;
      day: string;
      messageCount: number;
      receivedAt: string;
    }>;
  } {
    let totalMessages = 0;
    const actorStats: Array<{
      actorId: string;
      day: string;
      messageCount: number;
      receivedAt: string;
    }> = [];

    for (const [key, record] of this.pendingSyncs.entries()) {
      totalMessages += record.messages.length;
      actorStats.push({
        actorId: record.actorId,
        day: record.day,
        messageCount: record.messages.length,
        receivedAt: record.serverReceivedAt,
      });
    }

    if (actorId) {
      const filtered = actorStats.filter((s) => s.actorId === actorId);
      return {
        totalPendingSyncs: filtered.length,
        totalMessages: filtered.reduce((sum, s) => sum + s.messageCount, 0),
        actorStats: filtered,
      };
    }

    return {
      totalPendingSyncs: this.pendingSyncs.size,
      totalMessages,
      actorStats,
    };
  }

  cleanupOldRecords(): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
    let removed = 0;

    for (const [key, record] of this.pendingSyncs.entries()) {
      const recordDate = new Date(record.serverReceivedAt);
      if (recordDate < cutoffDate) {
        this.pendingSyncs.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[DailyChatSync] Cleaned up ${removed} old sync records`);
    }

    return removed;
  }
}

let singleton: DailyChatSyncService | null = null;

export function getDailyChatSyncService(): DailyChatSyncService {
  if (!singleton) singleton = new DailyChatSyncService();
  return singleton;
}

export function initDailyChatSyncService(
  config?: Partial<ChatSyncConfig>,
): DailyChatSyncService | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new DailyChatSyncService(config);
  return singleton;
}
