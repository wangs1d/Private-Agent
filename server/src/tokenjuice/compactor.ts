import { reduceExecution } from "tokenjuice";

import { getTokenJuiceMaxToolChars, isTokenJuiceEnabled } from "./env.js";
import type { ToolOutputCompactInput, ToolOutputCompactOutput } from "./types.js";

function hardTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max - 32)).trimEnd();
  return `${head}\n... [truncated ${text.length - head.length} chars]`;
}

/**
 * 判定 `reduceExecution` 返回的 inlineText 是否是「char 截断后的破损 JSON」。
 *
 * 根因：search_web/info.* 等工具的 result 是结构化 JSON（`{"items":[{title,url,...}]}`）。
 * 若按字符硬切（`hardTruncate`），会把 `"https://..."` 前缀切断、把数组切到一半，
 * LLM 看到的就是「{"items":[{"title":"...","url":"movie.douban.com dapp=..."}, ...}`
 * + 末尾 `[truncated N chars]` 的残破 JSON。它会把这段直接复制到 reply.text，
 * 即使后端 `detectRawSearchResultJson` 兜底也校验不过（URL 缺 https:// 前缀），
 * 用户看到的就是「`{...}... [truncated 870 chars]`」式脏展示。
 *
 * 这里判断「inlineText 是 rawText 的 char 截断副本」的特征：
 *   - inlineText 末尾含 `... [truncated N chars]` 标记（hardTruncate 的产物）
 *   - inlineText 是 rawText 的前缀子串（说明是直接 slice 的）
 *   - rawText 本体可解析为 JSON
 *
 * 命中任一即视为「破损 JSON」，改走结构感知压缩（buildStructuredFallback）。
 */
function isBrokenJsonSlice(inlineText: string, rawText: string): boolean {
  const t = inlineText.trim();
  if (!t) return true;
  // 0. 末尾含硬截断标记 → 几乎可以确定是 char 截断
  if (/\.\.\.\s*\[truncated\s+\d+\s+chars\]\s*$/i.test(t)) {
    // rawText 本身必须是 JSON 才视为「破损 JSON」；否则就是长文本本身被切，
    // 走正常截断没问题
    try {
      JSON.parse(rawText);
      return true;
    } catch {
      return false;
    }
  }
  return false;
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
      "hint",
      "retryable",
    ];

    /**
     * 把 items 数组按 maxItems 截短（深拷贝，避免影响原对象）。
     * 根因：buildStructuredFallback 若一次性序列化结果仍超 maxChars，
     * 旧逻辑会调用 hardTruncate 把 JSON 从中间切断，喂给 LLM 后又会被
     * 复制到 reply.text 形成脏展示。这里改为逐步缩减 items 数量（5 → 3 → 1）
     * 直到 JSON 完整塞进预算，保证结构永远合法。
     */
    const trimItemsArray = (
      arr: unknown[],
      maxItems: number,
    ): unknown[] => arr.slice(0, maxItems).map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const rec = entry as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec)) {
          if (typeof v === "string" && v.length > 200) {
            // 长字符串直接截到 200（不再原样保留超长 snippet/snippet）
            out[k] = v.slice(0, 200) + "…";
          } else {
            out[k] = v;
          }
        }
        return out;
      }
      return entry;
    });

    const buildCompact = (itemsCap: number): string => {
      const compact: Record<string, unknown> = {};
      for (const key of preferredKeys) {
        if (key in value) compact[key] = value[key];
      }
      for (const [key, entry] of Object.entries(value)) {
        if (key in compact) continue;
        if (Array.isArray(entry)) {
          compact[key] = trimItemsArray(entry, itemsCap);
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
      return JSON.stringify(compact);
    };

    // items 数组递减：5 → 3 → 2 → 1，直到 JSON 完整塞进 maxChars
    const CAPS = [5, 3, 2, 1];
    for (const cap of CAPS) {
      const text = buildCompact(cap);
      if (text.length <= maxChars) return text;
    }
    // 极端情况（即使 items=1 仍超长）：返回 items=1 + 顶层长字符串截断的版本
    // 若仍超长才退化到 hardTruncate（此时宁切字符也不喂原始 26K 巨无霸）
    const minimal = buildCompact(1);
    return minimal.length <= maxChars ? minimal : hardTruncate(minimal, maxChars);
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
    : stripKeys({
        ok: false,
        error: input.result.error ?? input.result,
        ...(typeof input.result === "object" && input.result != null && "hint" in (input.result as Record<string, unknown>)
          ? { hint: (input.result as Record<string, unknown>).hint }
          : {}),
      }, input.stripKeys ?? []);
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
    const inlineRaw = result.inlineText?.trim() || rawText;
    // 根因修复：若 tokenjuice 给的 inlineText 是对原始 JSON 的 char 截断（末尾
    // 挂着 `[truncated N chars]` 标记、且 rawText 本体是 JSON），就退回到
    // 结构感知压缩（buildStructuredFallback），不要把残破 JSON 喂给 LLM——
    // 它会原样复制到 reply.text 形成脏展示。
    const content = isBrokenJsonSlice(inlineRaw, rawText)
      ? buildStructuredFallback(rawText, maxChars)
      : hardTruncate(inlineRaw, maxChars);
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
