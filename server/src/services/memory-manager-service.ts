import { randomUUID } from "node:crypto";

import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export type MemoryManagerConfig = {
  enabled: boolean;
  consolidationIntervalMs: number;
  maxSummaryChars: number;
  profileUpdateThreshold: number;
};

export type MemoryConsolidationResult = {
  entriesMerged: number;
  entriesRemoved: number;
  summaryUpdated: boolean;
  timestamp: string;
};

export type UserProfileSnapshot = {
  preferences: Record<string, string[]>;
  frequentTopics: string[];
  recentIntentions: string[];
  riskFlags: string[];
  lastUpdated: string;
  version: number;
};

const DEFAULT_CONFIG: MemoryManagerConfig = {
  enabled: true,
  consolidationIntervalMs: 10 * 60 * 1000,
  maxSummaryChars: 16_000,
  profileUpdateThreshold: 3,
};

function loadConfig(): MemoryManagerConfig {
  const raw = process.env.MEMORY_MANAGER_ENABLED;
  const enabled = raw !== undefined ? !(raw === "0" || raw.toLowerCase() === "false") : true;
  return {
    ...DEFAULT_CONFIG,
    enabled,
    consolidationIntervalMs: Number.parseInt(process.env.MEMORY_MANAGER_CONSOLIDATION_INTERVAL_MS ?? "", 10) || DEFAULT_CONFIG.consolidationIntervalMs,
    profileUpdateThreshold: Number.parseInt(process.env.MEMORY_MANAGER_PROFILE_THRESHOLD ?? "", 10) || DEFAULT_CONFIG.profileUpdateThreshold,
  };
}

export class MemoryManagerService {
  private readonly config: MemoryManagerConfig;
  private readonly consolidationTimers = new Map<string, NodeJS.Timeout>();
  private readonly turnCounters = new Map<string, number>();
  private readonly pendingProfiles = new Map<string, UserProfileSnapshot>();

  constructor(
    private readonly narrativeMemory: NarrativeMemoryPort | null,
    private readonly memorySync: AgentMemorySyncService | null,
    config?: Partial<MemoryManagerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  onTurnCompleted(actorId: string, userText: string, assistantText: string): void {
    if (!this.config.enabled) return;

    const prev = this.turnCounters.get(actorId) ?? 0;
    const next = prev + 1;
    this.turnCounters.set(actorId, next);

    if (next >= this.config.profileUpdateThreshold && !this.consolidationTimers.has(actorId)) {
      this.scheduleConsolidation(actorId);
    }
  }

  async consolidateNow(actorId: string): Promise<MemoryConsolidationResult> {
    const result: MemoryConsolidationResult = {
      entriesMerged: 0,
      entriesRemoved: 0,
      summaryUpdated: false,
      timestamp: new Date().toISOString(),
    };

    if (!this.memorySync) return result;

    try {
      const { revision, entries } = this.memorySync.getSnapshot(actorId, ["memory_summary"]);
      const raw = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      if (!raw || raw.length < 50) return result;

      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length <= 2) return result;

      const consolidated = this.deduplicateLines(lines);
      result.entriesMerged = lines.length - consolidated.length;

      const trimmed = this.pruneOldEntries(consolidated);
      result.entriesRemoved = consolidated.length - trimmed.length;

      if (result.entriesMerged > 0 || result.entriesRemoved > 0) {
        const newSummary = trimmed.join("\n").slice(-this.config.maxSummaryChars);
        const patchResult = this.memorySync.applyPatch(actorId, revision, [
          { key: "memory_summary", op: "put", value: newSummary },
        ]);
        result.summaryUpdated = patchResult.ok;
      }
    } catch {
      /* fire-and-forget */
    }

    await this.synthesizeProfile(actorId);
    this.turnCounters.set(actorId, 0);
    return result;
  }

  getUserProfile(actorId: string): UserProfileSnapshot | null {
    return this.pendingProfiles.get(actorId) ?? null;
  }

  getProfileForPrompt(actorId: string): string | null {
    const profile = this.pendingProfiles.get(actorId);
    if (!profile || Object.keys(profile.preferences).length === 0) return null;

    const parts: string[] = ["【用户长期画像 — 后台记忆管理服务自动生成】"];
    if (profile.frequentTopics.length > 0) {
      parts.push(`高频话题: ${profile.frequentTopics.join("、")}`);
    }
    for (const [key, values] of Object.entries(profile.preferences)) {
      if (values.length > 0) {
        parts.push(`${key}: ${values.join("；")}`);
      }
    }
    if (profile.recentIntentions.length > 0) {
      parts.push(`近期意图: ${profile.recentIntentions.join("、")}`);
    }
    return parts.join("\n");
  }

  async shutdown(): Promise<void> {
    for (const [actorId, timer] of this.consolidationTimers) {
      clearTimeout(timer);
      this.consolidationTimers.delete(actorId);
      await this.consolidateNow(actorId);
    }
  }

  private scheduleConsolidation(actorId: string): void {
    if (this.consolidationTimers.has(actorId)) return;

    const timer = setTimeout(async () => {
      this.consolidationTimers.delete(actorId);
      await this.consolidateNow(actorId);
    }, this.config.consolidationIntervalMs);

    this.consolidationTimers.set(actorId, timer);
    timer.unref?.();
  }

  private deduplicateLines(lines: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const line of lines) {
      const normalized = line.replace(/\[\d{4}-[^\]]*\]\s*/, "").trim().toLowerCase().slice(0, 80);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(line);
    }
    return result;
  }

  private pruneOldEntries(lines: string[], maxAgeHours = 168): string[] {
    const now = Date.now();
    const shortTermCutoff = now - 24 * 3600_000;
    const longTermCutoff = now - maxAgeHours * 3600_000;

    const shortTerm: string[] = [];
    const longTerm: string[] = [];

    for (const line of lines) {
      const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (!match) {
        shortTerm.push(line);
        continue;
      }
      const ts = Date.parse(match[1]!);
      if (isNaN(ts)) {
        shortTerm.push(line);
        continue;
      }

      if (ts > shortTermCutoff) {
        shortTerm.push(line);
      } else if (ts > longTermCutoff && this.isHighValueEntry(line)) {
        longTerm.push(line);
      }
    }

    return [...shortTerm, ...longTerm.slice(0, 20)];
  }

  private isHighValueEntry(line: string): boolean {
    const highValuePatterns = [
      /\[用户要求记住\]/,
      /\[Agent 承诺\/结论\]/,
      /\[fast-path\]/,
      /用户画像/,
      /偏好|喜欢|讨厌|禁忌|生日|纪念日|重要/i,
      /世界入账|购买技能/,
    ];
    return highValuePatterns.some((re) => re.test(line));
  }

  private async synthesizeProfile(actorId: string): Promise<void> {
    if (!this.memorySync) return;

    try {
      const { entries } = this.memorySync.getSnapshot(actorId, ["memory_summary"]);
      const raw = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      if (!raw || raw.length < 100) return;

      const profile = this.extractProfileFromRaw(raw);
      profile.version = (this.pendingProfiles.get(actorId)?.version ?? 0) + 1;
      profile.lastUpdated = new Date().toISOString();
      this.pendingProfiles.set(actorId, profile);

      if (this.narrativeMemory && Object.keys(profile.preferences).length > 0) {
        const profileText = this.formatProfileAsText(profile);
        await this.narrativeMemory.ingest(actorId, profileText, "memory:user_profile", { highSignal: true }).catch(() => {});
      }
    } catch {
      /* fire-and-forget */
    }
  }

  private extractProfileFromRaw(raw: string): UserProfileSnapshot {
    const profile: UserProfileSnapshot = {
      preferences: {},
      frequentTopics: [],
      recentIntentions: [],
      riskFlags: [],
      lastUpdated: "",
      version: 0,
    };

    const topicCounts = new Map<string, number>();
    const intentionPatterns = /(我会|我想|计划|打算|准备|要)([^。\n]{2,30})/g;
    const preferencePatterns = /(喜欢|讨厌|不喜欢|偏好|习惯|经常|总是|从不|不要|别)([^。\n]{2,40})/g;
    const riskPatterns = /(大额|密码|删除|注销|授权|转账|可疑|异常|防盗|诈骗|钓鱼)/g;

    let match: RegExpExecArray | null;
    while ((match = intentionPatterns.exec(raw)) !== null) {
      const intention = `${match[1]}${match[2]}`;
      profile.recentIntentions.push(intention.slice(0, 60));
      const topic = this.extractTopic(intention);
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }

    while ((match = preferencePatterns.exec(raw)) !== null) {
      const category = match[1]!;
      const value = match[2]!.trim();
      if (!profile.preferences[category]) profile.preferences[category] = [];
      if (!profile.preferences[category].includes(value)) {
        profile.preferences[category].push(value.slice(0, 80));
      }
      const topic = this.extractTopic(value);
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }

    while ((match = riskPatterns.exec(raw)) !== null) {
      const flag = match[1]!.trim();
      if (!profile.riskFlags.includes(flag)) {
        profile.riskFlags.push(flag);
      }
    }

    profile.frequentTopics = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([topic]) => topic);

    profile.recentIntentions = [...new Set(profile.recentIntentions)].slice(-6);
    profile.riskFlags = [...new Set(profile.riskFlags)].slice(-5);

    return profile;
  }

  private extractTopic(text: string): string {
    const keywords = text.match(/[\u4e00-\u9fff]{2,}/g);
    if (keywords && keywords.length > 0) return keywords[0]!;
    return text.split(/[\s，。！？、]/)[0]?.trim().slice(0, 10) ?? "general";
  }

  private formatProfileAsText(profile: UserProfileSnapshot): string {
    const parts: string[] = [`用户画像 v${profile.version} (${profile.lastUpdated})`];
    if (profile.frequentTopics.length > 0) {
      parts.push(`关注领域: ${profile.frequentTopics.join("、")}`);
    }
    for (const [cat, vals] of Object.entries(profile.preferences)) {
      if (vals.length > 0) parts.push(`${cat}: ${vals.slice(0, 3).join("；")}`);
    }
    return parts.join("\n");
  }
}

let singleton: MemoryManagerService | null = null;

export function getMemoryManagerService(): MemoryManagerService | null {
  return singleton;
}

export function initMemoryManagerService(
  narrativeMemory: NarrativeMemoryPort | null,
  memorySync: AgentMemorySyncService | null,
  config?: Partial<MemoryManagerConfig>,
): MemoryManagerService | null {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new MemoryManagerService(narrativeMemory, memorySync, config);
  return singleton;
}
