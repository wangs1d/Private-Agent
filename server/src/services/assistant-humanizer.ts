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
  if (looksListLike(trimmed)) return cleanSpacing(trimmed);

  const tone = detectAssistantToneMode(opts?.userText);
  const lines = trimmed.split(/\r?\n/);
  const rewritten = lines.map(rewriteLine).filter(Boolean);

  let out = cleanSpacing(rewritten.join("\n"));
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
