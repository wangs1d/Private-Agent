import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import OpenAI from "openai";

/**
 * 滚动摘要（rolling recap）增强器。
 *
 * 背景：thread 上下文窗口有限，`trimByDayBoundary` / `smartTrimByTokens` 会把较早期的
 * 对话压成一条 `[session-recap]` 摘要。旧的正则提取只取首句，信息损失大，导致 agent
 * 忘记关键事实、时间线错乱、追问答非所问（用户反馈的"上下文跳转"）。
 *
 * 本模块实现「LLM 增量滚动摘要」：输入已有 recap 行 + 新被丢弃的对话消息，由 LLM 整合
 * 成新的 recap 行，模拟人类记忆机制——保留用户偏好/事实/承诺/决策/时间线，丢弃琐碎细节。
 * 这是 recap 的唯一生成方式（旧的正则提取已移除）。与现有记忆架构（agentic-memory 召回、
 * KV 摘要、海马体图谱）并行互补：滚动摘要负责「上下文窗口内的短期→中期连续性」，
 * 外部记忆负责「长期召回」。
 *
 * 设计约束：
 * - 增量合并：已有 recap 行必须保留，只在上面吸收新消息，不重复、不丢失
 * - 输出格式与现有 recap 兼容：每行 `- 内容`，可被 extractSessionRecapLines 解析
 * - 失败降级：任何异常返回 null，调用方保留已有 recap 行（不影响对话主链路）
 */

export type RecapSummarizerContext = {
  /** 当前 thread 中已有的 recap 行（已 strip 前缀） */
  existingLines: string[];
  /** 本次被 trim 丢弃、需要被吸收进 recap 的历史消息 */
  droppedMessages: ChatCompletionMessageParam[];
};

export type RecapSummarizer = (ctx: RecapSummarizerContext) => Promise<string[] | null>;

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_MAX_LINES = 14;
const DEFAULT_MAX_LINE_CHARS = 120;

/** 从消息里提取可进摘要的文本（跳过 tool 结果、空 content、已有 recap）。 */
export function extractSummarizableText(msg: ChatCompletionMessageParam): string {
  if (msg.role === "tool") return "";
  if (typeof msg.content !== "string") return "";
  let text = msg.content.trim();
  // 去时间戳前缀 [ts:...]
  text = text.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
  // 跳过 recap 自身与工具残留
  if (!text || text.startsWith("[session-recap]") || text.startsWith("[tool_calls]")) return "";
  const role = msg.role === "assistant" ? "assistant" : "user";
  return `${role}: ${text}`;
}

/** 把对话消息序列化为 LLM 输入文本（限制总长，防 prompt 爆炸）。 */
function serializeDroppedMessages(messages: ChatCompletionMessageParam[], maxChars = 4000): string {
  const lines: string[] = [];
  let total = 0;
  for (const msg of messages) {
    const line = extractSummarizableText(msg);
    if (!line) continue;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

/** 解析 LLM 输出为 recap 行（兼容 `- 内容` 格式，去重、限长、限条数）。 */
export function parseRecapLinesFromLlmOutput(
  output: string,
  maxLines = DEFAULT_MAX_LINES,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
): string[] {
  if (!output) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of output.split("\n")) {
    if (lines.length >= maxLines) break;
    let line = raw.trim().replace(/^[-*\s]+/, "").trim();
    if (!line) continue;
    if (/^```/.test(line)) continue; // 跳过代码块围栏
    if (line.length > maxLineChars) {
      line = `${line.slice(0, maxLineChars - 3).trimEnd()}...`;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function buildSummarizeMessages(ctx: RecapSummarizerContext): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const existing = ctx.existingLines.length > 0 ? ctx.existingLines.map((l) => `- ${l}`).join("\n") : "（空）";
  const dropped = serializeDroppedMessages(ctx.droppedMessages);
  const system = [
    "你是用户的长期记忆整理器。系统会把较早期的对话从上下文窗口中压缩出去，由你生成「滚动摘要」，模拟人类长期记忆：",
    "记得关键事实、用户偏好、承诺、请求、决策与时间线，忘掉琐碎细节。",
    "",
    "任务：把下方「已有滚动摘要」与「新对话」增量合并，输出新的滚动摘要行。",
    "要求：",
    "1. 必须保留已有摘要中的关键信息，不要删除或改写其大意；",
    "2. 从新对话中吸收尚未覆盖的关键事实（用户偏好/事实/请求/承诺/决策/具体时间或日期）；",
    "3. 不重复已有内容，不编造不存在的信息；",
    "4. 每条一行，以「- 」开头，每行不超过 120 字；",
    "5. 每条必须带时间标签（[今天]/[昨天]/[N天前]），无明确时间的关键事实标 [历史]；",
    "6. 总共不超过 14 行；",
    "7. 时间线顺序：先近后远（[今天] → [昨天] → [N天前]），与时间线对齐，不要乱序；",
    "8. 只输出这些摘要行本身，不要任何解释、标题或代码块。",
  ].join("\n");
  const user = [
    "已有滚动摘要：",
    existing,
    "",
    "新对话（即将从窗口中压缩）：",
    dropped || "（无有效内容）",
    "",
    "请输出合并后的滚动摘要行：",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 创建基于 LLM 的滚动摘要增强器。
 * - 跟随当前生效的 provider（DeepSeek / Kimi / OpenAI 等 OpenAI 兼容端点），
 *   不再硬编码模型名，避免在只支持 deepseek-v4-* 的代理下被 400 拒绝；
 *   显式入参 model / AGENT_RECAP_SUMMARIZE_MODEL 仍可覆盖。
 * - 未配置任何 provider 密钥时返回 null（关闭增强，仅保留已有 recap 行）
 * - 调用失败时返回 null（调用方保留已有 recap 行）
 */
export function createLlmRollingRecapSummarizer(opts?: {
  apiKey?: string;
  model?: string;
  maxLines?: number;
  maxLineChars?: number;
}): RecapSummarizer | null {
  // 快速路径：任一已配置的 provider 密钥（Moonshot / OpenAI）均可启用。
  // 具体 key/baseURL/model 在调用时懒加载 resolvePrimaryLlmClientConfig 决定，
  // 与主对话链路保持同一 provider（auto 模式下 Moonshot 优先），
  // 避免"只配 MOONSHOT_API_KEY 时摘要功能静默关闭 / OPENAI key 配 Moonshot baseURL"的错配。
  const hasAnyProviderKey =
    !!opts?.apiKey?.trim() ||
    !!process.env.MOONSHOT_API_KEY?.trim() ||
    !!process.env.OPENAI_API_KEY?.trim();
  if (!hasAnyProviderKey) return null;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineChars = opts?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  return async (ctx): Promise<string[] | null> => {
    try {
      // 懒加载避免静态循环依赖：external-model/providers → abstract-chat-provider → chat-thread-store → 本模块
      const { resolvePrimaryLlmClientConfig } =
        await import("../external-model/resolve-provider.js");
      const binding = resolvePrimaryLlmClientConfig();
      const apiKey = opts?.apiKey?.trim() || binding?.apiKey?.trim();
      if (!apiKey) return null; // 主 provider 无可用密钥（与 provider 解析对齐）
      const model =
        opts?.model?.trim() ||
        process.env.AGENT_RECAP_SUMMARIZE_MODEL?.trim() ||
        binding?.model?.trim() ||
        DEFAULT_MODEL;
      const baseURL = binding?.baseURL?.trim() || process.env.OPENAI_BASE_URL?.trim();
      const openai = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
      // Token 审计：串行化 prompt 估算输入规模
      const auditInput = JSON.stringify(buildSummarizeMessages(ctx));
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 600,
        messages: buildSummarizeMessages(ctx),
      });
      const content = response.choices[0]?.message?.content?.trim();
      {
        // 防循环依赖：懒加载审计模块
        const { recordLlmUsageByChars } = await import("./llm-token-audit.js");
        recordLlmUsageByChars({
          stage: "rolling_summary",
          inputChars: auditInput.length,
          outputChars: content?.length ?? 0,
          model,
        });
      }
      if (!content) return null;
      const lines = parseRecapLinesFromLlmOutput(content, maxLines, maxLineChars);
      return lines.length > 0 ? lines : null;
    } catch (err) {
      console.warn(`[RollingRecap] LLM 摘要失败（降级保留旧 recap）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
}

// ── 事件化分层 recap（记忆连续性优化 Phase 2）───────────────

/**
 * recap 行的时间桶。按行首 `[今天] / [昨天] / [N天前] / [N周前] / [N个月前]` 标签分层，
 * 让"时间线不拍平"——注入时近层全量、远层可压缩，跳转可追溯。
 */
export type RecapTimeBucket = "today" | "yesterday" | "thisWeek" | "older" | "untagged";

export const RECAP_TIME_BUCKET_ORDER: RecapTimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "older",
  "untagged",
];

const RECAP_TIME_TAG_RE = /^\[(今天|昨天|(\d+)天前|(\d+)周前|(\d+)个月前)\]\s*/;

/** 解析 recap 行首的时间标签；无标签返回 null。 */
export function readRecapTimeTag(line: string): string | null {
  const m = line.trim().match(RECAP_TIME_TAG_RE);
  return m ? m[0].trim() : null;
}

/** 把 recap 行归类到时间桶。 */
export function bucketRecapLine(line: string): RecapTimeBucket {
  const m = line.trim().match(RECAP_TIME_TAG_RE);
  if (!m) return "untagged";
  if (m[1] === "今天") return "today";
  if (m[1] === "昨天") return "yesterday";
  if (m[2]) {
    const days = parseInt(m[2], 10);
    if (days >= 2 && days <= 6) return "thisWeek";
    return "older";
  }
  return "older"; // [N周前]/[N个月前]
}

export type RecapLayers = Record<RecapTimeBucket, string[]>;

/**
 * 事件化分层：把 recap 行按时间标签分成 今天/昨天/本周/更早/无标签 五桶。
 * - 行内保留原标签（[今天]/[昨天]/[N天前]），保证 LLM 能区分时间线；
 * - 输出顺序固定（today → yesterday → thisWeek → older → untagged），
 *   与 buildSessionRecapContent 的写入顺序一致，避免 recap 消息内部时间乱跳。
 */
export function layerRecapLines(lines: string[]): RecapLayers {
  const layers: RecapLayers = { today: [], yesterday: [], thisWeek: [], older: [], untagged: [] };
  for (const line of lines) {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed) continue;
    const bucket = bucketRecapLine(trimmed);
    layers[bucket].push(trimmed);
  }
  return layers;
}

/**
 * 把分层 recap 拍平为有序行（时间线顺序：今天 → 昨天 → 本周 → 更早 → 无标签）。
 * 供 buildSessionRecapContent 等写回场景使用，保证 recap 消息内部时间有序。
 */
export function flattenRecapLayers(layers: RecapLayers): string[] {
  const out: string[] = [];
  for (const bucket of RECAP_TIME_BUCKET_ORDER) {
    out.push(...layers[bucket]);
  }
  return out;
}

/**
 * 按注入预算裁剪分层 recap：近层（今天/昨天）优先全量保留，远层按需压缩。
 * 记忆连续性优先"最近的时间线"，token 紧张时牺牲更早的细节而非近因。
 *
 * @param lines 原始 recap 行（可无序）
 * @param maxLines 裁剪后总行数上限（≤0 表示不裁剪）
 * @param compressOldest 是否压缩最远层（保留每桶头部关键行，丢弃尾部细节）
 * @returns 按时间线顺序排列、受限后的行
 */
export function layerRecapLinesByBudget(
  lines: string[],
  maxLines = 14,
  compressOldest = true,
): string[] {
  if (maxLines <= 0) return flattenRecapLayers(layerRecapLines(lines));
  const layers = layerRecapLines(lines);
  // 近层配额：今天全量，昨天全量，本周最多 4，更早最多 3，无标签最多 3
  const quotas: Partial<Record<RecapTimeBucket, number>> = {
    today: Infinity,
    yesterday: Infinity,
    thisWeek: 4,
    older: 3,
    untagged: 3,
  };
  const kept: string[] = [];
  for (const bucket of RECAP_TIME_BUCKET_ORDER) {
    const bucketLines = layers[bucket];
    if (bucketLines.length === 0) continue;
    const quota = quotas[bucket] ?? 3;
    if (bucketLines.length <= quota) {
      kept.push(...bucketLines);
    } else {
      // 超配额：优先保留头部（更重要的早期承诺/事实），尾部压缩
      const head = bucketLines.slice(0, quota);
      kept.push(...head);
      if (compressOldest) {
        kept.push(`[${bucketHeadLabel(bucket)}] …（另有 ${bucketLines.length - quota} 条细节已压缩）`);
      }
    }
    if (kept.length >= maxLines) break;
  }
  return kept.slice(0, maxLines);
}

function bucketHeadLabel(bucket: RecapTimeBucket): string {
  switch (bucket) {
    case "today": return "今天";
    case "yesterday": return "昨天";
    case "thisWeek": return "本周";
    case "older": return "更早";
    default: return "历史";
  }
}
