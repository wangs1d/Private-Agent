import { reduceExecution } from "tokenjuice";

import { getTokenJuiceMaxToolChars, isTokenJuiceEnabled } from "./env.js";
import type { ToolOutputCompactInput, ToolOutputCompactOutput } from "./types.js";

function hardTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max - 32)).trimEnd();
  return `${head}\n... [truncated ${text.length - head.length} chars]`;
}

function resolveMaxChars(input: ToolOutputCompactInput): number {
  const envMax = getTokenJuiceMaxToolChars();
  const preferred = input.preferredMaxChars;
  if (typeof preferred === "number" && Number.isFinite(preferred) && preferred > 200) {
    return Math.min(Math.floor(preferred), envMax);
  }
  return envMax;
}

function buildStructuredFallback(rawText: string, maxChars: number): string {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return hardTruncate(rawText, maxChars);
    }

    const value = parsed as Record<string, unknown>;
    const preferredKeys = [
      "ok",
      "summary",
      "message",
      "title",
      "name",
      "id",
      "url",
      "path",
      "status",
      "state",
      "error",
      "code",
      "count",
      "total",
      "price",
      "currency",
      "timestamp",
    ];

    const compact: Record<string, unknown> = {};
    for (const key of preferredKeys) {
      if (key in value) compact[key] = value[key];
    }

    for (const [key, entry] of Object.entries(value)) {
      if (key in compact) continue;
      if (Array.isArray(entry)) {
        compact[key] = entry.slice(0, 5);
        continue;
      }
      if (entry && typeof entry === "object") {
        compact[key] = "[object]";
        continue;
      }
      if (typeof entry === "string" && entry.length <= 200) {
        compact[key] = entry;
      }
    }

    const text = JSON.stringify(compact);
    return text.length <= maxChars ? text : hardTruncate(text, maxChars);
  } catch {
    return hardTruncate(rawText, maxChars);
  }
}

function stripKeys(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) continue;
    if (Array.isArray(entry)) {
      out[key] = entry.map((item) => stripKeys(item, keys)).slice(0, 10);
      continue;
    }
    if (entry && typeof entry === "object") {
      out[key] = stripKeys(entry, keys);
      continue;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * 将工具 JSON 结果压缩后写入 LLM tool 消息。
 * 优先保留结构化字段；压缩失败时退回到结构化降级，而不是简单截断。
 */
export async function compactToolOutputForLlm(
  input: ToolOutputCompactInput,
): Promise<ToolOutputCompactOutput> {
  const rawPayload = input.ok
    ? stripKeys(input.result, input.stripKeys ?? [])
    : stripKeys({ ok: false, error: input.result.error ?? input.result }, input.stripKeys ?? []);
  const rawText = JSON.stringify(rawPayload);
  const rawBytes = Buffer.byteLength(rawText, "utf8");
  const maxChars = resolveMaxChars(input);

  if (!isTokenJuiceEnabled()) {
    const content = buildStructuredFallback(rawText, maxChars);
    return {
      content,
      rawBytes,
      compactBytes: Buffer.byteLength(content, "utf8"),
      compacted: content.length < rawText.length,
    };
  }

  try {
    const result = await reduceExecution(
      {
        toolName: input.toolName,
        combinedText: rawText,
        exitCode: input.ok ? 0 : 1,
      },
      {
        cwd: process.cwd(),
        maxInlineChars: maxChars,
      },
    );
    const content = hardTruncate(result.inlineText?.trim() || rawText, maxChars);
    return {
      content,
      rawBytes,
      compactBytes: Buffer.byteLength(content, "utf8"),
      ruleId: result.trace?.matchedReducer ?? result.classification.matchedReducer,
      compacted: content.length < rawText.length,
    };
  } catch {
    const content = buildStructuredFallback(rawText, maxChars);
    return {
      content,
      rawBytes,
      compactBytes: Buffer.byteLength(content, "utf8"),
      compacted: content.length < rawText.length,
    };
  }
}

/** 压缩 observe / ingest 用短文本 */
export async function compactObserveLine(toolName: string, line: string): Promise<string> {
  const out = await compactToolOutputForLlm({
    toolName,
    ok: true,
    result: { line },
  });
  return out.content;
}
