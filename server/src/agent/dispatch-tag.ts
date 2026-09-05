/**
 * [dispatch:...] 结构化派发标签（2026-09-05 前后台架构）。
 *
 * 契约：前台模型在回复文本里内嵌 `[dispatch:{"goal":"...","note":"..."}]`
 * 标签表达"派后台办事"，ack 文本与标签同体输出——前台 1 次 LLM 调用完成
 * 回复 + 派发，不再需要 task.dispatch 工具调用的第二轮（结果回灌）。
 * 服务端职责：流式出口逐块剥离标签（用户不可见）+ 从完整文本解析出
 * 派发请求送 TaskHub；解析失败由出口诚实闸兜底（承诺话术无派发 → 补派）。
 *
 * 流式剥离器与 [ts:] 时间戳帧剥离同款思路：完整标签直接剥，尾部疑似
 * 未完整标签前缀 hold 到下一块，防标签跨 chunk 泄漏到前端。
 */

export type DispatchRequest = {
  goal: string;
  note?: string;
};

const TAG_HEAD = "[dispatch:";
/** 单轮回复派发上限（防刷）。 */
export const MAX_DISPATCH_TAGS_PER_TURN = 3;

/**
 * 扫描一个完整标签的结束位置。
 * @returns 紧跟闭 `]` 之后的下标；标签未完整返回 -1。
 * 两种形态：JSON 体（首个 `{` 在首个 `]` 之前，按括号配对扫描）与
 * 纯文本 goal（首个 `]` 在 `{` 之前/无 `{`，直接以该 `]` 闭合）。
 */
function scanTagEnd(text: string, headStart: number): number {
  const close = text.indexOf("]", headStart + 1);
  const open = text.indexOf("{", headStart + 1);
  if (open === -1 || (close !== -1 && close < open)) {
    return close === -1 ? -1 : close + 1;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 闭对象后必须（允许空白）紧跟 `]` 才算完整标签
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j]!)) j++;
        return text[j] === "]" ? j + 1 : -1;
      }
    }
  }
  return -1;
}

/** 解析标签体：优先 JSON（{goal, note}），容忍纯文本 goal（[dispatch:提醒我开会]）。 */
function parseTagBody(body: string): DispatchRequest | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as { goal?: unknown; note?: unknown };
      const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
      if (!goal) return null;
      return {
        goal,
        ...(typeof obj.note === "string" && obj.note.trim() ? { note: obj.note.trim() } : {}),
      };
    } catch {
      return null;
    }
  }
  return { goal: trimmed };
}

/** 从完整文本解析全部派发请求（顺序返回，超过上限截断）。 */
export function parseDispatchTags(text: string): DispatchRequest[] {
  const out: DispatchRequest[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 20; guard++) {
    const idx = text.indexOf(TAG_HEAD, cursor);
    if (idx === -1) break;
    const end = scanTagEnd(text, idx);
    if (end === -1) {
      cursor = idx + TAG_HEAD.length;
      continue;
    }
    const bodyStart = idx + TAG_HEAD.length;
    const braceIdx = text.lastIndexOf("}", end);
    const body =
      braceIdx > bodyStart
        ? text.slice(bodyStart, braceIdx + 1)
        : text.slice(bodyStart, end - 1);
    const req = parseTagBody(body);
    if (req) out.push(req);
    cursor = end;
  }
  return out.slice(0, MAX_DISPATCH_TAGS_PER_TURN);
}

/** 静态剥离全部标签（最终文本兜底；流式路径用 {@link DispatchTagStreamFilter}）。 */
export function stripDispatchTags(text: string): string {
  let out = "";
  let cursor = 0;
  for (let guard = 0; guard < 20; guard++) {
    const idx = text.indexOf(TAG_HEAD, cursor);
    if (idx === -1) break;
    const end = scanTagEnd(text, idx);
    if (end === -1) break;
    out += text.slice(cursor, idx);
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/** 尾部是否为 TAG_HEAD 的前缀（疑似被 chunk 截断的标签头）。 */
function longestTagHeadPrefixAtEnd(text: string): number {
  const max = Math.min(TAG_HEAD.length - 1, text.length);
  for (let len = max; len > 0; len--) {
    if (TAG_HEAD.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/**
 * 流式剥离过滤器：feed 逐块产出"可安全透出"的文本，闭标签剥除、
 * 尾部疑似标签头 hold 到下一块；flush 在流结束时产出剩余清洗文本。
 */
export class DispatchTagStreamFilter {
  private buf = "";

  feed(delta: string): string {
    if (!delta) return "";
    this.buf += delta;
    return this.drain(false);
  }

  /** 流结束：产出剩余缓冲（未完整的标签头按控制片段剥除）。 */
  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = "";
    for (let guard = 0; guard < 50; guard++) {
      const idx = this.buf.indexOf(TAG_HEAD);
      if (idx === -1) {
        // 无标签头：只 hold 尾部可能被截断的标签前缀
        const hold = final ? 0 : longestTagHeadPrefixAtEnd(this.buf);
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = hold ? this.buf.slice(this.buf.length - hold) : "";
        return out;
      }
      out += this.buf.slice(0, idx);
      const end = scanTagEnd(this.buf, idx);
      if (end === -1) {
        // 标签未完整：从标签头起全部 hold（final 时剥掉未完整片段）
        this.buf = final ? "" : this.buf.slice(idx);
        return out;
      }
      this.buf = this.buf.slice(end);
    }
    return out;
  }
}
