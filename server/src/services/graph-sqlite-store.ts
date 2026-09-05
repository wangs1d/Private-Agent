/**
 * 认知图 SQLite 行级持久化（P1-9）。
 *
 * 此前 HumanLikeMemoryService 每次持久化都 writeJsonAtomic 全量重写
 * human-memory.json——节点数上万后，每次 ingest/召回触碰（lastAccessedAt、
 * accessCount 更新都会 schedulePersist）都伴随全文件序列化 + fsync，成为
 * 记忆子系统的规模天花板。
 *
 * 本模块把 store 的五个集合（nodes/edges/versions/communities/domains）
 * 存为 SQLite 行，持久化时做 hash-diff：只写变更行、删消失行——高频小改动
 * 从 O(全文件) 降到 O(脏行)。内存结构与读写逻辑完全不变，仅替换持久化层。
 *
 * 迁移：SQLite 为空且同目录 .json 存在时自动种子导入（JSON 保留作备份不删除）。
 * 回退：AGENT_HUMAN_MEMORY_STORE=json 恢复旧的文件持久化。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database, { type Database as SqliteDatabase, type Statement } from "better-sqlite3";

export interface GraphCollections {
  version: number;
  domains: Record<string, unknown>;
  nodes: Record<string, unknown>;
  edges: Record<string, unknown>;
  versions: Record<string, unknown>;
  communities: Record<string, unknown>;
}

type CollectionName = "domains" | "nodes" | "edges" | "versions" | "communities";
const COLLECTIONS: CollectionName[] = ["domains", "nodes", "edges", "versions", "communities"];

function jsonHash(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

export class GraphSqlitePersistence {
  private readonly db: SqliteDatabase;
  private readonly jsonPath: string;
  private hashes = new Map<string, string>();

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    // human-memory.json → human-memory.sqlite（同目录；无 .json 后缀则追加）
    const dbPath = jsonPath.endsWith(".json")
      ? `${jsonPath.slice(0, -5)}.sqlite`
      : `${jsonPath}.sqlite`;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    for (const c of COLLECTIONS) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hm_${c} (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          json TEXT NOT NULL
        );
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hm_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  setHashes(hashes: Map<string, string>): void {
    this.hashes = hashes;
  }

  /**
   * 加载：SQLite 有数据直接重建；为空且存在旧 JSON 时自动种子迁移。
   * 返回集合数据与行 hash 表（供后续 diff）。两者皆空返回 null data。
   */
  async load(): Promise<{ data: Partial<GraphCollections> | null; hashes: Map<string, string> }> {
    const out: Partial<GraphCollections> = {};
    let total = 0;
    for (const c of COLLECTIONS) {
      const rows = this.db.prepare(`SELECT id, json FROM hm_${c}`).all() as Array<{
        id: string;
        json: string;
      }>;
      const record: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          record[row.id] = JSON.parse(row.json);
        } catch {
          /* 单行损坏跳过 */
        }
      }
      out[c] = record;
      total += rows.length;
    }
    const metaRow = this.db.prepare(`SELECT value FROM hm_meta WHERE key = 'version'`).get() as
      | { value: string | null }
      | undefined;
    out.version = metaRow?.value ? Number(metaRow.value) || 0 : 0;

    if (total === 0) {
      // 空库：尝试从旧 JSON 迁移种子
      const migrated = await this.seedFromJson();
      if (migrated) return this.load();
      return { data: null, hashes: this.hashes };
    }

    this.rebuildHashes(out as GraphCollections);
    return { data: out, hashes: this.hashes };
  }

  private async seedFromJson(): Promise<boolean> {
    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<GraphCollections>;
      if (!parsed || typeof parsed !== "object") return false;
      const seeded: GraphCollections = {
        version: typeof parsed.version === "number" ? parsed.version : 0,
        domains: parsed.domains ?? {},
        nodes: parsed.nodes ?? {},
        edges: parsed.edges ?? {},
        versions: parsed.versions ?? {},
        communities: parsed.communities ?? {},
      };
      this.save(seeded);
      this.db
        .prepare(`INSERT OR REPLACE INTO hm_meta(key, value) VALUES ('jsonMigratedAt', ?)`)
        .run(new Date().toISOString());
      console.info(
        `[graph-sqlite] 已从 ${this.jsonPath} 迁移种子：` +
          `nodes=${Object.keys(seeded.nodes).length} edges=${Object.keys(seeded.edges).length}`,
      );
      return true;
    } catch {
      return false; // JSON 不存在/损坏：全新库
    }
  }

  private rebuildHashes(collections: GraphCollections): void {
    this.hashes = new Map();
    for (const c of COLLECTIONS) {
      for (const [id, value] of Object.entries(collections[c])) {
        this.hashes.set(`${c}:${id}`, jsonHash(value));
      }
    }
  }

  private upsertStmts = new Map<string, Statement>();
  private removeStmts = new Map<string, Statement>();

  private upsertStmt(collection: CollectionName): Statement {
    let stmt = this.upsertStmts.get(collection);
    if (!stmt) {
      stmt = this.db.prepare(
        `INSERT OR REPLACE INTO hm_${collection}(id, hash, json) VALUES (?, ?, ?)`,
      );
      this.upsertStmts.set(collection, stmt);
    }
    return stmt;
  }

  private removeStmt(collection: CollectionName): Statement {
    let stmt = this.removeStmts.get(collection);
    if (!stmt) {
      stmt = this.db.prepare(`DELETE FROM hm_${collection} WHERE id = ?`);
      this.removeStmts.set(collection, stmt);
    }
    return stmt;
  }

  /** hash-diff 持久化：只写变更行、删消失行（同步 API，WAL 下毫秒级） */
  save(collections: GraphCollections): void {
    for (const c of COLLECTIONS) {
      const entries = Object.entries(collections[c] ?? {});
      const seen = new Set<string>();
      for (const [id, value] of entries) {
        seen.add(id);
        const key = `${c}:${id}`;
        const hash = jsonHash(value);
        if (this.hashes.get(key) === hash) continue; // 未变更行零写放大
        this.upsertStmt(c).run(id, hash, JSON.stringify(value));
        this.hashes.set(key, hash);
      }
      // 该集合中消失的 id → 删行
      for (const [key, hash] of this.hashes) {
        if (!key.startsWith(`${c}:`)) continue;
        const id = key.slice(c.length + 1);
        if (!seen.has(id)) {
          this.removeStmt(c).run(id);
          this.hashes.delete(key);
        }
      }
    }

    this.db
      .prepare(`INSERT OR REPLACE INTO hm_meta(key, value) VALUES ('version', ?)`)
      .run(String(collections.version ?? 0));
  }
}

export function resolveHumanMemoryStoreMode(): "sqlite" | "json" {
  const raw = process.env.AGENT_HUMAN_MEMORY_STORE?.trim().toLowerCase();
  return raw === "json" ? "json" : "sqlite";
}
