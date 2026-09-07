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
    `);
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
