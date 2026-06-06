import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import { getNightlyMemoryTaskService } from "./nightly-memory-task-service.js";

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
  rememberedCount: number;
  fadedCount: number;
};

export type UserProfileSnapshot = {
  preferences: Record<string, string[]>;
  frequentTopics: string[];
  recentIntentions: string[];
  riskFlags: string[];
  lastUpdated: string;
  version: number;
};

export type MemoryContinuitySnapshot = {
  stableLines: string[];
  fadingLines: string[];
  forgottenLines: string[];
  temporalHighlights: string[];
  lastSleepAt: string;
  lastUpdatedAt: string;
};

export type RelationshipMemorySnapshot = {
  lines: string[];
  lastUpdatedAt: string;
};

export type LifeThemeMemorySnapshot = {
  themes: string[];
  lastUpdatedAt: string;
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
    consolidationIntervalMs:
      Number.parseInt(process.env.MEMORY_MANAGER_CONSOLIDATION_INTERVAL_MS ?? "", 10) ||
      DEFAULT_CONFIG.consolidationIntervalMs,
    profileUpdateThreshold:
      Number.parseInt(process.env.MEMORY_MANAGER_PROFILE_THRESHOLD ?? "", 10) ||
      DEFAULT_CONFIG.profileUpdateThreshold,
  };
}

function formatRelativeAgeLabel(ageHours: number): string {
  if (ageHours < 1) return "just now";
  if (ageHours < 24) return `${Math.floor(ageHours)}h ago`;
  if (ageHours < 24 * 7) return `${Math.floor(ageHours / 24)}d ago`;
  if (ageHours < 24 * 30) return `${Math.floor(ageHours / (24 * 7))}w ago`;
  return `${Math.floor(ageHours / (24 * 30))}mo ago`;
}

function stripTimestampPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export class MemoryManagerService {
  private readonly config: MemoryManagerConfig;
  private readonly consolidationTimers = new Map<string, NodeJS.Timeout>();
  private readonly turnCounters = new Map<string, number>();
  private readonly pendingProfiles = new Map<string, UserProfileSnapshot>();
  private readonly continuitySnapshots = new Map<string, MemoryContinuitySnapshot>();
  private readonly relationshipSnapshots = new Map<string, RelationshipMemorySnapshot>();
  private readonly lifeThemeSnapshots = new Map<string, LifeThemeMemorySnapshot>();

  constructor(
    private readonly narrativeMemory: NarrativeMemoryPort | null,
    private readonly memorySync: AgentMemorySyncService | null,
    config?: Partial<MemoryManagerConfig>,
  ) {
    this.config = { ...loadConfig(), ...config };
  }

  onTurnCompleted(actorId: string, userText: string, assistantText: string): void {
    void userText;
    void assistantText;
    if (!this.config.enabled) return;

    const prev = this.turnCounters.get(actorId) ?? 0;
    const next = prev + 1;
    this.turnCounters.set(actorId, next);

    const nightlyService = getNightlyMemoryTaskService();
    const shouldDefer = nightlyService?.shouldDeferConsolidation() ?? false;
    if (shouldDefer) {
      console.log(`[MemoryManager] Day mode: deferring consolidation for ${actorId} (turns: ${next})`);
      return;
    }

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
      rememberedCount: 0,
      fadedCount: 0,
    };

    if (!this.memorySync) return result;

    let lastRetention: ReturnType<MemoryManagerService["evaluateMemoryRetention"]> | null = null;
    try {
      const { revision, entries } = this.memorySync.getSnapshot(actorId, ["memory_summary"]);
      const raw = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      if (!raw || raw.length < 50) return result;

      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length <= 2) return result;

      const consolidated = this.deduplicateLines(lines);
      result.entriesMerged = lines.length - consolidated.length;

      const retention = this.evaluateMemoryRetention(consolidated);
      lastRetention = retention;
      result.entriesRemoved = retention.forgotten.length;
      result.rememberedCount = retention.remembered.length;
      result.fadedCount = retention.faded.length;

      if (result.entriesMerged > 0 || result.entriesRemoved > 0) {
        const newSummary = [...retention.remembered, ...retention.faded]
          .join("\n")
          .slice(-this.config.maxSummaryChars);
        const patchResult = await this.memorySync.applyPatch(actorId, revision, [
          { key: "memory_summary", op: "put", value: newSummary },
        ]);
        result.summaryUpdated = patchResult.ok;
      }
    } catch {
      /* fire-and-forget */
    }

    await this.synthesizeProfile(actorId);
    if (lastRetention) {
      this.updateContinuitySnapshot(actorId, lastRetention);
      this.updateRelationshipSnapshot(actorId, lastRetention.remembered);
      this.updateLifeThemeSnapshot(actorId, lastRetention.remembered);
    }
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

  getContinuityForPrompt(actorId: string): string | null {
    const snapshot = this.continuitySnapshots.get(actorId);
    if (!snapshot) return null;

    const parts = [
      "【记忆连续性】系统会在夜间整理、压缩并逐渐遗忘低价值内容，高价值内容会保留更久。",
      snapshot.stableLines.length > 0 ? `长期保留: ${snapshot.stableLines.slice(0, 6).join("；")}` : "",
      snapshot.fadingLines.length > 0 ? `正在淡化: ${snapshot.fadingLines.slice(0, 4).join("；")}` : "",
      snapshot.forgottenLines.length > 0 ? `最近淡忘: ${snapshot.forgottenLines.slice(0, 4).join("；")}` : "",
      snapshot.temporalHighlights.length > 0
        ? `时间节律: ${snapshot.temporalHighlights.slice(0, 4).join("；")}`
        : "",
      `最近整理: ${snapshot.lastSleepAt}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  getRelationshipMemoryForPrompt(actorId: string): string | null {
    const snapshot = this.relationshipSnapshots.get(actorId);
    if (!snapshot || snapshot.lines.length === 0) return null;
    return `【关系记忆】${snapshot.lines.slice(0, 6).join("；")}`;
  }

  getLifeThemeMemoryForPrompt(actorId: string): string | null {
    const snapshot = this.lifeThemeSnapshots.get(actorId);
    if (!snapshot || snapshot.themes.length === 0) return null;
    return `【生活主题】${snapshot.themes.slice(0, 6).join("；")}`;
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

  private isHighValueEntry(line: string): boolean {
    const highValuePatterns = [
      /\[用户要求记住\]/,
      /\[Agent 承诺\/结论\]/,
      /\[fast-path\]/,
      /用户画像/,
      /偏好|喜欢|讨厌|禁忌|生日|纪念日|重要/i,
      /世界账户|购买技能/,
    ];
    return highValuePatterns.some((pattern) => pattern.test(line));
  }

  private evaluateMemoryRetention(lines: string[]): {
    remembered: string[];
    faded: string[];
    forgotten: string[];
  } {
    const now = Date.now();
    const scored = lines.map((line) => ({ line, ...this.scoreMemoryLine(line, now) }));

    const remembered = scored
      .filter((item) => item.score >= 1.25)
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, 32)
      .map((item) => item.line);

    const faded = scored
      .filter((item) => item.score >= 0.55 && item.score < 1.25)
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, 24)
      .map((item) => item.line);

    const forgotten = scored
      .filter((item) => item.score < 0.55)
      .map((item) => item.line)
      .slice(0, 32);

    return { remembered, faded, forgotten };
  }

  private scoreMemoryLine(line: string, now: number): { score: number; ts: number } {
    const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
    const ts = match?.[1] ? Date.parse(match[1]) : now;
    const safeTs = Number.isFinite(ts) ? ts : now;
    const ageHours = Math.max(0, (now - safeTs) / 3_600_000);

    let score = Math.exp(-ageHours / 72);
    if (line.includes("【关系线程】")) score += 0.45;
    if (this.isHighValueEntry(line)) score += 1.15;
    if (/\[fast-path\]|\[Agent 承诺\/结论\]/.test(line)) score += 0.6;
    if (/记住|偏好|喜欢|讨厌|禁忌|生日|纪念|重要/.test(line)) score += 0.4;
    if (/股票|买入|卖出|仓位|止损|止盈|工作|加班|夜里|健康|家人|提醒/.test(line)) score += 0.25;
    if (ageHours <= 6) score += 0.28;
    else if (ageHours <= 24) score += 0.18;
    else if (ageHours >= 24 * 14) score -= 0.12;
    if (ageHours > 168) score -= 0.3;

    return { score, ts: safeTs };
  }

  private buildTemporalHighlights(lines: string[]): string[] {
    const now = Date.now();
    return lines
      .slice(0, 12)
      .map((line) => {
        const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
        const ts = match?.[1] ? Date.parse(match[1]) : Number.NaN;
        if (!Number.isFinite(ts)) return null;
        const ageHours = Math.max(0, (now - ts) / 3_600_000);
        return `${formatRelativeAgeLabel(ageHours)}: ${stripTimestampPrefix(line).slice(0, 72)}`;
      })
      .filter((line): line is string => Boolean(line));
  }

  private updateContinuitySnapshot(
    actorId: string,
    retention: { remembered: string[]; faded: string[]; forgotten: string[] },
  ): void {
    this.continuitySnapshots.set(actorId, {
      stableLines: retention.remembered,
      fadingLines: retention.faded,
      forgottenLines: retention.forgotten,
      temporalHighlights: this.buildTemporalHighlights([
        ...retention.remembered,
        ...retention.faded,
      ]),
      lastSleepAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private updateRelationshipSnapshot(actorId: string, remembered: string[]): void {
    const relationshipLines = remembered.filter((line) => {
      return /陪|关心|鼓励|调侃|默契|信任|支持|晚安|辛苦|安慰/i.test(line);
    });
    this.relationshipSnapshots.set(actorId, {
      lines: relationshipLines.slice(0, 8),
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private updateLifeThemeSnapshot(actorId: string, remembered: string[]): void {
    const themes = remembered
      .map((line) => this.extractTopic(line))
      .filter((topic) => topic && topic.length >= 2);
    this.lifeThemeSnapshots.set(actorId, {
      themes: [...new Set(themes)].slice(0, 10),
      lastUpdatedAt: new Date().toISOString(),
    });
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
        await this.narrativeMemory
          .ingest(actorId, profileText, "memory:user_profile", { highSignal: true })
          .catch(() => {});
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
      const category = match[1];
      const value = match[2].trim();
      if (!profile.preferences[category]) profile.preferences[category] = [];
      if (!profile.preferences[category].includes(value)) {
        profile.preferences[category].push(value.slice(0, 80));
      }
      const topic = this.extractTopic(value);
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }

    while ((match = riskPatterns.exec(raw)) !== null) {
      const flag = match[1].trim();
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
    if (keywords && keywords.length > 0) return keywords[0];
    return text.split(/[\s，。！？、]/)[0]?.trim().slice(0, 10) ?? "general";
  }

  private formatProfileAsText(profile: UserProfileSnapshot): string {
    const parts: string[] = [`用户画像 v${profile.version} (${profile.lastUpdated})`];
    if (profile.frequentTopics.length > 0) {
      parts.push(`关注领域: ${profile.frequentTopics.join("、")}`);
    }
    for (const [category, values] of Object.entries(profile.preferences)) {
      if (values.length > 0) {
        parts.push(`${category}: ${values.slice(0, 3).join("；")}`);
      }
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
