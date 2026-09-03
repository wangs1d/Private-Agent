import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";
import { aggregateByWeekday } from "./dimensions/overtime-model.js";

import type { RhythmProfile } from "./types.js";

/** 旧版落盘数据兼容：从 recentDays 重新派生按星期聚合值 */
const aggregateOvertime = aggregateByWeekday;

/**
 * 节律画像存储：每 actor 一个 JSON 文件（data/rhythm_profiles/{actorId}.json），
 * writeJsonAtomic 原子落盘。文件名做安全转义，防 actorId 带路径分隔符。
 */
export class RhythmProfileStore {
  private readonly cache = new Map<string, RhythmProfile>();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      return;
    }
    for ( const name of entries) {
      if (!name.endsWith(".json")) continue;
      const actorId = unescapeActorId(name.slice(0, -".json".length));
      try {
        const raw = await readFile(join(this.dir, name), "utf8");
        const profile = normalizeProfile(JSON.parse(raw));
        if (profile) this.cache.set(profile.actorId, profile);
      } catch (error) {
        console.error(`[RhythmProfileStore] load ${name} failed:`, error);
      }
    }
  }

  get(actorId: string): RhythmProfile | null {
    return this.cache.get(actorId) ?? null;
  }

  /** 读取或初始化画像（不落盘，落盘由 save 负责） */
  ensure(actorId: string, now = new Date()): RhythmProfile {
    const existing = this.cache.get(actorId);
    if (existing) return existing;
    const fresh = normalizeProfile({
      schemaVersion: 1,
      actorId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastAnalyzedDay: null,
      dimensions: {},
      reminderSlots: {},
      lastCandidateAt: {},
      insights: [],
    })!;
    this.cache.set(actorId, fresh);
    return fresh;
  }

  async save(profile: RhythmProfile): Promise<void> {
    this.cache.set(profile.actorId, profile);
    await writeJsonAtomic(join(this.dir, `${escapeActorId(profile.actorId)}.json`), profile);
  }

  listActorIds(): string[] {
    return [...this.cache.keys()];
  }
}

function escapeActorId(actorId: string): string {
  return actorId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function unescapeActorId(name: string): string {
  return name;
}

/** 宽松归一化：磁盘旧版本/半损坏数据不致命，缺的字段补默认值 */
export function normalizeProfile(raw: unknown): RhythmProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const actorId = typeof o.actorId === "string" ? o.actorId : "";
  if (!actorId) return null;
  const dims = (o.dimensions ?? {}) as Record<string, Record<string, unknown>>;
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 1,
    actorId,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : nowIso,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso,
    lastAnalyzedDay: typeof o.lastAnalyzedDay === "string" ? o.lastAnalyzedDay : null,
    dimensions: {
      sleep: normalizeSleep(dims.sleep),
      focus: normalizeFocus(dims.focus),
      overtime: normalizeOvertime(dims.overtime),
      receptivity: normalizeReceptivity(dims.receptivity),
    },
    reminderSlots: normalizeSlots(o.reminderSlots),
    lastCandidateAt:
      o.lastCandidateAt && typeof o.lastCandidateAt === "object"
        ? (o.lastCandidateAt as RhythmProfile["lastCandidateAt"])
        : {},
    insights: Array.isArray(o.insights) ? (o.insights as RhythmProfile["insights"]).slice(-20) : [],
  };
}

function normalizeSleep(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["sleep"] {
  const samples = Array.isArray(v?.samples)
    ? (v!.samples as RhythmProfile["dimensions"]["sleep"]["samples"]).filter(
        (s) => s && typeof s.date === "string" && Number.isFinite(s.startHour) && Number.isFinite(s.endHour),
      )
    : [];
  return {
    samples,
    windowStartHour: Number.isFinite(v?.windowStartHour) ? (v!.windowStartHour as number) : null,
    windowEndHour: Number.isFinite(v?.windowEndHour) ? (v!.windowEndHour as number) : null,
    sampleCount: samples.length,
    trendMinutes: Number.isFinite(v?.trendMinutes) ? (v!.trendMinutes as number) : 0,
  };
}

function normalizeFocus(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["focus"] {
  const histogram = Array.isArray(v?.hourHistogram)
    ? (v!.hourHistogram as number[]).slice(0, 24).map((x) => (Number.isFinite(x) ? x : 0))
    : [];
  while (histogram.length < 24) histogram.push(0);
  return {
    hourHistogram: histogram,
    peakBlocks: Array.isArray(v?.peakBlocks) ? (v!.peakBlocks as RhythmProfile["dimensions"]["focus"]["peakBlocks"]) : [],
    totalWeight: Number(v?.totalWeight) || 0,
  };
}

function normalizeOvertime(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["overtime"] {
  const fill = (arr: unknown, len: number): number[] => {
    const src = Array.isArray(arr) ? arr : [];
    const out = src.slice(0, len).map((x) => (Number.isFinite(x) ? x : 0));
    while (out.length < len) out.push(0);
    return out;
  };
  const recentDays = Array.isArray(v?.recentDays)
    ? (v!.recentDays as RhythmProfile["dimensions"]["overtime"]["recentDays"]).filter(
        (d): d is RhythmProfile["dimensions"]["overtime"]["recentDays"][number] =>
          !!d && typeof d.date === "string" && Number.isInteger(d.weekday) && (d.late === 0 || d.late === 1),
      )
    : [];
  const aggregated = aggregateOvertime(recentDays);
  return {
    recentDays,
    ...aggregated,
    totalDays: recentDays.length,
  };
}

function normalizeReceptivity(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["receptivity"] {
  const fill = (arr: unknown, len: number): number[] => {
    const src = Array.isArray(arr) ? arr : [];
    const out = src.slice(0, len).map((x) => (Number.isFinite(x) ? x : 0));
    while (out.length < len) out.push(0);
    return out;
  };
  return {
    byHour: fill(v?.byHour, 24),
    byWeekday: fill(v?.byWeekday, 7),
    attempts: Number(v?.attempts) || 0,
  };
}

function normalizeSlots(v: unknown): RhythmProfile["reminderSlots"] {
  if (!v || typeof v !== "object") return {};
  const out: RhythmProfile["reminderSlots"] = {};
  for (const [taskId, slot] of Object.entries(v as Record<string, Record<string, unknown>>)) {
    if (!slot || typeof slot !== "object" || !Number.isFinite(slot.hour)) continue;
    out[taskId] = {
      taskId,
      hour: slot.hour as number,
      originalHour: Number.isFinite(slot.originalHour) ? (slot.originalHour as number) : (slot.hour as number),
      acceptanceEwma: Number.isFinite(slot.acceptanceEwma) ? (slot.acceptanceEwma as number) : null,
      attempts: Number(slot.attempts) || 0,
      lastAdjustedAt: typeof slot.lastAdjustedAt === "string" ? slot.lastAdjustedAt : null,
      lastAdjustDirection:
        slot.lastAdjustDirection === "earlier" || slot.lastAdjustDirection === "later"
          ? slot.lastAdjustDirection
          : null,
      pinnedByUser: slot.pinnedByUser === true,
    };
  }
  return out;
}
