import { detectAssistantToneMode } from "./assistant-tone-policy.js";

const LEADING_CLEANUPS: Array<[RegExp, string]> = [
  [/^(好的[，。！？\s]*)?(我来|我先|我直接|我给你|我帮你)(?:看一下|看下|处理一下|处理|说一下|讲一下)?[：:，。！？\s]*/u, ""],
  [/^(当然可以|可以的|没问题|当然|行的|好呀|好嘞|收到)[，。！？\s]*/u, ""],
  [/^(以下是|下面是|总的来说|简单来说|先说结论|结论先说|我先判断一下|我先看一下)[：:，。！？\s]*/u, ""],
  [/^(从这个角度来说|从结果看|从本质上看|说白了)[：:，。！？\s]*/u, ""],
];

const CLICHES: Array<[RegExp, string]> = [
  [/(\b我可以帮你\b|\b我来帮你\b)/g, "我帮你"],
  [/(\b如果你愿意\b|\b要是你想\b|\b你要是需要\b)/g, ""],
  [/(\b建议如下\b|\b总结一下\b|\b简单总结\b|\b结论是\b)/g, ""],
  [/(\b不难看出\b|\b很明显\b|\b本质上\b)/g, ""],
];

function cleanSpacing(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return [...text.matchAll(/([^。！？!?；;\n]+[。！？!?；;]?)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function normalizeSentence(text: string): string {
  return text
    .trim()
    .replace(/^(今天的话|所以现在|所以|不过|另外|另外刚才|其实|总之|然后|那|但|不过要说死|不过说死|要说死|顺手说一句)[，。！？、\s]*/u, "")
    .replace(/[“”"'`]/g, "")
    .replace(/[，。！？、,:;|()[\]{}<>【】]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function extractSentenceTokens(text: string): string[] {
  const normalized = normalizeSentence(text);
  const tokens = new Set<string>();

  for (const match of normalized.matchAll(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}月|\d{4}年|\d+/g)) {
    if (match[0]) tokens.add(match[0]);
  }
  for (const match of normalized.matchAll(/[a-z]{2,}|\d+[a-z]+/g)) {
    if (match[0]) tokens.add(match[0]);
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,8}/gu)) {
    if (match[0]) tokens.add(match[0]);
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{4,12}/gu)) {
    const run = match[0] ?? "";
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        tokens.add(run.slice(index, index + size));
      }
    }
  }

  return [...tokens].filter((token) => !/^(今天|现在|目前|昨天|刚才|这个|那个|这里|那里|的话|一下|真的|确实|应该|估计|大概|可能|安排|动态|消息|信息)$/u.test(token));
}

function sentenceOverlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  return intersection / Math.min(setA.size, setB.size);
}

function isFollowUpOffer(sentence: string): boolean {
  return /(要我帮你|要不要我|我再帮你|我给你捞|我给你找|我帮你看|我帮你捞|你是想看|你是想找|要不要再试|继续帮你|我按你说的帮你)/.test(sentence);
}

function isInferenceHeavySentence(sentence: string): boolean {
  return /(所以|应该|估计|大概率|多半|看起来|现在应该|还没走|待在那边|人在那边)/.test(sentence);
}

function isWrapUpRestatementSentence(sentence: string): boolean {
  return /^(所以|那她现在|她现在|所以她现在|所以现在).*(应该|估计|大概率)/.test(sentence.trim());
}

function isStatusProbableSentence(sentence: string): boolean {
  return /(搜不到|没有确切消息|没确切消息|实时行踪|活动还在继续|后续活动|大概率|估计|应该)/.test(sentence);
}

function dedupePlainLine(
  line: string,
  seenSentences: Array<{ raw: string; normalized: string; tokens: string[] }>,
  opts: { allowFollowUp: boolean },
): { text: string; keptFollowUp: boolean } {
  const kept: string[] = [];
  let keptFollowUp = false;

  for (const sentence of splitSentences(line)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const normalized = normalizeSentence(trimmed);
    if (!normalized) continue;

    if (isFollowUpOffer(trimmed)) {
      if (!opts.allowFollowUp || keptFollowUp) continue;
      kept.push(trimmed);
      keptFollowUp = true;
      seenSentences.push({ raw: trimmed, normalized, tokens: extractSentenceTokens(trimmed) });
      continue;
    }

    const tokens = extractSentenceTokens(trimmed);
    const redundant = seenSentences.some((seen) => {
      const overlap = sentenceOverlapScore(tokens, seen.tokens);
      if (seen.normalized === normalized || overlap >= 0.78) return true;
      if (isWrapUpRestatementSentence(trimmed) && isStatusProbableSentence(seen.raw) && overlap >= 0.18) {
        return true;
      }
      if (!isInferenceHeavySentence(trimmed)) return false;
      const unseenTokenCount = tokens.filter((token) => !seen.tokens.includes(token)).length;
      return overlap >= 0.45 && unseenTokenCount <= 1;
    });
    if (redundant) continue;

    kept.push(trimmed);
    seenSentences.push({ raw: trimmed, normalized, tokens });
  }

  return {
    text: kept.join(""),
    keptFollowUp,
  };
}

function normalizeStructuredLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*•|]\s*/u, "")
    .replace(/^\d+[.)、]\s*/u, "")
    .replace(/\*\*/g, "")
    .replace(/^[\p{Extended_Pictographic}\s]+/gu, "")
    .replace(/[“”"'`]/g, "")
    .replace(/[，。！？、,:;|()[\]{}<>【】]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function splitClauses(line: string): Array<{ text: string; punct: string }> {
  const matches = [...line.matchAll(/([^，。！？；：\n]+)([，。！？；：]*)/gu)];
  return matches
    .map((match) => ({
      text: match[1]?.trim() ?? "",
      punct: match[2] ?? "",
    }))
    .filter((part) => part.text);
}

function normalizeClause(text: string): string {
  return text
    .trim()
    .replace(/[“”"'`]/g, "")
    .replace(/[，。！？、,:;|()[\]{}<>【】]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function stripRepeatedClauses(line: string, seenClauses: Set<string>): string {
  const parts = splitClauses(line);
  if (parts.length < 2) return line.trim();

  const kept = parts.filter((part) => {
    const normalized = normalizeClause(part.text);
    if (normalized.length < 6 || normalized.length > 32) return true;
    return !seenClauses.has(normalized);
  });

  if (kept.length === 0 || kept.length === parts.length) return line.trim();
  return kept.map((part) => `${part.text}${part.punct}`).join("").trim();
}

function rememberClauses(line: string, seenClauses: Set<string>): void {
  for (const part of splitClauses(line)) {
    const normalized = normalizeClause(part.text);
    if (normalized.length >= 6 && normalized.length <= 32) {
      seenClauses.add(normalized);
    }
  }
}

/** 是否为 Markdown 表格行（含 ≥2 个 | 分隔）或表头分隔行：原样保留，不参与改写/去重 */
function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  return trimmed.split("|").length >= 3;
}

function cleanStructuredReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const seenLines = new Set<string>();
  const seenClauses = new Set<string>();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }

    // Markdown 表格行（含分隔行）原样保留，不做改写/分句去重，避免破坏表格结构
    if (isMarkdownTableLine(trimmed)) {
      out.push(trimmed);
      continue;
    }

    const isListLine = /^[-*•|]|\d+[.)、]/u.test(trimmed);
    let candidate = isListLine ? trimmed : rewriteLine(trimmed);
    if (!candidate) continue;

    if (!isListLine) {
      candidate = stripRepeatedClauses(candidate, seenClauses);
      if (!candidate) continue;
    }

    const normalized = normalizeStructuredLine(candidate);
    if (normalized && seenLines.has(normalized)) continue;

    out.push(candidate);
    if (normalized) seenLines.add(normalized);
    if (!isListLine) rememberClauses(candidate, seenClauses);
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return cleanSpacing(out.join("\n"));
}

function cleanPlainReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const seenSentences: Array<{ raw: string; normalized: string; tokens: string[] }> = [];
  const seenClauses = new Set<string>();
  let followUpUsed = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }

    let candidate = rewriteLine(trimmed);
    if (!candidate) continue;

    candidate = stripRepeatedClauses(candidate, seenClauses);
    if (!candidate) continue;

    const deduped = dedupePlainLine(candidate, seenSentences, {
      allowFollowUp: !followUpUsed,
    });
    if (!deduped.text) continue;

    out.push(deduped.text);
    rememberClauses(deduped.text, seenClauses);
    if (deduped.keptFollowUp) followUpUsed = true;
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return cleanSpacing(out.join("\n"));
}

function rewriteLine(line: string): string {
  let out = line.trim();
  if (!out) return out;

  for (const [pattern, replacement] of LEADING_CLEANUPS) {
    out = out.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of CLICHES) {
    out = out.replace(pattern, replacement);
  }

  out = out
    .replace(/^[：:，。！？\-\s]+/u, "")
    .replace(/^(非常|真的|确实)?(抱歉|不好意思)[，。！？\s]*/u, "抱歉，")
    .replace(/^(嗯|唔)[，。！？\s]*/u, "")
    .trim();

  return out;
}

function looksListLike(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return false;
  return lines.filter((line) => /^[-*•|]|\d+[.)、]/.test(line.trim())).length >= 2;
}

export function humanizeAssistantText(
  text: string,
  opts?: {
    userText?: string;
  },
): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed.includes("[CONTENT_SUMMARY_V2_START]")) return text;
  if (looksListLike(trimmed)) return cleanStructuredReply(trimmed);

  const tone = detectAssistantToneMode(opts?.userText);
  let out = cleanPlainReply(trimmed);
  if (!out) return text;

  if (tone === "direct") {
    out = out
      .replace(/^我先看一下[，。！？\s]*/u, "")
      .replace(/^我先判断一下[，。！？\s]*/u, "")
      .replace(/^我直接说[，。！？\s]*/u, "");
  }

  if (tone === "soft") {
    out = out.replace(/^抱歉，/u, "");
  }

  return cleanSpacing(out);
}
