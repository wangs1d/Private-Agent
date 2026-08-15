/**
 * 跨会话开放环路（Session Epitome）—— 记忆连续性优化 Phase 2
 *
 * 背景缺口：`recentConversationHistory` 只在会话内注入；换会话后，
 * 上一会话的"未完成请求、Agent 承诺、进行中状态"没有显式传递，
 * 这正是"换了会话就跳转/失忆"的常见根源。
 *
 * 本模块模拟人类的"跨会话记忆"：
 * - 每轮 cognize 结束后，从本轮对话提取开放环路（open loops：未完成请求）、
 *   承诺（Agent commitments）、偏好（用户偏好/事实）；
 * - 按 actor 持久化到 KV（key `session_epitome`），增量合并、去重、限量；
 * - 新会话开场（thread 较短）时注入【上一会话待办】块，让连续性跨会话延续。
 *
 * 设计约束：
 * - 规则驱动提取（复用 memory-signal 正则），不调 LLM，低延迟可测；
 * - KV 持久化失败静默降级（不影响对话主链路）；
 * - 分类互斥：同一行只归入一类，避免重复。
 */

import type { MemoryItem } from "../brain/types.js";
import { AGENT_COMMITMENT_RE, MEMORY_EXPLICIT_RE } from "../agent/memory-signal.js";
import { normalizeMemoryLine } from "./memory-record-utils.js";

export type EpitomeEntryKind = "open_loop" | "commitment" | "preference";

export interface SessionEpitomeEntries {
  openLoops: string[];
  commitments: string[];
  preferences: string[];
}

export interface SessionEpitomeSnapshot extends SessionEpitomeEntries {
  updatedAt: string;
  revision: number;
}

/** KV 持久化适配器（与 KvSummaryLike 同形状）。 */
export interface EpitomeKvLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> } | null;
  setEntry?(actorId: string, key: string, value: unknown): void;
}

export const EPITOME_KV_KEY = "session_epitome";

const MAX_ENTRIES_PER_KIND = 6;

// 用户请求信号（开放环路）：请求/待办/安排/提醒 语义
const USER_REQUEST_RE = /请|帮我|需要|想要|安排|提醒|订|买|查|分析|总结|继续|修复|优化|看看|做一个|我要|我想/i;
// 进行中/未完成语义
const OPEN_LOOP_RE = /还没|尚未|未完成|待办|稍后|回头|之后再|记得帮我|别忘/i;

function nowIso(): string {
  return new Date().toISOString();
}

function clampList(list: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const normalized = typeof item === "string" ? item.trim().replace(/\s+/g, " ") : "";
    if (!normalized || normalized.length < 4) continue;
    const key = normalizeMemoryLine(normalized).slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 从一行文本归类 epitome 条目（互斥：只归入一类）。
 * 优先判定 open loop（请求语义）→ commitment（Agent 承诺）→ preference（偏好/事实）。
 */
export function classifyEpitomeLine(line: string): EpitomeEntryKind | null {
  const t = typeof line === "string" ? line.trim() : "";
  if (!t || t.length < 4) return null;
  // 显式前缀优先（detectMemorySignals / recap 行的结构化前缀）
  if (/^\[用户要求记住\]|^\[Agent 承诺\/结论\]|^\[用户偏好\]|^\[用户事实\]/.test(t)) {
    if (t.startsWith("[Agent 承诺/结论]")) return "commitment";
    if (t.startsWith("[用户要求记住]")) return "preference";
    return "preference";
  }
  // Agent 承诺优先于请求：承诺行常含"提醒/安排/设置"等与请求重合的词
  // （如"已为你设置提醒"），必须先判承诺，否则会被请求规则截胡。
  if (AGENT_COMMITMENT_RE.test(t)) return "commitment";
  if (OPEN_LOOP_RE.test(t) || USER_REQUEST_RE.test(t)) return "open_loop";
  if (MEMORY_EXPLICIT_RE.test(t)) return "preference";
  return null;
}

/**
 * 从本轮对话提取 epitome 条目。
 * @param query 用户输入
 * @param writes 本轮认知产出的记忆写入（MemoryItem[]）
 * @param assistantText 可选：Agent 回复文本（提取承诺）
 */
export function extractEpitomeEntries(
  query: string,
  writes: MemoryItem[] = [],
  assistantText?: string,
): SessionEpitomeEntries {
  const openLoops: string[] = [];
  const commitments: string[] = [];
  const preferences: string[] = [];

  const push = (kind: EpitomeEntryKind, line: string): void => {
    const t = typeof line === "string" ? line.trim() : "";
    if (!t || t.length < 4) return;
    if (kind === "open_loop") openLoops.push(t);
    else if (kind === "commitment") commitments.push(t);
    else preferences.push(t);
  };

  // 1) 用户输入：请求语义 → 开放环路；显式记住 → 偏好
  if (query) {
    const q = query.trim();
    const kind = classifyEpitomeLine(q);
    if (kind === "open_loop") push("open_loop", q);
    else if (kind === "preference") push("preference", q);
  }

  // 2) 记忆写入：按 content 归类
  for (const w of writes) {
    if (!w || typeof w.content !== "string") continue;
    const kind = classifyEpitomeLine(w.content);
    if (kind) push(kind, w.content);
  }

  // 3) Agent 回复：承诺/结论
  if (assistantText) {
    const kind = classifyEpitomeLine(assistantText);
    if (kind === "commitment") push("commitment", assistantText);
  }

  return {
    openLoops: clampList(openLoops, MAX_ENTRIES_PER_KIND),
    commitments: clampList(commitments, MAX_ENTRIES_PER_KIND),
    preferences: clampList(preferences, MAX_ENTRIES_PER_KIND),
  };
}

function parseStoredSnapshot(value: unknown): SessionEpitomeSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const asList = (k: string): string[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    openLoops: asList("openLoops"),
    commitments: asList("commitments"),
    preferences: asList("preferences"),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso(),
    revision: typeof o.revision === "number" ? o.revision : 0,
  };
}

/**
 * 跨会话开放环路存储：进程内 per-actor 缓存 + KV 懒加载持久化。
 * 纯逻辑可单测；KvLike 可注入 mock。
 */
export class SessionEpitomeStore {
  private kv: EpitomeKvLike | null;
  private cache = new Map<string, SessionEpitomeSnapshot>();

  constructor(kv: EpitomeKvLike | null = null) {
    this.kv = kv;
  }

  /** 绑定 KV 持久化适配器。 */
  attach(kv: EpitomeKvLike): void {
    this.kv = kv;
  }

  private load(actorId: string): SessionEpitomeSnapshot {
    const cached = this.cache.get(actorId);
    if (cached) return cached;
    let snapshot: SessionEpitomeSnapshot = {
      openLoops: [],
      commitments: [],
      preferences: [],
      updatedAt: "",
      revision: 0,
    };
    if (this.kv) {
      try {
        const raw = this.kv.getSnapshot(actorId, [EPITOME_KV_KEY]);
        const parsed = raw?.entries?.[EPITOME_KV_KEY]
          ? parseStoredSnapshot(raw.entries[EPITOME_KV_KEY])
          : null;
        if (parsed) snapshot = parsed;
      } catch {
        /* KV 读取失败使用空快照 */
      }
    }
    this.cache.set(actorId, snapshot);
    return snapshot;
  }

  private persist(actorId: string): void {
    if (!this.kv?.setEntry) return;
    const cached = this.cache.get(actorId);
    if (!cached) return;
    const next: SessionEpitomeSnapshot = { ...cached, revision: cached.revision + 1 };
    cached.revision = next.revision;
    try {
      this.kv.setEntry(actorId, EPITOME_KV_KEY, next);
    } catch {
      /* 持久化失败不阻塞 */
    }
  }

  /** 增量合并本轮提取的条目（去重、限量），并持久化。 */
  record(actorId: string, entries: SessionEpitomeEntries): SessionEpitomeSnapshot {
    const current = this.load(actorId);
    const merge = (existing: string[], incoming: string[]): string[] => {
      const merged = [...incoming, ...existing];
      return clampList(merged, MAX_ENTRIES_PER_KIND);
    };
    const next: SessionEpitomeSnapshot = {
      openLoops: merge(current.openLoops, entries.openLoops),
      commitments: merge(current.commitments, entries.commitments),
      preferences: merge(current.preferences, entries.preferences),
      updatedAt: nowIso(),
      revision: current.revision,
    };
    this.cache.set(actorId, next);
    this.persist(actorId);
    return next;
  }

  /** 读取某 actor 的 epitome 快照（无数据返回空快照）。 */
  get(actorId: string): SessionEpitomeSnapshot {
    return this.load(actorId);
  }
}
