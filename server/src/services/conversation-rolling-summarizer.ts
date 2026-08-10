import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import OpenAI from "openai";

/**
 * 滚动摘要（rolling recap）增强器。
 *
 * 背景：thread 上下文窗口有限，`trimByDayBoundary` / `smartTrimByTokens` 会把较早期的
 * 对话压成一条 `[session-recap]` 摘要。旧实现（extractRecapLinesFromMessages）只做
 * 正则提取首句，信息损失大，导致 agent 忘记关键事实、时间线错乱、追问答非所问
 * （用户反馈的"上下文跳转"）。
 *
 * 本模块把 recap 升级为「LLM 增量滚动摘要」：输入已有 recap 行 + 新被丢弃的对话消息，
 * 由 LLM 整合成新的 recap 行，模拟人类记忆机制——保留用户偏好/事实/承诺/决策/时间线，
 * 丢弃琐碎细节。与现有记忆架构（agentic-memory 召回、KV 摘要、海马体图谱）并行互补：
 * 滚动摘要负责「上下文窗口内的短期→中期连续性」，外部记忆负责「长期召回」。
 *
 * 设计约束：
 * - 增量合并：已有 recap 行必须保留，只在上面吸收新消息，不重复、不丢失
 * - 输出格式与现有 recap 兼容：每行 `- 内容`，可被 extractSessionRecapLines 解析
 * - 失败降级：任何异常返回 null，调用方保留旧 recap（不影响对话主链路）
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
    "5. 保留日期标签（如 [今天]/[昨天]/[N天前]）以区分时间线；",
    "6. 总共不超过 14 行；",
    "7. 只输出这些摘要行本身，不要任何解释、标题或代码块。",
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
 * - 未配置 OPENAI_API_KEY 时返回 null（关闭增强，保持旧正则 recap）
 * - 调用失败时返回 null（调用方保留旧 recap）
 */
export function createLlmRollingRecapSummarizer(opts?: {
  apiKey?: string;
  model?: string;
  maxLines?: number;
  maxLineChars?: number;
}): RecapSummarizer | null {
  const apiKey = opts?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = opts?.model?.trim() || process.env.AGENT_RECAP_SUMMARIZE_MODEL?.trim() || DEFAULT_MODEL;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineChars = opts?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  return async (ctx): Promise<string[] | null> => {
    try {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 600,
        messages: buildSummarizeMessages(ctx),
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return null;
      const lines = parseRecapLinesFromLlmOutput(content, maxLines, maxLineChars);
      return lines.length > 0 ? lines : null;
    } catch (err) {
      console.warn(`[RollingRecap] LLM 摘要失败（降级保留旧 recap）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
}
