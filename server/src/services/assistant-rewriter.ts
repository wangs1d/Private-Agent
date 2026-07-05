import type { ExternalChatProvider } from "../external-model/types.js";
import { detectAssistantToneMode, type AssistantToneMode } from "./assistant-tone-policy.js";

function isEnabled(): boolean {
  const raw = (process.env.AGENT_HUMAN_REWRITE_ENABLED ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function maxChars(): number {
  const n = Number.parseInt(process.env.AGENT_HUMAN_REWRITE_MAX_CHARS ?? "360", 10);
  return Number.isFinite(n) && n >= 120 ? n : 360;
}

function rewriteTimeoutMs(): number {
  const n = Number.parseInt(process.env.AGENT_HUMAN_REWRITE_TIMEOUT_MS ?? "1800", 10);
  return Number.isFinite(n) && n >= 300 ? n : 1800;
}

function shouldRewrite(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > maxChars()) return false;
  if (trimmed.includes("[CONTENT_SUMMARY_V2_START]")) return false;
  if (/\n\s*(?:[-*•]|\d+[.)、])/u.test(trimmed)) return false;
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
    /\b\d+(?:\.\d+)?(?:ms|s|m|h|km|元|块|次)\b/gi,
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

function keepAtMostOneEmoji(text: string): string {
  let seen = false;
  return text.replace(/\p{Extended_Pictographic}/gu, (match) => {
    if (seen) return "";
    seen = true;
    return match;
  });
}

function normalizeRewriteTone(
  base: string,
  rewritten: string,
  tone: AssistantToneMode,
): string {
  let out = compactText(rewritten);
  if (!out) return out;

  out = out.replace(/[~～]{2,}/g, "~");
  out = out.replace(/([!?！？]){2,}/g, "$1");
  out = out.replace(/([哈呀啦嘛呢哦哎欸诶])\1{1,}/gu, "$1");
  out = keepAtMostOneEmoji(out);

  if (tone === "direct") {
    out = out.replace(/\s*[?？]\s*$/u, "").trim();
  }

  if (!/[\p{Extended_Pictographic}~～]/u.test(base) && tone !== "light") {
    out = out.replace(/[~～]/g, "");
  }

  return compactText(out);
}

function buildRewritePrompt(userText: string, base: string, tone: AssistantToneMode): string {
  return [
    "You are a Chinese dialogue polisher.",
    "Rewrite only the expression. Keep facts, conclusions, and meaning unchanged.",
    "Target feel: like a real person chatting on WeChat, not a customer-service bot.",
    "Do not force a fixed persona. Adapt to this user's wording, emotional temperature, and familiarity in the current conversation.",
    `Tone mode: ${tone}. steady=natural and stable, soft=gentler, direct=more concise, light=more playful.`,
    "You may add human flavor when it fits: humor, light teasing, a little cuteness, emotional color, or one short follow-up question.",
    "But do not force it every turn. The reply should still match the topic and feel natural.",
    "Rules:",
    "1. Do not add new facts, examples, or claims.",
    "2. Keep result first when the original is factual or task-oriented.",
    "3. Make it sound alive and human, but not like a skit or stand-up routine.",
    "4. Avoid customer-service phrasing, report style, markdown headings, and stiff summary openings.",
    "5. Unless the original is shorter, do not make it longer overall.",
    "6. Preserve numbers, dates, links, English terms, proper nouns, and core judgments.",
    "7. Output only the rewritten final reply.",
    "",
    `User said: ${userText.trim().slice(0, 220)}`,
    `Original reply: ${base}`,
  ].join("\n");
}

export class AssistantRewriterService {
  constructor(private readonly provider: ExternalChatProvider | null) {}

  async rewriteIfNeeded(userText: string, assistantText: string): Promise<string> {
    const base = compactText(assistantText.trim());
    if (!isEnabled() || !this.provider?.isEnabled() || !shouldRewrite(base)) {
      return base;
    }

    const tone = detectAssistantToneMode(userText);
    const prompt = buildRewritePrompt(userText, base, tone);

    let out = "";
    try {
      await Promise.race([
        this.provider.streamCompletion(
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
              "You are a lightweight rewrite model. Keep the meaning and facts exactly the same, but make the reply sound more like a real human chat message.",
            modelOverride: process.env.AGENT_HUMAN_REWRITE_MODEL?.trim() || undefined,
            maxThreadMessages: 2,
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("assistant rewrite timeout")), rewriteTimeoutMs()),
        ),
      ]);
    } catch {
      return base;
    }

    const rewritten = normalizeRewriteTone(base, out, tone);
    if (!rewritten) return base;
    if (rewritten.length > Math.max(base.length + 32, Math.floor(base.length * 1.25))) return base;
    if (!preservesFactAnchors(base, rewritten)) return base;
    return rewritten;
  }
}
