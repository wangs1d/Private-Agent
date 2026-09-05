import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import OpenAI from "openai";

/**
 * 滚动摘要（rolling recap）增强器——「滑动窗口 + 增量摘要」裁剪策略的摘要侧。
 *
 * 背景：thread 上下文窗口有限，滑动窗口外的历史对话不再「折叠进固定 14 行 recap」
 * （旧行会在字符预算内被挤掉，等价于静默遗忘），而是走增量摘要：LLM 把「已有摘要 +
 * 未归纳原文行 + 新溢出批次」合并成新的滚动摘要行。语义由 LLM 逐批吸收，配合线程内
 * 的 [unsummarized] 待归纳区，保证被窗口裁掉的内容在归纳成功前始终以原文占位存在。
 *
 * 与现有记忆架构（agentic-memory 召回、KV 摘要、海马体图谱）并行互补：滚动摘要负责
 * 「上下文窗口内的短期→中期连续性」，外部记忆负责「长期召回」，turn WAL/journal
 * 负责「全量归档与检索兜底」。
 *
 * 设计约束：
 * - 增量合并：已有摘要行必须保留关键信息，只在上面吸收新内容，不重复、不丢失
 * - 时间感知：每行带绝对时间标签（[YYYY/MM/DD 周X HH:MM]），跨天不会退化成错误相对词
 * - 输出格式与现有 recap 兼容：每行 `- 内容`，可被 extractSessionRecapLines 解析
 * - 失败降级：任何异常返回 null，调用方保留已有摘要行与待归纳区（不影响对话主链路）
 */

export type RecapSummarizerContext = {
  /** 当前 thread 中已有的摘要行 + 待归纳原文行（已 strip 前缀，全部需被吸收） */
  existingLines: string[];
  /** 本次滑动窗口溢出、需要被吸收进摘要的历史消息 */
  droppedMessages: ChatCompletionMessageParam[];
};

export type RecapSummarizer = (ctx: RecapSummarizerContext) => Promise<string[] | null>;

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_MAX_LINES = 30;
const DEFAULT_MAX_LINE_CHARS = 160;

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadRecapSummarizerBudget(): { maxLines: number; maxLineChars: number } {
  return {
    maxLines: parseIntEnv(process.env.AGENT_RECAP_SUMMARY_MAX_LINES, DEFAULT_MAX_LINES),
    maxLineChars: parseIntEnv(process.env.AGENT_RECAP_SUMMARY_MAX_LINE_CHARS, DEFAULT_MAX_LINE_CHARS),
  };
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 摘要行的绝对时间标签（不含秒，省预算）：`2026/09/04 周四 14:32`。 */
export function formatRecapStamp(at: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const date = `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
  const weekday = WEEKDAY_CN[at.getDay()] ?? "";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${date} ${weekday} ${time}`;
}

/** 从消息正文首行解析 `[ts:YYYY-MM-DD HH:MM:SS|...]` 帧（本地复制，避免与 store 循环依赖）。 */
function parseTsFrameDate(content: string | null | undefined): Date | null {
  if (!content) return null;
  const m = content.match(/\[ts:(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}\|/);
  if (!m?.[1]) return null;
  const ts = Date.parse(`${m[1]}T${m[2]!}:00`);
  return Number.isNaN(ts) ? null : new Date(ts);
}

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

/** 把对话消息序列化为 LLM 输入文本：每行带绝对时间戳，限制总长防 prompt 爆炸。 */
function serializeDroppedMessages(messages: ChatCompletionMessageParam[], maxChars = 8000): string {
  const lines: string[] = [];
  let total = 0;
  for (const msg of messages) {
    const line = extractSummarizableText(msg);
    if (!line) continue;
    const ts = typeof msg.content === "string" ? parseTsFrameDate(msg.content) : null;
    const stamped = ts ? `[${formatRecapStamp(ts)}] ${line}` : line;
    if (total + stamped.length > maxChars) break;
    lines.push(stamped);
    total += stamped.length;
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

function buildSummarizeMessages(
  ctx: RecapSummarizerContext,
  budget: { maxLines: number; maxLineChars: number } = loadRecapSummarizerBudget(),
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const existing = ctx.existingLines.length > 0 ? ctx.existingLines.map((l) => `- ${l}`).join("\n") : "（空）";
  const dropped = serializeDroppedMessages(ctx.droppedMessages);
  const now = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const nowLabel = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${WEEKDAY_CN[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const system = [
    "你是用户的长期记忆整理器。系统以「滑动窗口 + 增量摘要」维护对话上下文：窗口外的事件由你增量合并进滚动摘要，模拟人类长期记忆：",
    "记得关键事实、用户偏好、承诺、请求、决策与时间线，忘掉琐碎细节。",
    "",
    `当前时间：${nowLabel}（时间标签一律用它推算）。`,
    "",
    "任务：把下方「已有内容」（滚动摘要 + 尚未归纳的原文行）与「新对话」增量合并，输出新的滚动摘要行。",
    "要求：",
    "1. 必须保留已有内容中的全部关键信息（含未归纳原文行里的事件），不要删除或改写其大意；",
    "2. 从新对话中吸收尚未覆盖的关键事实（用户偏好/事实/请求/承诺/决策/具体时间或日期）；",
    "3. 不重复、不编造；同一事件的旧表述与新信息可合并为一行，以更完整的表述为准；",
    `4. 每条一行，以「- 」开头，每行不超过 ${budget.maxLineChars} 字；`,
    "5. 每条必须带绝对时间标签 [YYYY/MM/DD 周X HH:MM]（时刻不明可省略时刻，日期不明标 [早期]），标签与内容之间留一个空格；",
    `6. 总共不超过 ${budget.maxLines} 行；若空间不足，压缩最旧、最琐碎的行，绝不丢用户偏好/承诺/决定；`,
    "7. 时间线顺序：新事件在前、旧事件在后，不要乱序；",
    "8. 只输出这些摘要行本身，不要任何解释、标题或代码块。",
  ].join("\n");
  const user = [
    "已有内容（滚动摘要 + 未归纳原文行，需全部吸收）：",
    existing,
    "",
    "新对话（即将滑出窗口）：",
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
  const budget = {
    maxLines: opts?.maxLines ?? loadRecapSummarizerBudget().maxLines,
    maxLineChars: opts?.maxLineChars ?? loadRecapSummarizerBudget().maxLineChars,
  };

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
        max_tokens: 1500,
        messages: buildSummarizeMessages(ctx, budget),
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
      const lines = parseRecapLinesFromLlmOutput(content, budget.maxLines, budget.maxLineChars);
      return lines.length > 0 ? lines : null;
    } catch (err) {
      console.warn(`[RollingRecap] LLM 摘要失败（降级保留旧 recap）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
}

// ── 事件化分层 recap（记忆连续性优化 Phase 2）───────────────

/**
 * recap 行的时间桶。按行首时间标签分层，让"时间线不拍平"——注入时近层全量、远层可压缩。
 * 标签两种格式：
 * - 绝对（现行）：`[2026/09/04 周四 14:32]` —— 跨天分桶不失效，按真实日期对 now 计算
 * - 相对（旧数据兼容）：`[今天] / [昨天] / [N天前] / [N周前] / [N个月前]`
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
const RECAP_ABSOLUTE_TAG_RE =
  /^\[(\d{4})\/(\d{2})\/(\d{2})(?:\s+周[一二三四五六日天])?(?:\s+(\d{2}):(\d{2}))?\]\s*/;

function dayDiffDays(from: Date, to: Date): number {
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((toDay - fromDay) / 86_400_000);
}

/** 解析行首绝对时间标签为 Date；无标签返回 null。 */
export function readRecapAbsoluteTag(line: string): Date | null {
  const m = line.trim().match(RECAP_ABSOLUTE_TAG_RE);
  if (!m?.[1]) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:00`);
  return Number.isNaN(ts) ? null : new Date(ts);
}

/** 解析 recap 行首的时间标签（相对词原样返回）；无标签返回 null。 */
export function readRecapTimeTag(line: string): string | null {
  const trimmed = line.trim();
  const abs = trimmed.match(RECAP_ABSOLUTE_TAG_RE);
  if (abs) return abs[0].trim();
  const m = trimmed.match(RECAP_TIME_TAG_RE);
  return m ? m[0].trim() : null;
}

/**
 * 把旧数据 recap 行的相对时间标签确定性换算为绝对标签（不依赖 LLM）。
 *
 * 背景：旧版折叠行带 `[今天]/[昨天]/[N天前]` 相对标签，在折叠时刻计算后冻结落盘。
 * 跨天加载后「[今天]」实际指折叠日，与系统提示词的当前时间矛盾——模型把旧事当现事
 * 承接（「昨天聊的，今天刚开始对话还在当现事说」的病灶之一）。
 *
 * @param line recap 行（摘要行或待归纳原文行）
 * @param anchor 标签计算基准时刻：取 recap 块的 [ts:] 帧（旧版恢复线程时打的帧，
 *        近似折叠/整理时刻）。为 null 时无法换算，原样返回。
 * 已带绝对标签的行原样返回；[历史] 统一改为 [早期]。
 */
export function migrateRecapLineLabel(line: string, anchor: Date | null): string {
  // 行内容可能是渲染态（带 "- " bullet），剥掉后再匹配行首标签
  const bullet = line.match(/^(\s*-\s*)/);
  const prefix = bullet?.[1] ?? "";
  const trimmed = prefix ? line.slice(prefix.length).trim() : line.trim();
  if (RECAP_ABSOLUTE_TAG_RE.test(trimmed)) return line;
  const m = trimmed.match(RECAP_TIME_TAG_RE);
  if (!m) {
    // 旧 [历史] 标签 → [早期]（与摘要器提示词的现行措辞一致）
    if (trimmed.startsWith("[历史]")) return `${prefix}[早期]${trimmed.slice("[历史]".length)}`;
    return line;
  }
  if (!anchor) return line;
  const tag = m[1]!;
  let days = 0;
  if (tag === "今天") days = 0;
  else if (tag === "昨天") days = 1;
  else if (m[2]) days = parseInt(m[2], 10);
  else if (m[3]) days = 7 * parseInt(m[3], 10);
  else if (m[4]) days = 30 * parseInt(m[4], 10);
  const shifted = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - days);
  // 相对标签只精确到天，迁移时不伪造时刻：输出 [YYYY/MM/DD 周X]（时刻可省略，解析兼容）
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const date = `${shifted.getFullYear()}/${pad(shifted.getMonth() + 1)}/${pad(shifted.getDate())}`;
  const weekday = WEEKDAY_CN[shifted.getDay()] ?? "";
  return `${prefix}[${date} ${weekday}] ${trimmed.slice(m[0].length)}`;
}

/**
 * 对整块 recap content 逐行做相对→绝对标签迁移（标题/前缀/[unsummarized] 标记行
 * 不匹配标签正则，逐行应用天然安全）。返回原串表示无变化。
 */
export function migrateRecapContentLabels(content: string, anchor: Date | null): string {
  if (!anchor || !content.includes("[")) return content;
  const lines = content.split("\n");
  let changed = false;
  const migrated = lines.map((line) => {
    const next = migrateRecapLineLabel(line, anchor);
    if (next !== line) changed = true;
    return next;
  });
  return changed ? migrated.join("\n") : content;
}

/** 把 recap 行归类到时间桶（绝对标签按真实日期对 now 计算，相对标签直接映射）。 */
export function bucketRecapLine(line: string, now: Date = new Date()): RecapTimeBucket {
  const trimmed = line.trim();
  const abs = readRecapAbsoluteTag(trimmed);
  if (abs) {
    const days = dayDiffDays(abs, now);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days >= 2 && days <= 6) return "thisWeek";
    return "older";
  }
  const m = trimmed.match(RECAP_TIME_TAG_RE);
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
 * - 绝对时间标签按真实日期对 now 分桶（跨天自动归位，不产生陈旧相对词）；
 * - 输出顺序固定（today → yesterday → thisWeek → older → untagged），
 *   与 buildSessionRecapContent 的写入顺序一致，避免 recap 消息内部时间乱跳。
 */
export function layerRecapLines(lines: string[], now: Date = new Date()): RecapLayers {
  const layers: RecapLayers = { today: [], yesterday: [], thisWeek: [], older: [], untagged: [] };
  for (const line of lines) {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed) continue;
    const bucket = bucketRecapLine(trimmed, now);
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
 * @param lines 原始 recap 行（可无序，绝对/相对时间标签均可）
 * @param maxLines 裁剪后总行数上限（≤0 表示不裁剪）
 * @param compressOldest 是否压缩最远层（保留每桶头部关键行，丢弃尾部细节）
 * @param now 分桶基准时刻（默认当前时间；测试可注入）
 * @returns 按时间线顺序排列、受限后的行
 */
export function layerRecapLinesByBudget(
  lines: string[],
  maxLines = 14,
  compressOldest = true,
  now: Date = new Date(),
): string[] {
  if (maxLines <= 0) return flattenRecapLayers(layerRecapLines(lines, now));
  const layers = layerRecapLines(lines, now);
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
