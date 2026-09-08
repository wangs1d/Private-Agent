/**
 * 记忆强化存储（召回反馈环，2026-09 优化）。
 *
 * Mem0 OSS 的 update() 只改文本、不支持 metadata 增量更新，召回命中信息
 * 无法写回向量库 payload——因此落在项目共享 SQLite（agentic-memory.db）
 * 的侧表 memory_reinforcement 中，按 mem0_id 关联：
 *   - retrieval 召回命中 → touch()（access_count+1、last_access_at 刷新）；
 *   - lifecycle TTL 巡检 → 用 max(createdAt, last_access_at) 判过期
 *     （经常被召回的记忆不再被"创建太久"误删），并按 access_count 微调豁免；
 *   - 删除/清空 → purgeIds()/purgeActor() 同步回收，防侧表无限增长。
 *
 * 同步 better-sqlite3，调用方 fire-and-forget 即可；表缺失自动建。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { openAgenticSqlite } from "./sqlite-store.js";

export interface MemoryAccessStats {
  accessCount: number;
  lastAccessAt: number;
}

export class MemoryReinforcementStore {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_reinforcement (
        mem0_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_access_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_reinforcement_actor
        ON memory_reinforcement(actor_id);
      CREATE TABLE IF NOT EXISTS lifecycle_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // 两阶段遗忘（2026-09）：archived_at 非空 = 已归档（召回侧过滤，待物理删）
    const cols = this.db
      .prepare(`PRAGMA table_info(memory_reinforcement)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "archived_at")) {
      this.db.exec(`ALTER TABLE memory_reinforcement ADD COLUMN archived_at INTEGER`);
    }
  }

  /** 召回命中强化：存在则计数+1 并刷新时间，不存在则初始化（count=1）。 */
  touch(memoryIds: string[], actorId: string, now = Date.now()): void {
    if (memoryIds.length === 0) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO memory_reinforcement (mem0_id, actor_id, access_count, last_access_at, created_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(mem0_id) DO UPDATE SET
          access_count = access_count + 1,
          last_access_at = excluded.last_access_at
      `);
      const tx = this.db.transaction((ids: string[]) => {
        for (const id of ids) stmt.run(id, actorId, now, now);
      });
      tx(memoryIds);
    } catch (err) {
      console.warn("[memory-reinforcement] touch 失败（忽略）:", err);
    }
  }

  /** 批量读取访问统计（缺失的 id 不在返回 Map 中）。 */
  getStats(memoryIds: string[]): Map<string, MemoryAccessStats> {
    const out = new Map<string, MemoryAccessStats>();
    if (memoryIds.length === 0) return out;
    try {
      const placeholders = memoryIds.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT mem0_id, access_count, last_access_at FROM memory_reinforcement WHERE mem0_id IN (${placeholders})`,
        )
        .all(...memoryIds) as Array<{ mem0_id: string; access_count: number; last_access_at: number }>;
      for (const r of rows) {
        out.set(r.mem0_id, { accessCount: r.access_count, lastAccessAt: r.last_access_at });
      }
    } catch (err) {
      console.warn("[memory-reinforcement] getStats 失败（忽略）:", err);
    }
    return out;
  }

  /** 记忆删除后回收侧表行（lifecycle/去重/supersession 删除路径调用）。 */
  purgeIds(memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    try {
      const placeholders = memoryIds.map(() => "?").join(",");
      this.db
        .prepare(`DELETE FROM memory_reinforcement WHERE mem0_id IN (${placeholders})`)
        .run(...memoryIds);
    } catch (err) {
      console.warn("[memory-reinforcement] purgeIds 失败（忽略）:", err);
    }
  }

  // ── 两阶段遗忘：归档（可恢复）→ 到期物理删 ──

  /** SQLite IN 子句分块上限（默认参数上限 999，留足余量）。 */
  private static readonly CHUNK = 400;

  private chunk<T>(items: T[], fn: (batch: T[]) => void): void {
    for (let i = 0; i < items.length; i += MemoryReinforcementStore.CHUNK) {
      fn(items.slice(i, i + MemoryReinforcementStore.CHUNK));
    }
  }

  /**
   * 归档（第一阶段）：标记 archived_at，向量库记录保留但召回侧过滤。
   * 侧表无行的记忆在此初始化（access_count=0）。已归档的不覆盖原归档时间。
   * 返回本次新归档条数。
   */
  archiveIds(memoryIds: string[], actorId: string, now = Date.now()): number {
    if (memoryIds.length === 0) return 0;
    let newly = 0;
    try {
      const insert = this.db.prepare(`
        INSERT INTO memory_reinforcement (mem0_id, actor_id, access_count, last_access_at, created_at, archived_at)
        VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(mem0_id) DO NOTHING
      `);
      const mark = this.db.prepare(
        `UPDATE memory_reinforcement SET archived_at = ? WHERE mem0_id = ? AND archived_at IS NULL`,
      );
      const tx = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          // 新行：INSERT 即归档；已有行：仅当未归档时标记（不覆盖原归档时间）
          newly += insert.run(id, actorId, now, now, now).changes;
          newly += mark.run(now, id).changes;
        }
      });
      this.chunk(memoryIds, (batch) => tx(batch));
    } catch (err) {
      console.warn("[memory-reinforcement] archiveIds 失败（忽略）:", err);
      return 0;
    }
    return newly;
  }

  /** 给定 id 中已归档的集合（召回过滤用）。 */
  getArchivedIds(memoryIds: string[]): Set<string> {
    const out = new Set<string>();
    if (memoryIds.length === 0) return out;
    try {
      this.chunk(memoryIds, (batch) => {
        const placeholders = batch.map(() => "?").join(",");
        const rows = this.db
          .prepare(
            `SELECT mem0_id FROM memory_reinforcement WHERE archived_at IS NOT NULL AND mem0_id IN (${placeholders})`,
          )
          .all(...batch) as Array<{ mem0_id: string }>;
        for (const r of rows) out.add(r.mem0_id);
      });
    } catch (err) {
      console.warn("[memory-reinforcement] getArchivedIds 失败（忽略）:", err);
    }
    return out;
  }

  /**
   * 归档超过 retentionDays 的 mem0_id 列表（第二阶段：调用方向量库物理删后
   * 应 purgeIds 回收行）。retentionDays<=0 时返回空（归档永久保留）。
   */
  expiredArchived(retentionDays: number, now = Date.now()): string[] {
    if (retentionDays <= 0) return [];
    try {
      const cutoff = now - retentionDays * 86_400_000;
      const rows = this.db
        .prepare(`SELECT mem0_id FROM memory_reinforcement WHERE archived_at IS NOT NULL AND archived_at < ?`)
        .all(cutoff) as Array<{ mem0_id: string }>;
      return rows.map((r) => r.mem0_id);
    } catch (err) {
      console.warn("[memory-reinforcement] expiredArchived 失败（忽略）:", err);
      return [];
    }
  }

  /** 当前归档行数（统计/观测用）。 */
  archivedCount(): number {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM memory_reinforcement WHERE archived_at IS NOT NULL`)
        .get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  // ── lifecycle 键值持久化（去重游标 / LLM 审查时间戳；进程重启不再重扫） ──

  kvGet(key: string): string | null {
    try {
      const row = this.db.prepare(`SELECT value FROM lifecycle_kv WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  kvSet(key: string, value: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO lifecycle_kv (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    } catch (err) {
      console.warn("[memory-reinforcement] kvSet 失败（忽略）:", err);
    }
  }

  /** actor 级联清空（memory-clear-service 调用），返回回收行数。 */
  purgeActor(actorId: string): number {
    try {
      const r = this.db
        .prepare(`DELETE FROM memory_reinforcement WHERE actor_id = ?`)
        .run(actorId);
      return r.changes;
    } catch {
      return 0;
    }
  }
}

let singleton: MemoryReinforcementStore | null = null;

/** runtime 初始化时注册；关闭/测试环境可为 null（各消费点判空降级）。 */
export function configureMemoryReinforcement(store: MemoryReinforcementStore | null): void {
  singleton = store;
}

export function getMemoryReinforcementStore(): MemoryReinforcementStore | null {
  return singleton;
}
