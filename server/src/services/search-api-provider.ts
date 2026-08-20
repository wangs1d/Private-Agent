import type { InfoSearchItem } from "./info-hub-service.js";

/**
 * 搜索 API 提供方抽象。
 *
 * 目标：把「稳定、不封 IP」的搜索 API 作为主力搜索源，替代纯爬网页（必应/百度/搜狗/DDG）。
 * 通过环境变量配置，支持 Tavily / Serper / Bing Web Search / Jina 四种提供方：
 *   - SEARCH_API_PROVIDER=tavily|serper|bing|jina（不设 = 关闭，走爬网页兜底）
 *   - SEARCH_API_KEY=可复用的 API Key（Tavily / Serper / Bing 通用；Jina 用 JINA_API_KEY）
 *
 * 行为约定：
 *   - 未配置任何提供方 → 返回 null（调用方应跳过 API，继续走爬网页链）
 *   - 已配置但请求失败 → 返回 []（调用方优雅降级到多引擎爬网页）
 *   - 成功 → 返回去重后的 InfoSearchItem[]（不超过 limit）
 */

export type SearchApiProviderType = "tavily" | "serper" | "bing" | "jina" | "anysearch" | "none";

export type SearchApiConfig = {
  provider: SearchApiProviderType;
  /** 通用 key（Tavily / Serper / Bing / AnySearch） */
  apiKey: string;
  /** Jina 专属 key（可空，免费额度无需 key） */
  jinaKey: string;
  /** Bing 自定义端点（可选） */
  bingEndpoint: string;
  /** AnySearch zone（cn | intl） */
  anysearchZone: string;
  /** AnySearch 偏好语言（如 zh-CN） */
  anysearchLang: string;
};

const SEARCH_API_TIMEOUT_MS = 8000;
const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/v1/search";
const DEFAULT_BING_ENDPOINT = "https://api.cognitive.microsoft.com/bing/v7.0/search";

function normalizeProvider(raw: string | undefined): SearchApiProviderType {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "tavily" || v === "serper" || v === "bing" || v === "jina" || v === "anysearch") return v;
  return "none";
}

export function getSearchApiConfig(env: NodeJS.ProcessEnv = process.env): SearchApiConfig {
  return {
    provider: normalizeProvider(env.SEARCH_API_PROVIDER),
    apiKey: (env.SEARCH_API_KEY ?? "").trim(),
    jinaKey: (env.JINA_API_KEY ?? "").trim(),
    bingEndpoint: (env.BING_SEARCH_API_ENDPOINT ?? DEFAULT_BING_ENDPOINT).trim() || DEFAULT_BING_ENDPOINT,
    anysearchZone: (env.ANYSEARCH_ZONE ?? "cn").trim() || "cn",
    anysearchLang: (env.ANYSEARCH_LANG ?? "zh-CN").trim() || "zh-CN",
  };
}

/** 通过搜索 API 搜索。未配置 → null；配置但失败 → []；成功 → 结果数组。 */
export async function searchViaSearchApi(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InfoSearchItem[] | null> {
  const keyword = query.trim();
  if (!keyword) return [];
  const cfg = getSearchApiConfig(env);
  const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit) || 8));

  if (cfg.provider === "none") {
    console.warn(`[SearchApi] 未配置 SEARCH_API_PROVIDER(或值非法)，联网搜索走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return null;
  }
  if (cfg.provider !== "jina" && !cfg.apiKey) {
    console.warn(`[SearchApi] provider=${cfg.provider} 已配置但缺少 SEARCH_API_KEY，走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return null;
  }

  console.log(`[SearchApi] 请求 ${cfg.provider}  查询="${keyword.slice(0, 40)}"  limit=${boundedLimit}`);
  switch (cfg.provider) {
    case "tavily":
      return searchTavily(keyword, boundedLimit, cfg.apiKey);
    case "serper":
      return searchSerper(keyword, boundedLimit, cfg.apiKey);
    case "bing":
      return searchBingApi(keyword, boundedLimit, cfg.apiKey, cfg.bingEndpoint);
    case "jina":
      return searchJina(keyword, boundedLimit, cfg.jinaKey);
    case "anysearch":
      return searchAnySearch(keyword, boundedLimit, cfg.apiKey, cfg.anysearchZone, cfg.anysearchLang);
    default:
      return null;
  }
}

/** 图片搜索失败器：未配置/缺 key/请求失败 → 空数组（调用方优雅降级到爬网页）。 */
export type ImageApiItem = {
  title: string;
  mediaUrl: string;
  thumbnailUrl?: string;
  pageUrl?: string;
  source?: string;
};

/**
 * 通过已接入的搜索 API 搜图。未配置 → []；配置但失败 → []；成功 → 图片项数组。
 * 与 searchViaSearchApi 同源：优先用接入的 provider 拿真实图源 URL，爬图片网页仅作兜底。
 */
export async function searchImagesViaSearchApi(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ImageApiItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const cfg = getSearchApiConfig(env);
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(limit) || 8));

  if (cfg.provider === "none") {
    console.warn(`[SearchApi] 未配置 SEARCH_API_PROVIDER(或值非法)，图片搜索走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return [];
  }
  if (cfg.provider !== "jina" && !cfg.apiKey) {
    console.warn(`[SearchApi] provider=${cfg.provider} 已配置但缺少 SEARCH_API_KEY，图片搜索走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return [];
  }

  console.log(`[SearchApi] 图片搜索 ${cfg.provider}  查询="${keyword.slice(0, 40)}"  limit=${boundedLimit}`);
  switch (cfg.provider) {
    case "tavily":
      return searchTavilyImages(keyword, boundedLimit, cfg.apiKey);
    case "serper":
      return searchSerperImages(keyword, boundedLimit, cfg.apiKey);
    case "bing":
      return searchBingImages(keyword, boundedLimit, cfg.apiKey, cfg.bingEndpoint);
    // Jina / AnySearch 无稳定的图片搜索端点 → 返回空数组，回退到爬图片网页兜底。
    case "jina":
    case "anysearch":
    default:
      return [];
  }
}

async function searchTavilyImages(query: string, limit: number, apiKey: string): Promise<ImageApiItem[]> {
  const json = await requestJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.max(limit, 5),
      include_answer: false,
      include_raw_content: false,
      include_images: true,
    }),
  });
  if (!isObj(json)) return [];
  const images = Array.isArray((json as Record<string, unknown>).images)
    ? ((json as Record<string, unknown>).images as unknown[])
    : [];
  const out: ImageApiItem[] = [];
  const seen = new Set<string>();
  for (const img of images) {
    const url = str(img);
    const low = url.toLowerCase();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(low)) continue;
    seen.add(low);
    out.push({ title: query, mediaUrl: url, thumbnailUrl: url });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? withSource(out, "Tavily") : [];
}

async function searchSerperImages(query: string, limit: number, apiKey: string): Promise<ImageApiItem[]> {
  const json = await requestJson("https://google.serper.dev/images", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ q: query, num: Math.max(limit, 10), gl: "cn", hl: "zh-cn" }),
  });
  if (!isObj(json)) return [];
  const images = Array.isArray((json as Record<string, unknown>).images)
    ? ((json as Record<string, unknown>).images as unknown[])
    : [];
  const out: ImageApiItem[] = [];
  const seen = new Set<string>();
  for (const item of images) {
    if (!isObj(item)) continue;
    const mediaUrl = str((item as Record<string, unknown>).imageUrl);
    const low = mediaUrl.toLowerCase();
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl) || seen.has(low)) continue;
    seen.add(low);
    out.push({
      title: str((item as Record<string, unknown>).title) || query,
      mediaUrl,
      thumbnailUrl: str((item as Record<string, unknown>).thumbnailUrl) || mediaUrl,
      pageUrl: str((item as Record<string, unknown>).link),
    });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? withSource(out, "Serper") : [];
}

async function searchBingImages(
  query: string,
  limit: number,
  apiKey: string,
  endpoint: string,
): Promise<ImageApiItem[]> {
  // 由已配置的 Bing 搜索端点推导图片端：`.../search` → `.../images/search`
  const imageEndpoint = endpoint.replace(/\/search$/, "/images/search");
  const url = `${imageEndpoint}?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}&mkt=zh-CN`;
  const json = await requestJson(url, {
    method: "GET",
    headers: { "ocp-apim-subscription-key": apiKey },
  });
  if (!isObj(json)) return [];
  const value = Array.isArray((json as Record<string, unknown>).value)
    ? ((json as Record<string, unknown>).value as unknown[])
    : [];
  const out: ImageApiItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObj(item)) continue;
    const rec = item as Record<string, unknown>;
    const mediaUrl = str(rec.contentUrl);
    const low = mediaUrl.toLowerCase();
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl) || seen.has(low)) continue;
    seen.add(low);
    out.push({
      title: str(rec.name) || query,
      mediaUrl,
      thumbnailUrl: str(rec.thumbnailUrl) || mediaUrl,
      pageUrl: str(rec.hostPageUrl),
    });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? withSource(out, "Bing API") : [];
}

function withSource(items: ImageApiItem[], source: string): ImageApiItem[] {
  return items.map((it) => ({ ...it, source: it.source || source }));
}

async function requestJson(url: string, init: RequestInit, timeoutMs = SEARCH_API_TIMEOUT_MS): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const label = `${init.method ?? "GET"} ${url}`;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      console.warn(`[SearchApi] 请求失败 HTTP ${response.status} ${response.statusText} -> ${label}`);
      return null;
    }
    const text = await response.text();
    if (!text) {
      console.warn(`[SearchApi] 响应为空 -> ${label}`);
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      console.warn(`[SearchApi] 响应非合法 JSON -> ${label}  body=${text.slice(0, 120)}`);
      return null;
    }
  } catch (e) {
    console.warn(`[SearchApi] 请求异常/超时(${timeoutMs}ms) -> ${label}  err=${(e as Error)?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toItems(
  items: Array<{ title?: string; url?: string; snippet?: string; date?: string }>,
  source: string,
  limit: number,
): InfoSearchItem[] {
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const title = (item.title ?? "").trim();
    const url = (item.url ?? "").trim();
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 180),
      url,
      snippet: (item.snippet ?? "").slice(0, 220),
      source,
      publishedAt: item.date,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchTavily(query: string, limit: number, apiKey: string): Promise<InfoSearchItem[]> {
  const body = {
    api_key: apiKey,
    query,
    search_depth: "advanced" as const,
    max_results: Math.max(limit, 5),
    include_answer: false,
    include_raw_content: false,
  };
  const json = await requestJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!isObj(json)) return [];
  const results = Array.isArray((json as Record<string, unknown>).results)
    ? ((json as Record<string, unknown>).results as unknown[])
    : [];
  const mapped = results
    .filter(isObj)
    .map((r) => ({
      title: str(r.title),
      url: str(r.url),
      snippet: str(r.content),
      date: str((r as Record<string, unknown>).published_date),
    }));
  return toItems(mapped, "Tavily", limit);
}

async function searchSerper(query: string, limit: number, apiKey: string): Promise<InfoSearchItem[]> {
  const json = await requestJson("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ q: query, num: Math.max(limit, 10), gl: "cn", hl: "zh-cn" }),
  });
  if (!isObj(json)) return [];
  const organic = Array.isArray((json as Record<string, unknown>).organic)
    ? ((json as Record<string, unknown>).organic as unknown[])
    : [];
  const mapped = organic.filter(isObj).map((r) => ({
    title: str(r.title),
    url: str(r.link),
    snippet: str(r.snippet),
    date: str((r as Record<string, unknown>).date),
  }));
  return toItems(mapped, "Serper", limit);
}

async function searchBingApi(
  query: string,
  limit: number,
  apiKey: string,
  endpoint: string,
): Promise<InfoSearchItem[]> {
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}&mkt=zh-CN`;
  const json = await requestJson(url, {
    method: "GET",
    headers: { "ocp-apim-subscription-key": apiKey },
  });
  if (!isObj(json)) return [];
  const webPages = (json as Record<string, unknown>).webPages;
  if (!isObj(webPages)) return [];
  const value = Array.isArray((webPages as Record<string, unknown>).value)
    ? ((webPages as Record<string, unknown>).value as unknown[])
    : [];
  const mapped = value.filter(isObj).map((r) => ({
    title: str(r.name),
    url: str(r.url),
    snippet: str(r.snippet),
    date: str((r as Record<string, unknown>).datePublished),
  }));
  return toItems(mapped, "Bing API", limit);
}

async function searchJina(query: string, limit: number, jinaKey: string): Promise<InfoSearchItem[]> {
  // Jina 免费搜索端点（无需 key 也有基础额度；提供 key 可提额）。
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-respond-with": "no-content",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  if (jinaKey) headers.authorization = `Bearer ${jinaKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return [];
    const text = await response.text();
    if (!text) return [];
    // s.jina.ai 返回 JSON Lines：每行一个 JSON 对象，含 url / title / description
    const items: Array<{ title?: string; url?: string; snippet?: string; date?: string }> = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        if (!obj || typeof obj !== "object") continue;
        items.push({ title: str(obj.title), url: str(obj.url), snippet: str(obj.description), date: str(obj.date) });
      } catch {
        // 跳过不可解析行
      }
    }
    return toItems(items, "Jina", limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchAnySearch(
  query: string,
  limit: number,
  apiKey: string,
  zone: string,
  lang: string,
): Promise<InfoSearchItem[]> {
  // 对 Agent 的下一代统一搜索基础设施：POST /v1/search，Bearer 认证。
  // 返回 data.results[{ title, url, snippet, content }]，含清洗后的正文，对中文与垂直领域友好。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_API_TIMEOUT_MS);
  try {
    const response = await fetch(ANYSEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: Math.max(limit, 5),
        zone: zone === "intl" ? "intl" : "cn",
        language: lang,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const text = await response.text();
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return [];
    }
    if (!isObj(parsed)) return [];
    // 成功响应：code===0 且 data.results 为数组；非 0 视为业务失败
    const rec = parsed as Record<string, unknown>;
    if (rec.code !== 0) return [];
    const data = rec.data;
    if (!isObj(data)) return [];
    const results = Array.isArray((data as Record<string, unknown>).results)
      ? ((data as Record<string, unknown>).results as unknown[])
      : [];
    const mapped = results.filter(isObj).map((r) => {
      const snippet = str(r.snippet);
      const content = str(r.content);
      return {
        title: str(r.title),
        url: str(r.url),
        snippet: snippet || content,
        date: "",
      };
    });
    return toItems(mapped, "AnySearch", limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}