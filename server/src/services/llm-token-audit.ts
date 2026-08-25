import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * LLM token 用量审计。
 *
 * 在统一的 LLM 推理入口打点，按「环节」（stage）聚合输入/输出 token 估算，
 * 用于量化一次对话的 token 消耗分布，找出占比最大的环节。
 * - 输出：内存聚合快照 + 落盘 NDJSON（data/llm-token-audit.ndjson），零性能影响（纯估算、异步写盘）
 * - 估算公式与 chat-thread-store 保持一致：中文按 1.5 token/字，英文按 0.25 token/词
 */

export type LlmAuditStage =
  /** 主对话回复（非工具分支，单次请求） */
  | "main_chat"
  /** 主对话工具循环（每次 LLM round 记一条） */
  | "main_chat_tools"
  /** 情绪推断（每轮用户消息异步触发一次） */
  | "mood_inference"
  /** 记忆写决策（启发式不置信时兜底调用 LLM） */
  | "memory_write_decision"
  /** 低信号记忆批次摘要（flush 时） */
  | "memory_flush_summarize"
  /** 记忆召回结果压缩（超阈值时） */
  | "recall_compress"
  /** 对话滚动摘要 / recap 增强（历史被 trim 丢弃时） */
  | "rolling_summary"
  /** 用户画像深度合成 */
  | "user_profile_aggregate"
  /** 用户兴趣识别 / 监控 */
  | "interest_watch"
  /** 主动意图生成（ProactivityHub） */
  | "proactive_intent"
  /** 自我进化 / 自动能力迭代 */
  | "self_evolution"
  /** 代码修复 */
  | "code_repair"
  /** 其他（外部科技扫描等低频旁路） */
  | "other";

export type LlmUsageRecord = {
  t: string;
  actorId?: string;
  sessionId?: string;
  stage: LlmAuditStage;
  model?: string;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
};

export type LlmUsageAggregate = {
  calls: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** 简短环境信息，便于区分不同部署实例 */
function auditLogPath(): string {
  const base = process.env.PA_DATA_DIR?.trim() || "data";
  return join(base, "llm-token-audit.ndjson");
}

const AGG_BUCKETS = new Map<string, LlmUsageAggregate>();

function ensureAuditFile(): void {
  const path = auditLogPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录创建失败不影响主链路 */
    }
  }
}

/**
 * 中英混合文本 token 估算（与 chat-thread-store.estimateTokens 同源）。
 */
export function estimateTokensForText(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = text
    .replace(/[\u4e00-\u9fa5]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords * 0.25);
}

/**
 * 字符 → token 的保守折算系数。
 * 中文约 1.5 token/字、英文约 2.5-4 字符/token；中英混合按 ~0.75 token/字符估算，
 * 与 chat-thread-store.estimateTokens 的量级一致（估算而非精确计费）。
 */
export const CHARS_TO_TOKENS_RATIO = 0.75;

/**
 * 记录一次 LLM 调用的输入/输出规模（fire-and-forget，不阻塞调用方）。
 */
export function recordLlmUsage(rec: Omit<LlmUsageRecord, "t" | "inputTokens" | "outputTokens">): void {
  const inputTokens = Math.max(1, Math.round(rec.inputChars * CHARS_TO_TOKENS_RATIO));
  const outputTokens = Math.round(rec.outputChars * CHARS_TO_TOKENS_RATIO);
  const aggregate: LlmUsageAggregate = {
    calls: 1,
    inputChars: rec.inputChars,
    outputChars: rec.outputChars,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  const key = rec.stage;
  const prev = AGG_BUCKETS.get(key);
  if (prev) {
    prev.calls += 1;
    prev.inputChars += rec.inputChars;
    prev.outputChars += rec.outputChars;
    prev.inputTokens += inputTokens;
    prev.outputTokens += outputTokens;
    prev.totalTokens += aggregate.totalTokens;
  } else {
    AGG_BUCKETS.set(key, aggregate);
  }

  try {
    ensureAuditFile();
    appendFileSync(
      auditLogPath(),
      JSON.stringify({ ...rec, t: new Date().toISOString(), inputTokens, outputTokens }) + "\n",
    );
  } catch {
    /* 写盘失败静默，不影响主链路 */
  }
}

/**
 * 基于估算字符数记录一次 LLM 调用（推荐使用：直接传字符数）。
 */
export function recordLlmUsageByChars(args: {
  stage: LlmAuditStage;
  inputChars: number;
  outputChars?: number;
  actorId?: string;
  sessionId?: string;
  model?: string;
}): void {
  recordLlmUsage({
    stage: args.stage,
    inputChars: Math.max(0, Math.round(args.inputChars)),
    outputChars: Math.max(0, Math.round(args.outputChars ?? 0)),
    actorId: args.actorId,
    sessionId: args.sessionId,
    model: args.model,
  });
}

/**
 * 从字符数组/字符串批量估算输入规模：与 recordLlmUsageByChars 配合，
 * 供调用方把 messages/tools 拼成字符串后统计。
 */
export function countChars(values: Array<string | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (typeof v === "string") total += v.length;
  }
  return total;
}

/**
 * 内存聚合快照：按环节输出占比（totalTokens 降序）。
 */
export function getLlmUsageSummary(): Array<{ stage: LlmAuditStage | string; calls: number; inputTokens: number; outputTokens: number; totalTokens: number; pct: number }> {
  const rows = [...AGG_BUCKETS.entries()].map(([stage, agg]) => ({
    stage,
    calls: agg.calls,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    pct: 0,
  }));
  const grand = rows.reduce((s, r) => s + r.totalTokens, 0);
  for (const r of rows) {
    r.pct = grand > 0 ? Math.round((r.totalTokens / grand) * 1000) / 10 : 0;
  }
  return rows.sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * 从落盘 NDJSON 聚合（跨进程重启后仍可查）。文件不存在返回空数组。
 */
export function getLlmUsageSummaryFromDisk(): Array<{ stage: string; calls: number; inputTokens: number; outputTokens: number; totalTokens: number; pct: number }> {
  const path = auditLogPath();
  if (!existsSync(path)) return [];
  const map = new Map<string, LlmUsageAggregate>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LlmUsageRecord;
        const agg = map.get(rec.stage);
        const add = {
          calls: 1,
          inputChars: rec.inputChars ?? 0,
          outputChars: rec.outputChars ?? 0,
          inputTokens: rec.inputTokens ?? 0,
          outputTokens: rec.outputTokens ?? 0,
          totalTokens: (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0),
        };
        if (agg) {
          agg.calls += add.calls;
          agg.inputChars += add.inputChars;
          agg.outputChars += add.outputChars;
          agg.inputTokens += add.inputTokens;
          agg.outputTokens += add.outputTokens;
          agg.totalTokens += add.totalTokens;
        } else {
          map.set(rec.stage, add);
        }
      } catch {
        /* 单行损坏忽略 */
      }
    }
  } catch {
    return [];
  }
  const rows = [...map.entries()].map(([stage, agg]) => ({
    stage,
    calls: agg.calls,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    pct: 0,
  }));
  const grand = rows.reduce((s, r) => s + r.totalTokens, 0);
  for (const r of rows) {
    r.pct = grand > 0 ? Math.round((r.totalTokens / grand) * 1000) / 10 : 0;
  }
  return rows.sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 仅供测试使用 */
export function resetLlmUsageAuditForTest(): void {
  AGG_BUCKETS.clear();
}