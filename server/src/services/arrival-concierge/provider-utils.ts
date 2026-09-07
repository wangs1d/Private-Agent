import type { TripStatusQuery, TripStatusResult } from "./types.js";

/**
 * 在任意嵌套 JSON 对象里按候选 key（大小写不敏感）深度查找第一个字符串值。
 * 航旅/聚合类数据供应商字段命名不统一且会改版，这里做宽容解析，
 * 找不到时返回 null，由上层决定降级策略。
 */
export function deepPickString(value: unknown, candidates: string[], depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepPickString(item, candidates, depth + 1);
      if (hit != null) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (candidates.some((c) => lower === c || lower.endsWith(c))) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number" && Number.isFinite(v)) return String(v);
      }
    }
    for (const key of Object.keys(obj)) {
      const hit = deepPickString(obj[key], candidates, depth + 1);
      if (hit != null) return hit;
    }
  }
  return null;
}

/** 通用 JSON POST（超时 + 不抛异常）。 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data: unknown = await res.json().catch(() => null);
    if (data == null) return { ok: false, error: "响应不是合法 JSON" };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 通用 JSON GET（超时 + 不抛异常）。 */
export async function getJson(
  url: string,
  timeoutMs = 10_000,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data: unknown = await res.json().catch(() => null);
    if (data == null) return { ok: false, error: "响应不是合法 JSON" };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 把 provider 快照归一为统一结果（供各 provider 复用）。 */
export function normalizeResult(
  partial: Omit<Extract<TripStatusResult, { ok: true }>, "ok">,
): TripStatusResult {
  return { ok: true, ...partial };
}

export type { TripStatusQuery, TripStatusResult };
