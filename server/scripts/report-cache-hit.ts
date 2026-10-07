/**
 * 前缀缓存命中率报表（2026-10-07）：按模型聚合 llm-token-audit.ndjson 里
 * API 真实回传的缓存命中 token（DeepSeek prompt_cache_hit_tokens / OpenAI·MiniMax
 * prompt_tokens_details.cached_tokens），给「provider 缓存黏不黏」提供持续度量，
 * 也是显式断点（explicit-breakpoint）改造前后对比的度量工具。
 *
 * 用法：npx tsx scripts/report-cache-hit.ts [--days=7] [--stage=main_chat] [--model=MiniMax]
 *   --days   只统计最近 N 天（按记录时间戳，默认 7）
 *   --stage  stage 前缀过滤（默认 main_chat，即主对话链路）
 *   --model  模型名前缀过滤（默认不过滤）
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.PA_DATA_DIR?.trim() || "data";
const daysArg = Number.parseInt(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "7", 10) || 7;
const stageArg = process.argv.find((a) => a.startsWith("--stage="))?.slice(8) ?? "main_chat";
const modelArg = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "";

const path = join(dataDir, "llm-token-audit.ndjson");
if (!existsSync(path)) {
  console.error(`audit log not found: ${path}`);
  process.exit(1);
}

const since = Date.now() - daysArg * 86_400_000;
type Rec = {
  t?: string;
  stage?: string;
  model?: string;
  sessionId?: string;
  apiPromptTokens?: number;
  promptCacheHitTokens?: number;
  apiCompletionTokens?: number;
};

const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line): Rec | null => {
    try {
      return JSON.parse(line) as Rec;
    } catch {
      return null;
    }
  })
  .filter((r): r is Rec => r !== null)
  .filter((r) => r.apiPromptTokens && r.model && r.t)
  .filter((r) => new Date(r.t as string).getTime() >= since)
  .filter((r) => (stageArg ? (r.stage ?? "").startsWith(stageArg) : true))
  .filter((r) => (modelArg ? r.model?.startsWith(modelArg) : true));

type Agg = { calls: number; prompt: number; hit: number; out: number; sessions: Set<string> };
const byModel = new Map<string, Agg>();
for (const r of rows) {
  const key = r.model as string;
  const agg = byModel.get(key) ?? { calls: 0, prompt: 0, hit: 0, out: 0, sessions: new Set<string>() };
  agg.calls += 1;
  agg.prompt += r.apiPromptTokens ?? 0;
  agg.hit += r.promptCacheHitTokens ?? 0;
  agg.out += r.apiCompletionTokens ?? 0;
  if (r.sessionId) agg.sessions.add(r.sessionId);
  byModel.set(key, agg);
}

console.log(`窗口: 最近 ${daysArg} 天 | stage 前缀: ${stageArg || "(全部)"} | 模型: ${modelArg || "(全部)"}\n`);
console.log(
  "model".padEnd(24),
  "calls".padStart(6),
  "sessions".padStart(9),
  "input".padStart(10),
  "cacheHit".padStart(10),
  "hitRate".padStart(8),
  "output".padStart(8),
);
const sorted = [...byModel.entries()].sort((a, b) => b[1].prompt - a[1].prompt);
for (const [model, a] of sorted) {
  const rate = a.prompt > 0 ? `${((100 * a.hit) / a.prompt).toFixed(1)}%` : "-";
  console.log(
    model.padEnd(24),
    String(a.calls).padStart(6),
    String(a.sessions.size).padStart(9),
    String(a.prompt).padStart(10),
    String(a.hit).padStart(10),
    rate.padStart(8),
    String(a.out).padStart(8),
  );
}
