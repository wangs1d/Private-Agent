/**
 * 一次性存量清洗（2026-09-24 僵尸承诺治理，跑前须停服）：
 * 1. chat-threads.json：把「已由任务承接的提醒类轮次」从 session-recap 摘要区/关键钉区抹掉
 *    （任务库自有记录；9/12 那条还带着 taskId 僵尸钉，只增不改永不过期）。
 * 2. agent-memory-sync.json：memory_commitments / memory_open_loops 里超 72h 未闭环的
 *    旧承诺行清掉（与线上一致：dropExpiredCommitmentLines，TTL 同源）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AgentMemorySyncService } from "../server/src/services/agent-memory-sync-service.js";
import { dropExpiredCommitmentLines } from "../server/src/services/memory-record-utils.js";

const ROOT = "E:/ws-project/Private-Agent";
const RECAP_LINE_PATTERNS = [/用户要求8分钟后喊睡觉/, /用户提出提前五分钟再提醒一次/, /用户要求10分钟后提醒睡觉/];

// ── 1. chat-threads.json ──
const threadsPath = `${ROOT}/server/data/chat-threads.json`;
const threads = JSON.parse(readFileSync(threadsPath, "utf8"));
let recapLinesRemoved = 0;
for (const session of Object.values(threads.sessions ?? {})) {
  for (const msg of session.messages ?? []) {
    if (typeof msg.content !== "string" || !msg.content.includes("[session-recap]")) continue;
    const lines = msg.content.split("\n");
    const kept = lines.filter((line) => {
      if (!line.startsWith("- ")) return true;
      const hit = RECAP_LINE_PATTERNS.some((re) => re.test(line));
      if (hit) recapLinesRemoved += 1;
      return !hit;
    });
    if (kept.length !== lines.length) msg.content = kept.join("\n");
  }
}
writeFileSync(threadsPath, `${JSON.stringify(threads, null, 2)}\n`, "utf8");
console.log(`[chat-threads] removed recap lines: ${recapLinesRemoved}`);

// ── 2. agent-memory-sync.json（走 service 自身的原子写盘，保证格式与线上同源）──
const sync = new AgentMemorySyncService(`${ROOT}/server/data/agent-memory-sync.json`);
await sync.load();
let slotsScrubbed = 0;
for (const sessionId of sync.listSessionIds()) {
  const { revision, entries } = sync.getSnapshot(sessionId, ["memory_commitments", "memory_open_loops"]);
  const patches = [];
  for (const key of ["memory_commitments", "memory_open_loops"]) {
    if (typeof entries[key] !== "string") continue;
    const lines = entries[key].split("\n").filter(Boolean);
    const kept = dropExpiredCommitmentLines(lines);
    if (kept.length !== lines.length) {
      slotsScrubbed += 1;
      patches.push({ key, op: "put", value: kept.join("\n") });
    }
  }
  if (patches.length) await sync.applyPatch(sessionId, revision, patches);
}
console.log(`[memory-sync] scrubbed slots: ${slotsScrubbed}`);
