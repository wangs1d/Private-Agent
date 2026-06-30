/**
 * 托盘本地 IPC HTTP 客户端（仅 127.0.0.1）。
 *
 * 主服务通过这个模块唤起 Python 托盘悬浮窗 / 探活。
 * 失败一律抛 TrayControlError，调用方决定怎么回给前端。
 */
import { setTimeout as delay } from "node:timers/promises";

export type TrayHotkeys = {
  live?: string;
  continuous?: string;
  clear?: string;
};

export type TrayHealth = {
  ok: boolean;
  service: string;
  version: string;
  pid: number;
  port: number;
  hotkeys: TrayHotkeys;
};

const DEFAULT_CONTROL_PORT = 8766;
const REQUEST_TIMEOUT_MS = 2_000;

export class TrayControlError extends Error {
  readonly cause?: unknown;
  readonly code: "timeout" | "unreachable" | "bad_status" | "bad_response";
  constructor(code: TrayControlError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "TrayControlError";
    this.code = code;
    this.cause = cause;
  }
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

export function resolveTrayControlBaseUrl(): string {
  const port = envInt("TRANSLATE_TRAY_CONTROL_PORT", DEFAULT_CONTROL_PORT);
  // 仅 127.0.0.1，不接受外部覆盖，避免被注入
  return `http://127.0.0.1:${port}`;
}

async function trayFetch(
  base: string,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.message.includes("aborted"))) {
      throw new TrayControlError("timeout", `托盘 IPC 超时（${timeoutMs}ms）`, e);
    }
    throw new TrayControlError("unreachable", `托盘 IPC 不可达：${e instanceof Error ? e.message : String(e)}`, e);
  } finally {
    clearTimeout(timer);
  }
}

export async function trayHealth(): Promise<TrayHealth> {
  const base = resolveTrayControlBaseUrl();
  let resp: Response;
  try {
    resp = await trayFetch(base, "/health", { method: "GET" }, 1_500);
  } catch (e) {
    if (e instanceof TrayControlError) throw e;
    throw new TrayControlError("unreachable", String(e), e);
  }
  if (!resp.ok) {
    throw new TrayControlError("bad_status", `托盘 IPC /health HTTP ${resp.status}`);
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch (e) {
    throw new TrayControlError("bad_response", "托盘 IPC 响应非 JSON", e);
  }
  if (!data || typeof data !== "object" || !(data as { ok?: unknown }).ok) {
    throw new TrayControlError("bad_response", "托盘 IPC 响应缺少 ok=true");
  }
  return data as TrayHealth;
}

export async function trayShowWindow(payload: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/show-window", payload);
}

export async function trayEnterLive(): Promise<{ ok: boolean; error?: string }> {
  // /enter-live 在托盘侧是 /enter-select 的兼容别名
  return trayPostJson("/enter-live", {});
}

export async function trayEnterSelect(): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/enter-select", {});
}

export type TrayAddResultPayload = {
  card_id?: string;
  source_text?: string;
  target_text?: string;
  lang_label?: string;
  lang?: string;
  mode?: string;
};

export async function trayAddResult(payload: TrayAddResultPayload): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/add-result", payload as Record<string, unknown>);
}

export async function trayClear(): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/clear", {});
}

export async function traySetLanguage(lang: string): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/set-language", { lang });
}

export async function traySetShowSource(show: boolean): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/set-show-source", { show: Boolean(show) });
}

export async function traySetFontSize(size: number): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/set-font-size", { size });
}

export async function trayToggleSubtitle(): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/toggle-subtitle", {});
}

export async function trayCollapse(): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/collapse", {});
}

export async function trayClosePanel(): Promise<{ ok: boolean; error?: string }> {
  return trayPostJson("/close", {});
}

/**
 * 通用 POST 调用：发 JSON body，解析 { ok, error? } 响应。
 * 失败一律返回 { ok: false, error }，不抛异常（调用方只需看 ok 字段）。
 */
async function trayPostJson(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const base = resolveTrayControlBaseUrl();
  let resp: Response;
  try {
    resp = await trayFetch(
      base,
      path,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      },
      timeoutMs,
    );
  } catch (e) {
    if (e instanceof TrayControlError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: String(e) };
  }
  if (!resp.ok) {
    return { ok: false, error: `托盘 IPC ${path} HTTP ${resp.status}` };
  }
  try {
    const data = (await resp.json()) as { ok?: boolean; error?: string };
    return { ok: Boolean(data.ok), error: data.error };
  } catch (e) {
    return { ok: false, error: `托盘 IPC 响应解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 探活：尝试调一次 /health。返回结构化结果，不抛异常。
 */
export async function trayProbe(): Promise<{
  alive: boolean;
  error?: string;
  health?: TrayHealth;
}> {
  try {
    const health = await trayHealth();
    return { alive: true, health };
  } catch (e) {
    return { alive: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 单元测试 / 自检用。 */
export const _internals = { trayFetch, delay };
