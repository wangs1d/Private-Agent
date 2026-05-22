import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ChunkLifecycle, MemoryChunkRow, MemoryJobKind } from "./types.js";
import { getMemoryTreeRootDir } from "./env.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  body TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  fast_score REAL NOT NULL DEFAULT 0,
  deep_score REAL,
  created_at TEXT NOT NULL,
  wiki_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_actor ON chunks(actor_id);
CREATE INDEX IF NOT EXISTS idx_chunks_actor_source ON chunks(actor_id, source_id);
CREATE INDEX IF NOT EXISTS idx_chunks_lifecycle ON chunks(lifecycle);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT NOT NULL,
  leased_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, scheduled_at);

CREATE TABLE IF NOT EXISTS tree_buffers (
  actor_id TEXT NOT NULL,
  tree_type TEXT NOT NULL,
  tree_key TEXT NOT NULL,
  chunk_ids TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, tree_type, tree_key)
);

CREATE TABLE IF NOT EXISTS summaries (
  summary_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  tree_type TEXT NOT NULL,
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL,
  body TEXT NOT NULL,
  chunk_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_actor_tree ON summaries(actor_id, tree_type, tree_key);

CREATE TABLE IF NOT EXISTS entities (
  actor_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  hotness REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_id, entity)
);
`;

export class MemoryTreeStore {
  readonly db: DatabaseSync;
  readonly rootDir: string;
  readonly dbPath: string;

  constructor(rootDir = getMemoryTreeRootDir()) {
    this.rootDir = rootDir;
    this.dbPath = join(rootDir, "chunks.db");
    mkdirSync(rootDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA);
  }

  wikiDir(actorId: string): string {
    return join(this.rootDir, "wiki", actorId);
  }

  async writeWikiFile(actorId: string, chunkId: string, body: string): Promise<string> {
    const dir = this.wikiDir(actorId);
    await mkdir(dir, { recursive: true });
    const rel = join("wiki", actorId, `${chunkId}.md`);
    const abs = join(this.rootDir, rel);
    await writeFile(abs, `${body}\n`, "utf8");
    return rel.replace(/\\/g, "/");
  }

  insertChunk(row: MemoryChunkRow): boolean {
    const existing = this.db
      .prepare("SELECT chunk_id FROM chunks WHERE chunk_id = ?")
      .get(row.chunkId);
    if (existing) return false;

    this.db
      .prepare(
        `INSERT INTO chunks (
          chunk_id, actor_id, source_id, body, token_count, lifecycle,
          fast_score, deep_score, created_at, wiki_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.chunkId,
        row.actorId,
        row.sourceId,
        row.body,
        row.tokenCount,
        row.lifecycle,
        row.fastScore,
        row.deepScore,
        row.createdAt,
        row.wikiPath,
      );
    return true;
  }

  updateChunkLifecycle(chunkId: string, lifecycle: ChunkLifecycle, deepScore?: number): void {
    if (deepScore != null) {
      this.db
        .prepare("UPDATE chunks SET lifecycle = ?, deep_score = ? WHERE chunk_id = ?")
        .run(lifecycle, deepScore, chunkId);
    } else {
      this.db.prepare("UPDATE chunks SET lifecycle = ? WHERE chunk_id = ?").run(lifecycle, chunkId);
    }
  }

  getChunk(chunkId: string): MemoryChunkRow | null {
    const r = this.db
      .prepare(
        `SELECT chunk_id, actor_id, source_id, body, token_count, lifecycle,
                fast_score, deep_score, created_at, wiki_path
         FROM chunks WHERE chunk_id = ?`,
      )
      .get(chunkId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      chunkId: String(r.chunk_id),
      actorId: String(r.actor_id),
      sourceId: String(r.source_id),
      body: String(r.body),
      tokenCount: Number(r.token_count),
      lifecycle: r.lifecycle as ChunkLifecycle,
      fastScore: Number(r.fast_score),
      deepScore: r.deep_score == null ? null : Number(r.deep_score),
      createdAt: String(r.created_at),
      wikiPath: String(r.wiki_path),
    };
  }

  listDistinctActorIds(limit = 500): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT actor_id FROM chunks ORDER BY actor_id LIMIT ?")
      .all(limit) as Array<{ actor_id: string }>;
    return rows.map((r) => r.actor_id);
  }

  listRecentChunks(limit = 300): MemoryChunkRow[] {
    const rows = this.db
      .prepare(
        `SELECT chunk_id, actor_id, source_id, body, token_count, lifecycle,
                fast_score, deep_score, created_at, wiki_path
         FROM chunks WHERE lifecycle IN ('admitted','buffered','sealed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      chunkId: String(r.chunk_id),
      actorId: String(r.actor_id),
      sourceId: String(r.source_id),
      body: String(r.body),
      tokenCount: Number(r.token_count),
      lifecycle: r.lifecycle as ChunkLifecycle,
      fastScore: Number(r.fast_score),
      deepScore: r.deep_score == null ? null : Number(r.deep_score),
      createdAt: String(r.created_at),
      wikiPath: String(r.wiki_path),
    }));
  }

  listChunksForActor(actorId: string, limit = 2000): MemoryChunkRow[] {
    const rows = this.db
      .prepare(
        `SELECT chunk_id, actor_id, source_id, body, token_count, lifecycle,
                fast_score, deep_score, created_at, wiki_path
         FROM chunks WHERE actor_id = ? AND lifecycle IN ('admitted','buffered','sealed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(actorId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      chunkId: String(r.chunk_id),
      actorId: String(r.actor_id),
      sourceId: String(r.source_id),
      body: String(r.body),
      tokenCount: Number(r.token_count),
      lifecycle: r.lifecycle as ChunkLifecycle,
      fastScore: Number(r.fast_score),
      deepScore: r.deep_score == null ? null : Number(r.deep_score),
      createdAt: String(r.created_at),
      wikiPath: String(r.wiki_path),
    }));
  }

  enqueueJob(kind: MemoryJobKind, dedupeKey: string, payload: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (kind, dedupe_key, payload, status, scheduled_at)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(kind, dedupeKey, JSON.stringify(payload), now);
  }

  claimNextJob(leaseMs: number): { id: number; kind: MemoryJobKind; payload: Record<string, unknown> } | null {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT id, kind, payload FROM jobs
         WHERE status = 'pending' AND scheduled_at <= ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get(now.toISOString()) as { id: number; kind: string; payload: string } | undefined;
    if (!row) return null;

    const updated = this.db
      .prepare(
        `UPDATE jobs SET status = 'leased', leased_until = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .run(leaseUntil, row.id);
    if (updated.changes === 0) return null;

    return {
      id: row.id,
      kind: row.kind as MemoryJobKind,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
  }

  completeJob(id: number): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  failJob(id: number, retryDelayMs: number): void {
    const scheduled = new Date(Date.now() + retryDelayMs).toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', leased_until = NULL, scheduled_at = ?
         WHERE id = ? AND attempts < 8`,
      )
      .run(scheduled, id);
    this.db.prepare("DELETE FROM jobs WHERE id = ? AND attempts >= 8").run(id);
  }

  releaseExpiredLeases(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', leased_until = NULL
         WHERE status = 'leased' AND leased_until IS NOT NULL AND leased_until < ?`,
      )
      .run(now);
  }

  getBuffer(actorId: string, treeType: string, treeKey: string): string[] {
    const row = this.db
      .prepare(
        "SELECT chunk_ids FROM tree_buffers WHERE actor_id = ? AND tree_type = ? AND tree_key = ?",
      )
      .get(actorId, treeType, treeKey) as { chunk_ids: string } | undefined;
    if (!row) return [];
    try {
      const arr = JSON.parse(row.chunk_ids) as unknown;
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }

  setBuffer(actorId: string, treeType: string, treeKey: string, chunkIds: string[]): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tree_buffers (actor_id, tree_type, tree_key, chunk_ids, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, tree_type, tree_key) DO UPDATE SET
           chunk_ids = excluded.chunk_ids, updated_at = excluded.updated_at`,
      )
      .run(actorId, treeType, treeKey, JSON.stringify(chunkIds), now);
  }

  insertSummary(
    summaryId: string,
    actorId: string,
    treeType: string,
    treeKey: string,
    level: number,
    body: string,
    chunkIds: string[],
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO summaries (
          summary_id, actor_id, tree_type, tree_key, level, body, chunk_ids, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summaryId,
        actorId,
        treeType,
        treeKey,
        level,
        body,
        JSON.stringify(chunkIds),
        new Date().toISOString(),
      );
  }

  listSummaries(
    actorId: string,
    treeType: string,
    treeKey: string,
    limit = 5,
  ): Array<{ level: number; body: string; summaryId: string }> {
    const rows = this.db
      .prepare(
        `SELECT summary_id, level, body FROM summaries
         WHERE actor_id = ? AND tree_type = ? AND tree_key = ?
         ORDER BY level DESC, created_at DESC LIMIT ?`,
      )
      .all(actorId, treeType, treeKey, limit) as Array<{
      summary_id: string;
      level: number;
      body: string;
    }>;
    return rows.map((r) => ({
      summaryId: r.summary_id,
      level: r.level,
      body: r.body,
    }));
  }

  bumpEntityHotness(actorId: string, entity: string, delta = 1): void {
    this.db
      .prepare(
        `INSERT INTO entities (actor_id, entity, hotness) VALUES (?, ?, ?)
         ON CONFLICT(actor_id, entity) DO UPDATE SET hotness = hotness + ?`,
      )
      .run(actorId, entity, delta, delta);
  }

  close(): void {
    this.db.close();
  }

  hotEntities(actorId: string, minHotness: number, limit = 8): string[] {
    const rows = this.db
      .prepare(
        `SELECT entity FROM entities WHERE actor_id = ? AND hotness >= ?
         ORDER BY hotness DESC LIMIT ?`,
      )
      .all(actorId, minHotness, limit) as Array<{ entity: string }>;
    return rows.map((r) => r.entity);
  }
}
