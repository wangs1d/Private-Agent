/**
 * 方案 B：语义账本（Agentic Ledger）。
 *
 * append-only 的事实流水：每条记录是一个「结构化断言（claim）」——谁在什么
 * 时候、从哪个来源、以多高置信度主张了什么。它是：
 *   - 方案 C 承诺草稿板的证据层（evidenceLedgerIds 指向这里）；
 *   - 方案 D 溯源作废的级联锚点（supersededBy 标记替代关系）；
 *   - 记忆冲突/演化的审计线索（Mem0 只保留最新合成结果，历史会丢）。
 *
 * 写入时机：AgenticMemoryIngestService 的 writeDecidedDetailed 落库后触发
 * writeHooks，账本从 Mem0 infer 抽取结果直接落账（claim = 抽取条目文本，
 * 复用同一次 LLM 抽取，零额外调用）。
 *
 * append-only 语义：记录一经写入不可修改内容，唯一允许的变更是
 * supersede（标记被替代/作废，写入 superseded_by / superseded_at / reason）。
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { isAgenticLedgerEnabled, getLedgerRetentionDays } from "./env.js";
import { openAgenticSqlite, fromJsonColumn, toJsonColumn } from "./sqlite-store.js";

export type LedgerSourceType =
  | "chat"
  | "notes"
  | "tool"
  | "digest"
  | "world"
  | "system"
  | "manual";

export interface LedgerRecord {
  id: string;
  actorId: string;
  /** 结构化断言（一条可判定真伪的陈述） */
  claim: string;
  /** 来源引用：与 Mem0 metadata.source 一致（如 "chat:turn-123"） */
  sourceRef: string;
  sourceType: LedgerSourceType;
  /** 置信度 0-1（Mem0 infer 无置信度输出时为 null） */
  confidence: number | null;
  /** 关联的 Mem0 记忆 id（claim 即来自该条抽取结果） */
  mem0Id: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  /** 替代者 ledger id，或作废哨兵 "void:<token>"（方案 D） */
  supersededBy: string | null;
  supersededAt: string | null;
  supersedeReason: string | null;
}

export interface LedgerAppendInput {
  actorId: string;
  claim: string;
  sourceRef: string;
  sourceType?: LedgerSourceType;
  confidence?: number | null;
  mem0Id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** 作废哨兵前缀（方案 D invalidateSource 使用） */
export const LEDGER_VOID_PREFIX = "void:";

/** sourceRef 前缀 → sourceType 推断（与认知图 inferSourceType 同族规则） */
export function inferLedgerSourceType(sourceRef: string): LedgerSourceType {
  const prefix = sourceRef.split(":")[0]?.toLowerCase() ?? "";
  switch (prefix) {
    case "chat":
      return "chat";
    case "notes":
      return "notes";
    case "tool":
      return "tool";
    case "digest":
      return "digest";
    case "world":
      return "world";
    case "system":
      return "system";
    case "manual":
      return "manual";
    default:
      return "chat";
  }
}

interface LedgerRow {
  id: string;
  actor_id: string;
  claim: string;
  source_ref: string;
  source_type: string;
  confidence: number | null;
  mem0_id: string | null;
  metadata: string | null;
  created_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
  supersede_reason: string | null;
}

function toRecord(row: LedgerRow): LedgerRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    claim: row.claim,
    sourceRef: row.source_ref,
    sourceType: row.source_type as LedgerSourceType,
    confidence: row.confidence,
    mem0Id: row.mem0_id,
    metadata: fromJsonColumn<Record<string, unknown> | null>(row.metadata, null),
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    supersedeReason: row.supersede_reason,
  };
}

let idSeq = 0;

function nextLedgerId(): string {
  idSeq = (idSeq + 1) % 100000;
  return `led_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

export class AgenticLedger {
  private readonly db: SqliteDatabase;

  constructor(db?: SqliteDatabase) {
    this.db = db ?? openAgenticSqlite();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_records (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_type TEXT NOT NULL,
        confidence REAL,
        mem0_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        superseded_by TEXT,
        superseded_at TEXT,
        supersede_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_source ON ledger_records(source_ref);
      CREATE INDEX IF NOT EXISTS idx_ledger_actor_active
        ON ledger_records(actor_id, superseded_by);
      CREATE INDEX IF NOT EXISTS idx_ledger_mem0 ON ledger_records(mem0_id);
    `);
    this.ensureFts();
  }

  /**
   * FTS5 全文索引（P1-10）：searchByClaim 的 LIKE '%kw%' 是全表扫描，
   * 量级上来后换 FTS5（better-sqlite3 默认编译包含）。建表失败（裁剪版
   * SQLite 无 FTS5）静默降级回 LIKE。
   */
  private ftsAvailable = false;

  private ensureFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts
        USING fts5(claim, ledger_id UNINDEXED, actor_id UNINDEXED);
      `);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  private ftsInsert(id: string, actorId: string, claim: string): void {
    if (!this.ftsAvailable) return;
    try {
      this.db
        .prepare(`INSERT INTO ledger_fts(claim, ledger_id, actor_id) VALUES (?, ?, ?)`)
        .run(claim, id, actorId);
    } catch {
      /* 索引失败不影响主写入 */
    }
  }

  private ftsRemove(id: string): void {
    if (!this.ftsAvailable) return;
    try {
      this.db.prepare(`DELETE FROM ledger_fts WHERE ledger_id = ?`).run(id);
    } catch {
      /* 忽略 */
    }
  }

  close(): void {
    this.db.close();
  }

  /** 追加断言（append-only 入口）。claim 为空或 actor 缺失时静默跳过返回 null。 */
  append(input: LedgerAppendInput): LedgerRecord | null {
    const claim = input.claim.trim();
    if (!claim || !input.actorId) return null;

    const record: LedgerRecord = {
      id: nextLedgerId(),
      actorId: input.actorId,
      claim,
      sourceRef: input.sourceRef,
      sourceType: input.sourceType ?? inferLedgerSourceType(input.sourceRef),
      confidence:
        typeof input.confidence === "number" && Number.isFinite(input.confidence)
          ? Math.max(0, Math.min(1, input.confidence))
          : null,
      mem0Id: input.mem0Id ?? null,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString(),
      supersededBy: null,
      supersededAt: null,
      supersedeReason: null,
    };

    this.db
      .prepare(
        `INSERT INTO ledger_records
           (id, actor_id, claim, source_ref, source_type, confidence, mem0_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.actorId,
        record.claim,
        record.sourceRef,
        record.sourceType,
        record.confidence,
        record.mem0Id,
        toJsonColumn(record.metadata),
        record.createdAt,
      );
    this.ftsInsert(record.id, record.actorId, record.claim);
    return record;
  }

  appendBatch(inputs: LedgerAppendInput[]): LedgerRecord[] {
    const out: LedgerRecord[] = [];
    for (const input of inputs) {
      const rec = this.append(input);
      if (rec) out.push(rec);
    }
    return out;
  }

  getById(id: string): LedgerRecord | null {
    const row = this.db.prepare(`SELECT * FROM ledger_records WHERE id = ?`).get(id) as
      | LedgerRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  /** 按来源引用查全部断言（默认仅未被替代的） */
  listBySource(sourceRef: string, opts?: { includeSuperseded?: boolean }): LedgerRecord[] {
    const sql = opts?.includeSuperseded
      ? `SELECT * FROM ledger_records WHERE source_ref = ? ORDER BY created_at ASC, id ASC`
      : `SELECT * FROM ledger_records WHERE source_ref = ? AND superseded_by IS NULL
         ORDER BY created_at ASC, id ASC`;
    const rows = this.db.prepare(sql).all(sourceRef) as LedgerRow[];
    return rows.map(toRecord);
  }

  /** 某 actor 的活跃断言（方案 C 确认对话、调试排查用） */
  listActiveByActor(actorId: string, limit = 100): LedgerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger_records WHERE actor_id = ? AND superseded_by IS NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(actorId, limit) as LedgerRow[];
    return rows.map(toRecord);
  }

  /**
   * 按 claim 关键词查询（跨来源找相近断言）。
   * FTS5 可用时走 MATCH（倒排索引），中文按 token 命中；不可用/零命中时回退 LIKE。
   */
  searchByClaim(actorId: string, keyword: string, limit = 20): LedgerRecord[] {
    const kw = keyword.trim();
    if (!kw) return [];
    if (this.ftsAvailable) {
      try {
        const tokens = kw.split(/\s+/).filter(Boolean);
        const match = tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
        const rows = this.db
          .prepare(
            `SELECT r.* FROM ledger_fts f
             JOIN ledger_records r ON r.id = f.ledger_id
             WHERE ledger_fts MATCH ? AND r.actor_id = ? AND r.superseded_by IS NULL
             ORDER BY rank LIMIT ?`,
          )
          .all(match, actorId, limit) as LedgerRow[];
        if (rows.length > 0) return rows.map(toRecord);
      } catch {
        /* MATCH 语法问题等 → 回退 LIKE */
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger_records
         WHERE actor_id = ? AND superseded_by IS NULL AND claim LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(actorId, `%${kw}%`, limit) as LedgerRow[];
    return rows.map(toRecord);
  }

  /**
   * 纠正匹配（统一抽取的 corrections 用）：找与新文本语义相对的活跃断言——
   * 旧 claim 是新文本的前缀子串，或新文本包含旧 claim。
   */
  findActiveClaimsByText(actorId: string, text: string, limit = 5): LedgerRecord[] {
    const t = text.trim();
    if (!t) return [];
    const probe = `%${t.slice(0, 24)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger_records
         WHERE actor_id = ? AND superseded_by IS NULL AND length(claim) >= 8
           AND (claim LIKE ? OR instr(?, claim) > 0)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(actorId, probe, t, limit) as LedgerRow[];
    return rows.map(toRecord);
  }

  /**
   * 标记单条断言被替代/作废（append-only 的唯一变更路径）。
   * 已被替代的记录不可再次替代（保留首次替代关系）。
   */
  supersede(id: string, supersededBy: string, reason?: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE ledger_records
         SET superseded_by = ?, superseded_at = ?, supersede_reason = ?
         WHERE id = ? AND superseded_by IS NULL`,
      )
      .run(supersededBy, new Date().toISOString(), reason ?? null, id);
    return res.changes > 0;
  }

  /** 按来源整体作废（方案 D 级联）：sourceRef 下所有活跃断言标记 supersededBy=void 标记 */
  supersedeBySource(sourceRef: string, voidToken: string, reason?: string): number {
    const res = this.db
      .prepare(
        `UPDATE ledger_records
         SET superseded_by = ?, superseded_at = ?, supersede_reason = ?
         WHERE source_ref = ? AND superseded_by IS NULL`,
      )
      .run(voidToken, new Date().toISOString(), reason ?? null, sourceRef);
    return res.changes;
  }

  stats(): { total: number; active: number; superseded: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END) AS active
         FROM ledger_records`,
      )
      .get() as { total: number; active: number | null };
    const total = row.total;
    const active = row.active ?? 0;
    return { total, active, superseded: total - active };
  }

  /** actor 级清理（memory-clear-service 级联调用，隐私闭环） */
  purgeActor(actorId: string): number {
    if (this.ftsAvailable) {
      try {
        this.db.prepare(`DELETE FROM ledger_fts WHERE actor_id = ?`).run(actorId);
      } catch {
        /* 忽略 */
      }
    }
    const res = this.db.prepare(`DELETE FROM ledger_records WHERE actor_id = ?`).run(actorId);
    return res.changes;
  }

  /**
   * 保留策略（P1-10）：被替代/作废超过 retentionDays 的记录物理删除——
   * append-only 的审计价值随时间衰减，到期让位给存储成本。
   * retentionDays <= 0 时为 no-op。返回删除条数。
   */
  pruneSuperseded(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const expired = this.db
      .prepare(
        `SELECT id FROM ledger_records WHERE superseded_by IS NOT NULL AND superseded_at < ?`,
      )
      .all(cutoff) as Array<{ id: string }>;
    if (expired.length === 0) return 0;
    for (const { id } of expired) this.ftsRemove(id);
    const res = this.db
      .prepare(`DELETE FROM ledger_records WHERE id IN (${expired.map(() => "?").join(",")})`)
      .run(...expired.map((e) => e.id));
    return res.changes;
  }
}

export function createAgenticLedgerIfEnabled(db?: SqliteDatabase): AgenticLedger | null {
  if (!isAgenticLedgerEnabled()) return null;
  const ledger = new AgenticLedger(db);
  // 保留策略定时器（每 24h 一轮；0=关闭）
  const retentionDays = getLedgerRetentionDays();
  if (retentionDays > 0) {
    const timer = setInterval(() => {
      try {
        const pruned = ledger.pruneSuperseded(retentionDays);
        if (pruned > 0) console.info(`[agentic-ledger] 保留策略清理 ${pruned} 条过期断言（>${retentionDays}d）`);
      } catch (err) {
        console.warn("[agentic-ledger] 保留策略清理失败（忽略）:", err);
      }
    }, 24 * 3_600_000);
    timer.unref();
  }
  return ledger;
}
