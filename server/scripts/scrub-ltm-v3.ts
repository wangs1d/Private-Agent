/**
 * 存量长期记忆清洗（记忆架构 v3 · Phase 1b）
 *
 * 对三个长期库跑一遍 ltm-write-gate，把 v2 时代漏进来的化石清掉：
 *   1. Mem0 vectors.db（data/agentic_memory/vectors.db）——payload.data 逐条过门，
 *      拒绝即删行；同步清 FTS（若 fts-store 与 vectors 同库或独立库均处理）。
 *   2. 叙事库 data/narrative-memory.sqlite——text 逐条过门，拒绝即删行。
 *   3. KV data/agent-memory-sync.json——memory_summary / memory_summary_forgotten /
 *      session_recap 逐行过门，拒绝行剔除后原子写回（保留 .bak 备份）。
 *
 * 必须在服务停止后运行（避免运行中的服务把内存态 KV 写回覆盖清洗结果）。
 * 运行：cd server && npx tsx scripts/scrub-ltm-v3.ts [--dry]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { gateLtmWrite } from "../src/agentic-memory/ltm-write-gate.js";

const DRY = process.argv.includes("--dry");
const ROOT = process.cwd();
const VECTORS_DB = join(ROOT, "data", "agentic_memory", "vectors.db");
const NARRATIVE_DB = join(ROOT, "data", "narrative-memory.sqlite");
const SYNC_JSON = join(ROOT, "data", "agent-memory-sync.json");

let totalScanned = 0;
let totalRemoved = 0;

function payloadText(payloadRaw: unknown): string {
  try {
    const p = JSON.parse(String(payloadRaw));
    return String(p.data ?? "");
  } catch {
    return "";
  }
}

// ---- 1. Mem0 vectors.db ----
console.log("=== Mem0 vectors.db ===");
{
  const db = new Database(VECTORS_DB);
  const rows = db.prepare("SELECT id, payload FROM vectors").all() as Array<{ id: string; payload: string }>;
  const del = db.prepare("DELETE FROM vectors WHERE id = ?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      totalScanned++;
      const text = payloadText(row.payload);
      const verdict = gateLtmWrite(text, "scrub:mem0");
      if (!verdict.admit) {
        totalRemoved++;
        console.log(`  [-] (${verdict.reason}) ${text.slice(0, 70)}`);
        if (!DRY) del.run(row.id);
      }
    }
  });
  tx();
  const left = db.prepare("SELECT COUNT(*) c FROM vectors").get() as { c: number };
  console.log(`scanned=${rows.length} removed=${DRY ? "(dry)" : totalRemoved} remaining=${left.c}`);
  db.close();
}

// ---- 2. FTS 索引同步（mem_fts 索引 Mem0 记忆，主库删行后索引残留会继续召回已删内容）----
console.log("=== mem_fts (agentic-memory.db) ===");
{
  try {
    const vdb = new Database(VECTORS_DB, { readonly: true });
    const liveIds = new Set(
      (vdb.prepare("SELECT id FROM vectors").all() as Array<{ id: string }>).map((r) => r.id),
    );
    vdb.close();
    const db = new Database(join(ROOT, "data", "agentic_memory", "agentic-memory.db"));
    const rows = db.prepare("SELECT rowid, memory_id, content FROM mem_fts").all() as Array<{
      rowid: number;
      memory_id: string;
      content: string;
    }>;
    const del = db.prepare("DELETE FROM mem_fts WHERE rowid = ?");
    let removedFts = 0;
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!liveIds.has(row.memory_id)) {
          removedFts++;
          totalRemoved++;
          if (!DRY) del.run(row.rowid);
        }
      }
    });
    tx();
    const left = db.prepare("SELECT count(*) AS n FROM mem_fts").get() as { n: number };
    console.log(`scanned=${rows.length} removed=${removedFts}${DRY ? " (dry)" : ""} remaining=${left.n}`);
    db.close();
  } catch (err) {
    console.log(`  (FTS 清理跳过: ${err instanceof Error ? err.message : err})`);
  }
}

// ---- 3. 叙事库 ----
console.log("=== narrative-memory.sqlite ===");
{
  let removedN = 0;
  const db = new Database(NARRATIVE_DB);
  const rows = db.prepare("SELECT rowid, text FROM narrative_points").all() as Array<{ rowid: number; text: string }>;
  const del = db.prepare("DELETE FROM narrative_points WHERE rowid = ?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      totalScanned++;
      const verdict = gateLtmWrite(row.text, "scrub:narrative");
      if (!verdict.admit) {
        totalRemoved++;
        removedN++;
        console.log(`  [-] (${verdict.reason}) ${row.text.slice(0, 70)}`);
        if (!DRY) del.run(row.rowid);
      }
    }
  });
  tx();
  const left = db.prepare("SELECT COUNT(*) c FROM narrative_points").get() as { c: number };
  console.log(`scanned=${rows.length} removed=${removedN}${DRY ? " (dry)" : ""} remaining=${left.c}`);
  db.close();
}

// ---- 3. KV memory fields ----
console.log("=== agent-memory-sync.json (KV) ===");
{
  if (!existsSync(SYNC_JSON)) {
    console.log("  (file not found, skip)");
  } else {
    const raw = readFileSync(SYNC_JSON, "utf8");
    const data = JSON.parse(raw) as {
      sessions?: Record<string, { revision?: number; entries?: Record<string, unknown> }>;
    };
    const KV_KEYS = ["memory_summary", "memory_summary_forgotten", "session_recap"];
    // 槽位字段：画像/承诺/待办——逐行过门后，profile 槽位额外要求第一人称陈述
    // （"我喜欢/我住在…"），对话回执类化石（"[Agent 承诺/结论] 大哥，这题我会…"）一并清出
    const PROFILE_SLOT_KEYS = new Set(["memory_facts", "memory_preferences"]);
    const SLOT_KEYS = ["memory_commitments", "memory_open_loops"];
    const stripStamp = (line: string) =>
      line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\]\s*/, "").replace(/^\[\d{2}:\d{2}\]\s*/, "");
    const scrubLine = (line: string, key: string): boolean => {
      const verdict = gateLtmWrite(line, `scrub:kv:${key}`);
      if (!verdict.admit) return false;
      if (PROFILE_SLOT_KEYS.has(key)) {
        const body = stripStamp(verdict.cleaned);
        if (!/^(?:我|用户)/.test(body)) return false;
      }
      return true;
    };
    let removedKv = 0;
    for (const [actorId, session] of Object.entries(data.sessions ?? {})) {
      const entries = session.entries ?? {};
      for (const key of [...KV_KEYS, ...SLOT_KEYS, ...PROFILE_SLOT_KEYS]) {
        const value = entries[key];
        if (typeof value !== "string" || !value) continue;
        const lines = value.split("\n").filter((l) => l.trim());
        const kept = lines.filter((line) => {
          const ok = scrubLine(line, key);
          if (!ok) {
            removedKv++;
            totalRemoved++;
            if (actorId === "session-mvp-001") {
              console.log(`  [-] [${actorId}/${key}] ${line.slice(0, 70)}`);
            }
          }
          return ok;
        });
        if (kept.length !== lines.length) entries[key] = kept.join("\n");
      }
    }
    console.log(`kv lines removed=${removedKv}${DRY ? " (dry)" : ""}`);
    if (!DRY && removedKv > 0) {
      copyFileSync(SYNC_JSON, `${SYNC_JSON}.bak-pre-scrub-v3`);
      writeFileSync(SYNC_JSON, `${JSON.stringify(data, null, 1)}\n`, "utf8");
      console.log("  KV 写回完成（备份 .bak-pre-scrub-v3）");
    }
  }
}

console.log(`\nTOTAL: scanned=${totalScanned} removed=${totalRemoved}${DRY ? " (DRY RUN, 未写盘)" : ""}`);
