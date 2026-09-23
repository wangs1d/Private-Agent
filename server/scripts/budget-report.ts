/**
 * 预算报表（2026-09-19 P1-2）：读 llm-token-audit.ndjson 汇总当日/会话 token
 * 消耗并与 BudgetGuard 阈值对比。与 analyze-token-audit.mjs 的差异：那个按
 * stage 占比分析，这个按 会话/用户·日 维度看"谁在花钱、离闸门多远"。
 *
 * 用法：npx tsx scripts/budget-report.ts [--days=1]
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env.PA_DATA_DIR?.trim() || "data";
const path = join(base, "llm-token-audit.ndjson");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = Math.max(1, Number.parseInt(daysArg?.slice(7) ?? "1", 10) || 1);

const SESSION_LIMIT = Number.parseInt(process.env.AGENT_LLM_BUDGET_SESSION_TOKENS ?? "", 10) || 500_000;
const DAILY_LIMIT = Number.parseInt(process.env.AGENT_LLM_BUDGET_DAILY_TOKENS ?? "", 10) || 2_000_000;

if (!existsSync(path)) {
  console.log(`审计文件不存在：${path}`);
  process.exit(0);
}

type Rec = {
  t?: string;
  sessionId?: string;
  actorId?: string;
  stage?: string;
  apiPromptTokens?: number;
  apiCompletionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

const sessionTotals = new Map<string, number>();
const dailyTotals = new Map<string, number>();
const stageTotals = new Map<string, number>();
const cutoff = Date.now() - days * 86_400_000;
let lines = 0;
let calls = 0;

for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue;
  lines += 1;
  let rec: Rec;
  try {
    rec = JSON.parse(line) as Rec;
  } catch {
    continue;
  }
  const ts = rec.t ? Date.parse(rec.t) : 0;
  if (days > 0 && ts && ts < cutoff) continue;
  const api = (rec.apiPromptTokens ?? 0) + (rec.apiCompletionTokens ?? 0);
  const tokens = api > 0 ? api : (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0);
  if (tokens <= 0) continue;
  calls += 1;
  const sessionKey = rec.sessionId?.trim() || rec.actorId?.trim() || "(unknown)";
  sessionTotals.set(sessionKey, (sessionTotals.get(sessionKey) ?? 0) + tokens);
  const day = rec.t ? rec.t.slice(0, 10) : "(unknown)";
  const actorKey = rec.actorId?.trim() || "(unknown)";
  dailyTotals.set(`${actorKey}|${day}`, (dailyTotals.get(`${actorKey}|${day}`) ?? 0) + tokens);
  stageTotals.set(rec.stage ?? "(unknown)", (stageTotals.get(rec.stage ?? "(unknown)") ?? 0) + tokens);
}

const fmt = (n: number) => n.toLocaleString("en-US");
const bar = (used: number, limit: number) => {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return `${"█".repeat(Math.round(pct / 5)).padEnd(20, "░")} ${pct}%`;
};

console.log(`\n=== 预算报表（近 ${days} 天）===`);
console.log(`阈值：会话 ${fmt(SESSION_LIMIT)} tok | 单用户·日 ${fmt(DAILY_LIMIT)} tok\n`);
console.log(`-- 按用户·日（超 80% 标记）--`);
for (const [key, used] of [...dailyTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const flag = DAILY_LIMIT > 0 && used >= DAILY_LIMIT * 0.8 ? " ⚠" : "";
  console.log(`  ${key}  ${fmt(used)} tok  ${bar(used, DAILY_LIMIT)}${flag}`);
}
console.log(`\n-- 按会话（Top 15）--`);
for (const [key, used] of [...sessionTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const flag = SESSION_LIMIT > 0 && used >= SESSION_LIMIT ? " ✖超限" : "";
  console.log(`  ${key}  ${fmt(used)} tok${flag}`);
}
console.log(`\n-- 按环节（Top 10）--`);
for (const [key, used] of [...stageTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${key}  ${fmt(used)} tok`);
}
console.log(`\n共 ${fmt(lines)} 行审计 / ${fmt(calls)} 次有效调用`);
