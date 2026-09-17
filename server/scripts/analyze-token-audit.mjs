#!/usr/bin/env node
/**
 * token 审计聚合分析（WP0 测量基线，2026-09-17 建）。
 *
 * 读 data/llm-token-audit.ndjson（llm-token-audit.ts 落盘），按 stage 聚合
 * 估算/真实 token 与占比；对 `tool_result_compaction` stage 额外按工具名输出
 * 压缩前/后字符与节省率，用于量化「工具结果压缩」这条省 token 主干道的收益。
 *
 * 用法：
 *   node scripts/analyze-token-audit.mjs
 *   node scripts/analyze-token-audit.mjs --since 2026-09-01 --until 2026-09-17
 *   node scripts/analyze-token-audit.mjs --top 15 --dir /path/to/data
 *
 * 输出纯只读，不写任何文件。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

const DATA_DIR = arg("dir", process.env.PA_DATA_DIR?.trim() || "data");
const TOP = Math.max(1, Number(arg("top", "20")));
const SINCE = arg("since", "");
const UNTIL = arg("until", "");
const sinceMs = SINCE ? Date.parse(SINCE) : NaN;
const untilMs = UNTIL ? Date.parse(UNTIL) : NaN;

const path = join(DATA_DIR, "llm-token-audit.ndjson");
if (!existsSync(path)) {
  console.error(`[analyze-token-audit] 审计文件不存在: ${path}`);
  process.exit(1);
}

const fmtInt = (n) => Math.round(n).toLocaleString("en-US");

// ── 聚合 ──
const byStage = new Map(); // stage -> agg
const byTool = new Map(); // toolName -> {calls, rawChars, compactChars}
let total = 0;
let skipped = 0;

for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    skipped++;
    continue;
  }
  if (!rec || typeof rec !== "object" || !rec.stage) continue;
  if (Number.isFinite(sinceMs) && rec.t && Date.parse(rec.t) < sinceMs) continue;
  if (Number.isFinite(untilMs) && rec.t && Date.parse(rec.t) > untilMs) continue;

  const inTok = rec.inputTokens ?? 0;
  const outTok = rec.outputTokens ?? 0;
  const apiIn = rec.apiPromptTokens ?? 0;
  const apiOut = rec.apiCompletionTokens ?? 0;
  const cacheHit = rec.promptCacheHitTokens ?? 0;

  let agg = byStage.get(rec.stage);
  if (!agg) {
    agg = {
      calls: 0,
      inTok: 0,
      outTok: 0,
      apiIn: 0,
      apiOut: 0,
      cacheHit: 0,
      apiCalls: 0,
      inputChars: 0,
    };
    byStage.set(rec.stage, agg);
  }
  agg.calls += 1;
  agg.inTok += inTok;
  agg.outTok += outTok;
  agg.apiIn += apiIn;
  agg.apiOut += apiOut;
  agg.cacheHit += cacheHit;
  agg.inputChars += rec.inputChars ?? 0;
  if (apiIn > 0 || apiOut > 0) agg.apiCalls += 1;
  total += inTok + outTok;

  if (rec.stage === "tool_result_compaction" && rec.toolName) {
    let t = byTool.get(rec.toolName);
    if (!t) {
      t = { calls: 0, rawChars: 0, compactChars: 0 };
      byTool.set(rec.toolName, t);
    }
    t.calls += 1;
    // 复用 inputChars=压缩前 / outputChars=压缩后（recordToolCompactionByChars 约定）
    t.rawChars += rec.inputChars ?? 0;
    t.compactChars += rec.outputChars ?? 0;
  }
}

// ── stage 表 ──
const rows = [...byStage.entries()].map(([stage, a]) => ({
  stage,
  ...a,
  estTotal: a.inTok + a.outTok,
  apiTotal: a.apiIn + a.apiOut,
}));
rows.sort((a, b) => b.estTotal - a.estTotal);

console.log(`# token 审计分析  ${path}`);
if (SINCE || UNTIL) console.log(`# 窗口: ${SINCE || "起"} ~ ${UNTIL || "今"}`);
console.log(
  `# 记录聚合完成${skipped ? `（跳过损坏行 ${skipped}）` : ""}，估算 token 总量 ${fmtInt(total)}\n`,
);
console.log(
  "est_total     pct   calls    est_in    est_out |   api_in   api_out  cache_hit  stage",
);
console.log("-".repeat(100));
let shown = 0;
for (const r of rows) {
  if (shown++ >= TOP) break;
  const pct = total > 0 ? ((r.estTotal / total) * 100).toFixed(1) + "%" : "-";
  console.log(
    fmtInt(r.estTotal).padStart(10) +
      String(pct).padStart(7) +
      String(r.calls).padStart(8) +
      fmtInt(r.inTok).padStart(11) +
      fmtInt(r.outTok).padStart(11) +
      " |" +
      fmtInt(r.apiIn).padStart(10) +
      fmtInt(r.apiOut).padStart(10) +
      fmtInt(r.cacheHit).padStart(11) +
      "  " +
      r.stage,
  );
}

// ── 工具压缩节省表 ──
if (byTool.size > 0) {
  const toolRows = [...byTool.entries()]
    .map(([name, t]) => ({ name, ...t, saved: t.rawChars - t.compactChars }))
    .sort((a, b) => b.saved - a.saved);
  const totRaw = toolRows.reduce((s, r) => s + r.rawChars, 0);
  const totCmp = toolRows.reduce((s, r) => s + r.compactChars, 0);
  console.log(`\n# 工具结果压缩明细（tool_result_compaction，共 ${toolRows.length} 个工具）`);
  console.log("raw_chars  compact_chars    saved  save%   calls  tool");
  console.log("-".repeat(80));
  for (const r of toolRows.slice(0, TOP)) {
    const pct = r.rawChars > 0 ? ((r.saved / r.rawChars) * 100).toFixed(1) + "%" : "-";
    console.log(
      fmtInt(r.rawChars).padStart(11) +
        fmtInt(r.compactChars).padStart(15) +
        fmtInt(r.saved).padStart(9) +
        String(pct).padStart(8) +
        String(r.calls).padStart(8) +
        "  " +
        r.name,
    );
  }
  const savedAll = totRaw - totCmp;
  console.log("-".repeat(80));
  console.log(
    `合计 raw=${fmtInt(totRaw)} compact=${fmtInt(totCmp)} saved=${fmtInt(savedAll)}` +
      (totRaw > 0 ? ` (${((savedAll / totRaw) * 100).toFixed(1)}%)` : ""),
  );
} else {
  console.log(
    "\n# 无 tool_result_compaction 记录（旧版本审计文件，或本轮会话尚无工具压缩打点）",
  );
}
