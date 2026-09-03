/**
 * `[ts:...]` 时间戳帧的统一清洗工具（用户可见通道出口专用）。
 *
 * 背景：线程存储把 `[ts:日期|周X|relative]`（及变体 `[ts:日期]周X[now]`）前缀
 * 内嵌在消息首行，仅供 LLM 做时间关联。LLM 偶尔会把该帧"复述"进回复——且复述
 * 可能残缺（`[ts` 后断行、丢冒号），行首锚定的 `\[ts:` 严格正则匹配不上，导致
 * 泄漏到前端气泡。这里提供一套容忍残缺帧的清洗原语，供所有面向用户的输出出口
 * （chunk 推送、finalText、分段器入料）统一使用。
 *
 * 注意：只清理"帧"本身（含尾随的 `周X` / `[now]` 相对时间记号），绝不做行首
 * 之外的宽泛删除，避免误伤以 `[ts...` 开头的合法正文。
 */

/** 单个时间戳帧单元：`[ts<非]>字符≤160>]` + 尾随星期与相对时间记号。 */
const FRAME_UNIT_SOURCE = String.raw`\[ts[^\]]{0,160}\][ \t]*(?:周[日一二三四五六]?[ \t]*)?(?:\[[^\]]{0,48}\][ \t]*)*`;

/** 行首帧（不含 g 标志，供逐次剥离/测试）。允许帧前有空白/换行，兼容"上一帧独占一行后紧跟下一帧"。 */
const LEADING_FRAME_RE = new RegExp(`^\\s*${FRAME_UNIT_SOURCE}`);

/** 整行恰为一个或多个帧 → 连行删除（m 标志多行，含行尾换行）。 */
const FRAME_LINE_RE = new RegExp(
  `^[ \\t]*${FRAME_UNIT_SOURCE}(?:[ \\t]*${FRAME_UNIT_SOURCE})*[ \\t]*(?:\\n|$)`,
  "gm",
);

/** 行首帧（多行）：帧后面即使跟着同行的正文也剥帧留正文（对齐旧 `^\\[ts:` gm 行为）。 */
const LINE_START_FRAME_RE = new RegExp(`^[ \\t]*${FRAME_UNIT_SOURCE}`, "gm");

/** 文本中任意位置的帧单元（供整帧判定）。 */
const FRAME_UNIT_GLOBAL_RE = new RegExp(FRAME_UNIT_SOURCE, "g");

/**
 * 剥掉文本开头连续的时间戳帧（含残缺帧），并去掉剥离后的首部空白。
 * 用于：流式 chunk 出口（帧可能落在任一 segment 开头）、存储消息首行前缀剥离。
 */
export function stripLeadingTimestampFrames(text: string): string {
  if (!text || !text.includes("[ts")) return text;
  let out = text;
  for (let i = 0; i < 4; i++) {
    const m = out.match(LEADING_FRAME_RE);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return out.replace(/^\s+/, "");
}

/**
 * 删除文本中的时间戳帧：先整行删除"纯帧行"（含残缺帧），再剥剩余行首的帧
 * （帧与正文同行的形态），最后收敛空行。用于：finalText / finalFeed / 历史可见文本兜底。
 */
export function stripAllTimestampFrameLines(text: string): string {
  if (!text || !text.includes("[ts")) return text;
  return text
    .replace(FRAME_LINE_RE, "")
    .replace(LINE_START_FRAME_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}

/** 判断文本剥掉全部帧单元后是否不剩实质内容（整条就是一个/一串时间戳帧）。 */
export function isOnlyTimestampFrames(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!trimmed.includes("[ts")) return false;
  return trimmed.replace(FRAME_UNIT_GLOBAL_RE, "").trim().length === 0;
}
