/**
 * 笔记的 LLM 辅助方法（摘要 / 抽问 / 记忆卡片）。
 * 抽出独立模块以便单测与复用。输入是 content 字符串，输出是结构化数据。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import type { NoteFlashcard, NoteQuiz } from "./notes-service.js";

type ChatProviderLike = Pick<ExternalChatProvider, "streamCompletion" | "isEnabled">;

const SYSTEM_PROMPT = "你是一名严谨的中文学习笔记助手，仅基于用户提供的内容作答，不引入未在文中出现的事实。";

function extractJsonBlock(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    // 截取首个 { ... } 或 [ ... ]
    const obj = candidate.match(/\{[\s\S]*\}/);
    if (obj) {
      try { return JSON.parse(obj[0]); } catch { /* fallthrough */ }
    }
    const arr = candidate.match(/\[[\s\S]*\]/);
    if (arr) {
      try { return JSON.parse(arr[0]); } catch { /* fallthrough */ }
    }
    return null;
  }
}

function safeString(v: unknown, max = 2000): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

function clampCards<T extends { q?: string; question?: string; a?: string; answer?: string }>(
  arr: unknown,
  map: (raw: { q?: string; a?: string; question?: string; answer?: string }) => { ok: true; v: T } | { ok: false } | null,
  max: number,
): T[] {
  if (!Array.isArray(arr)) return [];
  const out: T[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const mapped = map(item as { q?: string; a?: string; question?: string; answer?: string });
    if (mapped && "ok" in mapped && mapped.ok) {
      out.push(mapped.v);
      if (out.length >= max) break;
    }
  }
  return out;
}

export async function generateNoteSummary(
  chat: ChatProviderLike | null,
  sessionId: string,
  title: string,
  content: string,
): Promise<string> {
  if (!chat?.isEnabled()) {
    // LLM 未配置：退化为前 280 字符摘要
    const flat = content.replace(/\s+/g, " ").trim();
    return flat.length <= 280 ? flat : `${flat.slice(0, 279)}…`;
  }
  const prompt = [
    SYSTEM_PROMPT,
    `请基于下方笔记正文，输出 1-3 句中文摘要（合计 80-200 字），用 JSON 格式：{"summary": "..."}。`,
    `标题：${title}`,
    "正文：",
    content,
  ].join("\n");
  const text = await chat.streamCompletion(sessionId, { text: prompt }, () => {});
  const parsed = extractJsonBlock(text);
  if (parsed && typeof parsed === "object") {
    const s = safeString((parsed as Record<string, unknown>).summary, 1000);
    if (s) return s;
  }
  // 兜底：取非 JSON 的纯文本
  return safeString(text, 500) ?? content.slice(0, 280);
}

export async function generateNoteFlashcards(
  chat: ChatProviderLike | null,
  sessionId: string,
  title: string,
  content: string,
  count = 5,
): Promise<NoteFlashcard[]> {
  const max = Math.max(1, Math.min(20, count));
  if (!chat?.isEnabled()) {
    // 退化为：直接把首句作为 q，整段作为 a
    const firstLine = content.split(/[。！？\n]/)[0]?.trim() || title;
    return [{ q: firstLine.slice(0, 80), a: safeString(content, 240) ?? "" }];
  }
  const prompt = [
    SYSTEM_PROMPT,
    `请基于下方笔记生成 ${max} 张记忆卡片（问题+答案），用 JSON 格式：{"cards":[{"q":"...","a":"..."}, ...]}。`,
    "要求：问题具体可回忆、答案不超过 80 字、覆盖核心概念。",
    `标题：${title}`,
    "正文：",
    content,
  ].join("\n");
  const text = await chat.streamCompletion(sessionId, { text: prompt }, () => {});
  const parsed = extractJsonBlock(text);
  if (parsed && typeof parsed === "object") {
    const arr = (parsed as Record<string, unknown>).cards;
    return clampCards<NoteFlashcard>(arr, (raw) => {
      const q = safeString(raw.q, 160);
      const a = safeString(raw.a, 200);
      if (!q || !a) return { ok: false };
      return { ok: true, v: { q, a } };
    }, max);
  }
  return [];
}

export async function generateNoteQuiz(
  chat: ChatProviderLike | null,
  sessionId: string,
  title: string,
  content: string,
  count = 3,
): Promise<NoteQuiz[]> {
  const max = Math.max(1, Math.min(20, count));
  if (!chat?.isEnabled()) {
    return [];
  }
  const prompt = [
    SYSTEM_PROMPT,
    `请基于下方笔记生成 ${max} 道自测题，用 JSON 格式：{"quiz":[{"question":"...","answer":"..."}, ...]}。`,
    "要求：题目围绕关键概念，答案简明（不超过 100 字），可包含简答/概念辨析。",
    `标题：${title}`,
    "正文：",
    content,
  ].join("\n");
  const text = await chat.streamCompletion(sessionId, { text: prompt }, () => {});
  const parsed = extractJsonBlock(text);
  if (parsed && typeof parsed === "object") {
    const arr = (parsed as Record<string, unknown>).quiz;
    return clampCards<NoteQuiz>(arr, (raw) => {
      const q = safeString(raw.question ?? raw.q, 200);
      const a = safeString(raw.answer ?? raw.a, 240);
      if (!q || !a) return { ok: false };
      return { ok: true, v: { question: q, answer: a } };
    }, max);
  }
  return [];
}
