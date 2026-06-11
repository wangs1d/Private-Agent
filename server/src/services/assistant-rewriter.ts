import type { ExternalChatProvider } from "../external-model/types.js";
import { detectAssistantToneMode } from "./assistant-tone-policy.js";

function isEnabled(): boolean {
  const raw = (process.env.AGENT_HUMAN_REWRITE_ENABLED ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function maxChars(): number {
  const n = Number.parseInt(process.env.AGENT_HUMAN_REWRITE_MAX_CHARS ?? "360", 10);
  return Number.isFinite(n) && n >= 120 ? n : 360;
}

function shouldRewrite(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > maxChars()) return false;
  if (trimmed.includes("[CONTENT_SUMMARY_V2_START]")) return false;
  if (/\n\s*(?:[-*•|]|\d+[.)、])/.test(trimmed)) return false;
  return true;
}

function normalizeAnchor(value: string): string {
  return value.trim().toLowerCase();
}

function extractFactAnchors(text: string): string[] {
  const anchors = new Set<string>();
  const patterns = [
    /\bhttps?:\/\/[^\s]+/gi,
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /\b\d{1,2}:\d{2}\b/g,
    /\b\d+(?:\.\d+)?%/g,
    /\b\d+(?:\.\d+)?(?:ms|s|m|h|km|元|块|点|条|个|次)\b/gi,
    /\b[A-Z][A-Z0-9_-]{1,}\b/g,
    /\b\d+(?:\.\d+)?\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.match(pattern) ?? []) {
      anchors.add(normalizeAnchor(match));
    }
  }

  return [...anchors].filter(Boolean);
}

function preservesFactAnchors(base: string, rewritten: string): boolean {
  const anchors = extractFactAnchors(base);
  if (anchors.length === 0) return true;
  const normalized = normalizeAnchor(rewritten);
  let missing = 0;
  for (const anchor of anchors) {
    if (!normalized.includes(anchor)) missing += 1;
  }
  return missing / anchors.length <= 0.34;
}

function compactText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

export class AssistantRewriterService {
  constructor(private readonly provider: ExternalChatProvider | null) {}

  async rewriteIfNeeded(userText: string, assistantText: string): Promise<string> {
    const base = compactText(assistantText.trim());
    if (!isEnabled() || !this.provider?.isEnabled() || !shouldRewrite(base)) {
      return base;
    }

    const tone = detectAssistantToneMode(userText);
    const prompt = [
      "你是中文回复润色器，只改表达，不改事实，不补信息，不删关键结论。",
      "目标：把回复改得更像真人接话，口语自然，短一点，少客服腔，少说明书味道。",
      `本轮语气温度：${tone}。steady=稳，soft=更柔和，direct=更利落，light=更轻松。`,
      "硬性要求：",
      "1. 不新增事实，不改原意，不改结论。",
      "2. 默认像微信聊天，少用“以下是”“总的来说”“我来帮你分析一下”这类 AI 腔。",
      "3. 可以接一句，但要克制，不演绎，不鸡汤，不扩写。",
      "4. 除非原文更短，否则不要把它改长。",
      "5. 数字、时间、百分比、链接、英文术语、专有名词尽量原样保留。",
      "6. 只输出改写后的最终回复，不要解释。",
      "",
      `用户刚才说：${userText.trim().slice(0, 220)}`,
      `原回复：${base}`,
    ].join("\n");

    let out = "";
    try {
      await this.provider.streamCompletion(
        `assistant-rewrite:${Date.now()}`,
        { text: prompt },
        (delta) => {
          out += delta;
        },
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          systemPromptOverride:
            "你是轻量口语润色器。只改表达，不改事实，不加新信息，默认更短、更自然、更像真人接话。",
          modelOverride: process.env.AGENT_HUMAN_REWRITE_MODEL?.trim() || undefined,
          maxThreadMessages: 2,
        },
      );
    } catch {
      return base;
    }

    const rewritten = compactText(out);
    if (!rewritten) return base;
    if (rewritten.length > Math.max(base.length + 24, Math.floor(base.length * 1.18))) return base;
    if (!preservesFactAnchors(base, rewritten)) return base;
    return rewritten;
  }
}
