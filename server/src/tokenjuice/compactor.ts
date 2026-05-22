import { reduceExecution } from "tokenjuice";

import { getTokenJuiceMaxToolChars, isTokenJuiceEnabled } from "./env.js";
import type { ToolOutputCompactInput, ToolOutputCompactOutput } from "./types.js";

function hardTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 将工具 JSON 结果压缩后写入 LLM tool 消息（对齐 OpenHuman TokenJuice 闸门）。
 */
export async function compactToolOutputForLlm(
  input: ToolOutputCompactInput,
): Promise<ToolOutputCompactOutput> {
  const rawPayload = input.ok ?
      input.result
    : { ok: false, error: input.result.error ?? input.result };
  const rawText = JSON.stringify(rawPayload);
  const rawBytes = Buffer.byteLength(rawText, "utf8");

  if (!isTokenJuiceEnabled()) {
    const content = hardTruncate(rawText, getTokenJuiceMaxToolChars());
    return {
      content,
      rawBytes,
      compactBytes: Buffer.byteLength(content, "utf8"),
      compacted: false,
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
        maxInlineChars: getTokenJuiceMaxToolChars(),
      },
    );
    const content = hardTruncate(
      result.inlineText?.trim() || rawText,
      getTokenJuiceMaxToolChars(),
    );
    return {
      content,
      rawBytes,
      compactBytes: Buffer.byteLength(content, "utf8"),
      ruleId: result.trace?.matchedReducer ?? result.classification.matchedReducer,
      compacted: content.length < rawText.length,
    };
  } catch {
    const content = hardTruncate(rawText, getTokenJuiceMaxToolChars());
    return {
      content,
      rawBytes,
      compactBytes: Buffer.byteLength(content, "utf8"),
      compacted: false,
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
