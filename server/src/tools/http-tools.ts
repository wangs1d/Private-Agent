/**
 * HTTP 请求工具（等价 curl）：让 agent 能发起任意 HTTP 调用，对接外部 API / Webhook。
 *
 * 设计要点：
 * - SSRF 防护：拒绝内网地址（127.0.0.1, localhost, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1）
 * - body 截断：默认 8KB，避免 token 爆炸；可配置 maxBytes
 * - 超时：默认 15s，上限 60s
 * - 重定向：默认跟随最多 5 次
 * - 安全 header：authorization/cookie 等敏感字段在响应中脱敏
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolRegistry } from "./tool-registry.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 8 * 1024; // 8KB
const MAX_REDIRECTS = 5;

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
type HttpMethod = (typeof ALLOWED_METHODS)[number];

/** 敏感响应头：返回给 LLM 时脱敏。 */
const SENSITIVE_RESP_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
]);

interface HttpRequestInput {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number | null;
  maxBytes?: number | null;
  followRedirects?: boolean | null;
}

function isPrivateIp(ip: string): boolean {
  // IPv4 内网段
  if (isIP(ip) === 4) {
    if (ip === "127.0.0.1" || ip === "0.0.0.0") return true;
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    if (ip.startsWith("169.254.")) return true; // link-local
    // 172.16.0.0/12
    const parts = ip.split(".").map(Number);
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  }
  // IPv6 内网
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::") return true;
    if (ip.toLowerCase().startsWith("fe80:")) return true; // link-local
    if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) return true; // ULA
    return false;
  }
  return false;
}

async function assertSafeUrl(urlStr: string): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: `无效 URL: ${urlStr}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `仅支持 http/https 协议，拒绝 ${parsed.protocol}` };
  }
  const host = parsed.hostname;
  // 如果 host 是 IP，直接判定
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      return { ok: false, error: `SSRF 防护：拒绝访问内网 IP ${host}` };
    }
    return { ok: true, url: parsed };
  }
  // 域名：DNS 解析后判定（防 DNS rebinding 也防基本内网域）
  if (/^localhost$/i.test(host)) {
    return { ok: false, error: "SSRF 防护：拒绝访问 localhost" };
  }
  if (/\.local$/i.test(host) || /^internal\.|^intranet\./i.test(host)) {
    return { ok: false, error: `SSRF 防护：拒绝访问内网域名 ${host}` };
  }
  try {
    const addresses = await lookup(host, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return { ok: false, error: `SSRF 防护：${host} 解析到内网 IP ${addr.address}` };
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `DNS 解析失败: ${message}` };
  }
  return { ok: true, url: parsed };
}

function truncateBody(body: string, maxBytes: number): { text: string; truncated: boolean; originalLength: number } {
  const originalLength = Buffer.byteLength(body, "utf8");
  if (originalLength <= maxBytes) {
    return { text: body, truncated: false, originalLength };
  }
  // 按字节截断（避免半截 UTF-8 字符）
  const buf = Buffer.from(body, "utf8");
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return { text: sliced, truncated: true, originalLength };
}

export function registerHttpTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register("http.request", async (input) => {
    const req = input as HttpRequestInput;
    const urlStr = String(req.url ?? "").trim();
    if (!urlStr) {
      return { ok: false, error: "缺少 url 参数" };
    }

    const method = String(req.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.includes(method as HttpMethod)) {
      return { ok: false, error: `不支持的 method: ${method}（允许: ${ALLOWED_METHODS.join("/")}）` };
    }

    // SSRF 校验
    const safe = await assertSafeUrl(urlStr);
    if (!safe.ok) {
      return { ok: false, error: safe.error };
    }

    const timeoutMs = Math.min(
      Math.max(Number(req.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
      MAX_TIMEOUT_MS,
    );
    const maxBytes = Math.min(
      Math.max(Number(req.maxBytes) || DEFAULT_MAX_BYTES, 512),
      64 * 1024, // 硬上限 64KB
    );
    const followRedirects = req.followRedirects !== false;

    const headers: Record<string, string> = {};
    if (req.headers && typeof req.headers === "object") {
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
    }

    const body = req.body ?? null;
    const startedAt = Date.now();

    try {
      // 用 AbortController 控制超时；redirect 手动跟随以便注入 maxRedirects 上限
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        let currentUrl = safe.url.toString();
        let remainingRedirects = followRedirects ? MAX_REDIRECTS : 0;
        let resp: Response;
        // 手动重定向循环（fetch 的 redirect:"manual" 返回 Location 但不跟随，便于限制次数）
        while (true) {
          resp = await fetch(currentUrl, {
            method,
            headers,
            body: body ?? undefined,
            redirect: "manual",
            signal: ac.signal,
          });
          // fetch 在 redirect:"manual" 时返回 status 3xx 且 Location 在 headers
          const status = resp.status;
          if (status >= 300 && status < 400 && remainingRedirects > 0) {
            const loc = resp.headers.get("location");
            if (!loc) break;
            currentUrl = new URL(loc, currentUrl).toString();
            remainingRedirects -= 1;
            // 重定向请求不要带 body（GET/HEAD）
            continue;
          }
          break;
        }

        const text = await resp.text();
        const elapsedMs = Date.now() - startedAt;

        // fetch headers 是 Headers，转成 Record
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          respHeaders[k] = SENSITIVE_RESP_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v;
        });

        const truncated = truncateBody(text, maxBytes);
        const contentType = resp.headers.get("content-type") ?? "";
        const isJson = contentType.toLowerCase().includes("application/json");

        return {
          ok: true,
          status: resp.status,
          statusText: statusText(resp.status),
          url: currentUrl,
          method,
          headers: respHeaders,
          body: truncated.text,
          bodyTruncated: truncated.truncated,
          bodyOriginalBytes: truncated.originalLength,
          ...(isJson ? { bodyJson: tryParseJson(truncated.text) } : {}),
          timing: { totalMs: elapsedMs },
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const elapsedMs = Date.now() - startedAt;
      return {
        ok: false,
        error: message,
        url: safe.url.toString(),
        method,
        timing: { totalMs: elapsedMs },
      };
    }
  });
}

function statusText(code: number): string {
  // 仅列常用
  const map: Record<number, string> = {
    200: "OK", 201: "Created", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict",
    413: "Payload Too Large", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return map[code] ?? "";
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
