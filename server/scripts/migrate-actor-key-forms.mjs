/**
 * 一次性存量迁移（2026-10-04 actor 形式归一，配 src/agentic-memory/actor-key.ts 根修）。
 *
 * 背景：旧 journal 目录净化规则把 @ 换成 _，夜间固化链拿目录名当 actorId，
 * 把下划线形式（如 2378709729_qq.com）写穿了 ledger/provenance/bridge/
 * mem0/sync/awareness/shadow 等记忆库。代码侧已改为「写边界保留 @、删/扫边界
 * 双形式兼容」；本脚本把存量下划线形式统一回 @ 权威形式。
 *
 * 规则：仅匹配 <local>_qq.com 形式（真实账号），探针/bench 等含 _ 的 id 不动。
 * 幂等：全部操作按「下划线形式仍存在」判定，可重复执行；动库前先做 online backup。
 * 用法：node scripts/migrate-actor-key-forms.mjs [--dry]   （在 server/ 目录下执行）
 */
import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DRY = process.argv.includes("--dry");
const DATA_DIR = resolve(process.cwd(), "data");
const STAMP = "actor-key-20261004";

/** <local>_qq.com → <local>@qq.com；其余 actor 一律不动 */
function canonical(actorId) {
  const m = /^(\S+)_qq\.com$/.exec(String(actorId ?? "").trim());
  return m ? `${m[1]}@qq.com` : null;
}
function underscoreForm(actorId) {
  const m = /^(\S+)@qq\.com$/.exec(String(actorId ?? "").trim());
  return m ? `${m[1]}_qq.com` : null;
}

function bak(file) {
  const dest = `${file}.bak-${STAMP}`;
  if (!existsSync(dest)) cpSync(file, dest);
}

let counts = {};
function tally(k, n = 1) {
  counts[k] = (counts[k] ?? 0) + n;
}

// ─── 1. SQLite（online backup 后原地迁移；WAL 下与运行实例并存） ───
const dbPath = join(DATA_DIR, "agentic_memory", "agentic-memory.db");
if (existsSync(dbPath)) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 8000");
  if (!DRY) {
    const backupPath = join(DATA_DIR, "agentic_memory", `agentic-memory.backup-${STAMP}.db`);
    if (!existsSync(backupPath)) await db.backup(backupPath);
    console.log(`[backup] ${backupPath}`);
  }

  const ledgerUnderscore = db
    .prepare(`SELECT id, actor_id, claim, superseded_by FROM ledger_records WHERE actor_id LIKE '%\\_qq.com' ESCAPE '\\'`)
    .all();
  for (const row of ledgerUnderscore) {
    const target = canonical(row.actor_id);
    if (!target) continue;
    const referenced = db
      .prepare(`SELECT 1 FROM ledger_records WHERE superseded_by = ? LIMIT 1`)
      .get(row.id);
    const activeDupAtTarget = db
      .prepare(
        `SELECT 1 FROM ledger_records WHERE claim = ? AND actor_id = ? AND id != ? AND superseded_by IS NULL LIMIT 1`,
      )
      .get(row.claim, target, row.id);
    if (activeDupAtTarget && !referenced && !row.superseded_by) {
      // @ 形式已有同 claim 的现行行 → 下划线副本是双写残留，删除
      if (!DRY) {
        db.prepare(`DELETE FROM ledger_records WHERE id = ?`).run(row.id);
        db.prepare(`DELETE FROM ledger_fts WHERE ledger_id = ?`).run(row.id);
      }
      tally("ledger.dedup-deleted");
    } else {
      if (!DRY) {
        db.prepare(`UPDATE ledger_records SET actor_id = ? WHERE id = ?`).run(target, row.id);
        db.prepare(`UPDATE ledger_fts SET actor_id = ? WHERE ledger_id = ?`).run(target, row.id);
      }
      tally("ledger.updated");
    }
  }

  // 整表直线 UPDATE（无 PK 冲突风险：主键均非 actor_id）
  for (const [table, key] of [
    ["provenance_edges", "provenance"],
    ["bridge_links", "bridge"],
    ["mem_fts", "memfts"],
  ]) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT actor_id FROM ${table} WHERE actor_id LIKE '%\\_qq.com' ESCAPE '\\'`)
        .all();
      for (const r of rows) {
        const target = canonical(r.actor_id);
        if (!target) continue;
        if (!DRY) db.prepare(`UPDATE ${table} SET actor_id = ? WHERE actor_id = ?`).run(target, r.actor_id);
        tally(`${key}.updated`);
      }
    } catch (e) {
      console.warn(`[warn] ${table}: ${e.message}`);
    }
  }

  // memory_reinforcement：PK(mem0_id) → @ 形式已有同 mem0_id 行则删下划线行
  try {
    const rows = db
      .prepare(`SELECT mem0_id, actor_id FROM memory_reinforcement WHERE actor_id LIKE '%\\_qq.com' ESCAPE '\\'`)
      .all();
    for (const r of rows) {
      const target = canonical(r.actor_id);
      if (!target) continue;
      const dup = db
        .prepare(`SELECT 1 FROM memory_reinforcement WHERE mem0_id = ? AND actor_id = ? LIMIT 1`)
        .get(r.mem0_id, target);
      if (!DRY) {
        if (dup) db.prepare(`DELETE FROM memory_reinforcement WHERE mem0_id = ? AND actor_id = ?`).run(r.mem0_id, r.actor_id);
        else db.prepare(`UPDATE memory_reinforcement SET actor_id = ? WHERE mem0_id = ? AND actor_id = ?`).run(target, r.mem0_id, r.actor_id);
      }
      tally(dup ? "reinforcement.dedup-deleted" : "reinforcement.updated");
    }
  } catch (e) {
    console.warn(`[warn] memory_reinforcement: ${e.message}`);
  }
  db.close();
} else {
  console.log(`[skip] ${dbPath} 不存在`);
}

// ─── 2. journal 目录改名（新净化规则保留 @，目录名即 actorId） ───
const journalDir = join(DATA_DIR, "journal");
if (existsSync(journalDir)) {
  for (const name of readdirSync(journalDir)) {
    const target = canonical(name);
    if (!target) continue;
    const from = join(journalDir, name);
    const to = join(journalDir, target);
    if (!existsSync(to)) {
      if (!DRY) renameSync(from, to);
      tally("journal-dir.renamed");
    } else {
      tally("journal-dir.conflict-skipped");
    }
  }
}

// ─── 3. 单文件 actor 键改名（rhythm_profiles / long-term-memory） ───
for (const sub of ["rhythm_profiles"]) {
  const dir = join(DATA_DIR, sub);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const m = /^(\S+)_qq\.com\.json(\.bak)?$/.exec(name);
    if (!m) continue;
    const to = join(dir, `${m[1]}@qq.com.json${m[2] ?? ""}`);
    if (!existsSync(to)) {
      if (!DRY) renameSync(join(dir, name), to);
      tally(`${sub}.renamed`);
    } else {
      tally(`${sub}.conflict-skipped`);
    }
  }
}
// long-term-memory：@ 与下划线两份图并存，合并有风险——跳过，
// 清空记忆的 variants 路径已覆盖其隐私闭环，下划线图自此不再增长。
console.log("[note] long-term-memory 双图并存，跳过合并（清空已双形式覆盖）");

// ─── 4. JSON 内部键/字段改写（agent-memory-sync / awareness / nightly-shadow） ───
function rewriteJsonKeys(file, mapKeys) {
  if (!existsSync(file)) return;
  const json = JSON.parse(readFileSync(file, "utf8"));
  let changed = 0;
  const next = mapKeys(json, () => changed++);
  if (!DRY && changed > 0) {
    bak(file);
    writeFileSync(file, JSON.stringify(next, null, 2));
  }
  if (changed > 0) tally(`json.${file.split(/[\\/]/).pop()}.rewritten`, changed);
}

rewriteJsonKeys(join(DATA_DIR, "agent-memory-sync.json"), (json, bump) => {
  const sessions = json.sessions ?? {};
  for (const key of Object.keys(sessions)) {
    const target = canonical(key);
    if (!target) continue;
    if (!sessions[target]) {
      sessions[target] = sessions[key];
      delete sessions[key];
      bump();
    } else {
      tally("json.sync.conflict-skipped");
    }
  }
  return json;
});
rewriteJsonKeys(join(DATA_DIR, "proactivity", "awareness-sleep-samples.json"), (json, bump) => {
  const actors = json.actors ?? {};
  for (const key of Object.keys(actors)) {
    const target = canonical(key);
    if (!target) continue;
    if (!actors[target]) {
      actors[target] = actors[key];
      delete actors[key];
      bump();
    } else {
      tally("json.awareness.conflict-skipped");
    }
  }
  return json;
});
rewriteJsonKeys(join(DATA_DIR, "nightly-unified-shadow.json"), (json, bump) => {
  for (const row of json.rows ?? []) {
    const target = canonical(row.actorId);
    if (target && row.actorId !== target) {
      row.actorId = target;
      bump();
    }
  }
  return json;
});

console.log(DRY ? "[dry-run] 未写任何文件/库" : "[done] 迁移完成");
console.log(counts);
