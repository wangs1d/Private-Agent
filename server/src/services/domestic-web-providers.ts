import type { InfoSearchItem } from "./info-hub-service.js";
import {
  applySearchFreshness,
  prependRecencyQueryVariants,
} from "./search-freshness.js";

const BING_CN_SEARCH = "https://cn.bing.com/search";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_QUERY_VARIANTS = 4;

const DOMESTIC_TECH_RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "36氪", url: "https://36kr.com/feed" },
  { source: "IT之家", url: "https://www.ithome.com/rss/" },
];

export type DomesticFetchOptions = {
  userAgent: string;
  timeoutMs?: number;
};

/** 必应中国搜索（并行变体 + 快速返回）。长句会误匹配，故自动简化 query 并过滤无关结果。 */
export async function searchBingChina(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];

  const allVariants = prependRecencyQueryVariants(buildSearchQueryVariants(keyword), keyword);
  const variants = allVariants.slice(0, MAX_QUERY_VARIANTS);
  const minHits = Math.min(3, limit);

  if (variants.length === 0) return [];

  const timeoutPerVariant = calculateTimeoutPerVariant(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, variants.length);

  const results = await Promise.allSettled(
    variants.map((variant) =>
      fetchBingChinaOnceWithTimeout(variant, limit, { ...opts, timeoutMs: timeoutPerVariant }),
    ),
  );

  let bestFallback: InfoSearchItem[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled" || result.value.length === 0) continue;
    const relevant = filterItemsByRelevance(result.value, keyword);
    if (relevant.length === 0) continue;
    const fresh = applySearchFreshness(relevant, { query: keyword }).items;
    if (fresh.length >= minHits) return fresh.slice(0, limit);
    if (fresh.length > bestFallback.length) bestFallback = fresh;
  }

  return applySearchFreshness(bestFallback, { query: keyword }).items.slice(0, limit);
}

function calculateTimeoutPerVariant(totalBudgetMs: number, variantCount: number): number {
  const safeCount = Math.max(1, variantCount);
  const perVariant = Math.floor(totalBudgetMs / safeCount);
  const minPerVariant = 3_000;
  const maxPerVariant = 10_000;
  return Math.max(minPerVariant, Math.min(maxPerVariant, perVariant));
}

async function fetchBingChinaOnceWithTimeout(
  keyword: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  try {
    return await fetchBingChinaOnce(keyword, limit, opts);
  } catch {
    return [];
  }
}

async function fetchBingChinaOnce(
  keyword: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const rssUrl = `${BING_CN_SEARCH}?q=${encodeURIComponent(keyword)}&format=rss`;
  const xml = await fetchText(rssUrl, opts);
  if (xml) {
    const fromRss = parseRssItems(xml).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.description.slice(0, 220),
      source: "必应中国",
      publishedAt: item.pubDate,
    }));
    if (fromRss.length > 0) return fromRss;
  }

  const htmlUrl = `${BING_CN_SEARCH}?q=${encodeURIComponent(keyword)}`;
  const html = await fetchText(htmlUrl, opts);
  if (!html) return [];
  return extractBingHtmlResults(html);
}

/** 从自然语言任务句中抽出 3-10 字中文专名（如「调研航天电子这家公司」→「航天电子」）。 */
export function extractPrimaryChineseEntity(query: string): string | null {
  let core = query
    .trim()
    .replace(/^(调研|查询|搜索|了解|介绍|分析|对比|看看|帮我|请)+/u, "")
    .replace(/(这家公司|该公司|公司|股份|集团|有限|怎么样|如何|的主营|主营业务|业务|情况)+$/u, "")
    .trim();
  if (core.length >= 3 && core.length <= 10 && /^[\u4e00-\u9fff]+$/u.test(core)) return core;
  const runs = [...query.matchAll(/[\u4e00-\u9fff]{4,8}/gu)].map((m) => m[0]!);
  for (const run of runs.sort((a, b) => b.length - a.length)) {
    if (SEARCH_STOPWORDS.has(run)) continue;
    if (/^(这家|那家|如何|怎么)/u.test(run)) continue;
    return run;
  }
  return null;
}

/** 长 query 在必应上易误匹配（如「航天电子…主营业务」→ 宏观航天新闻），生成短查询变体。优化：限制变体数量并按优先级排序。 */
export function buildSearchQueryVariants(query: string): string[] {
  const raw = query.trim();
  if (!raw) return [];

  const variants: string[] = [];
  const push = (v: string) => {
    const t = v.trim();
    if (t && !variants.includes(t) && variants.length < MAX_QUERY_VARIANTS) variants.push(t);
  };

  const priorityVariants: string[] = [];

  for (const m of raw.matchAll(/["'「『]([^"'」』]+)["'」』]/g)) {
    priorityVariants.push(m[1] ?? "");
  }

  const stockCode = raw.match(/\b[036]\d{5}\b/)?.[0];
  if (stockCode) priorityVariants.push(stockCode);

  const entity = extractPrimaryChineseEntity(raw);

  if (entity) {
    priorityVariants.push(`"${entity}"`);
    if (/公司|股份|股票|调研|主营|行情|股价|上市|财报/.test(raw)) {
      priorityVariants.push(`${entity} 股票`);
    }
    priorityVariants.push(entity);
    if (stockCode) priorityVariants.push(`${entity} ${stockCode}`);
  }

  for (const v of priorityVariants) {
    push(v);
  }

  if (variants.length >= MAX_QUERY_VARIANTS) return variants;

  const tokens = raw
    .split(/[\s,，、。；;:：/|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));

  if (tokens.length > 0 && variants.length < MAX_QUERY_VARIANTS) {
    const primary = tokens[0]!;
    if (!entity && /^[\u4e00-\u9fff]{3,10}$/u.test(primary)) {
      push(`"${primary}"`);
      if (/公司|股份|股票|调研|主营|行情|股价|上市|财报/.test(raw) && variants.length < MAX_QUERY_VARIANTS) {
        push(`${primary} 股票`);
      }
    }
    if (variants.length < MAX_QUERY_VARIANTS) push(tokens.slice(0, 2).join(" "));
    if (variants.length < MAX_QUERY_VARIANTS) push(primary);
    if (stockCode && variants.length < MAX_QUERY_VARIANTS) push(`${primary} ${stockCode}`);

    if (variants.length < MAX_QUERY_VARIANTS) {
      for (const token of tokens) {
        if (token.length >= 5 && /^[\u4e00-\u9fff]{2}[\u4e00-\u9fff]+$/.test(token)) {
          push(`${token.slice(0, 2)} ${token.slice(2)}`);
          if (tokens[1] && variants.length < MAX_QUERY_VARIANTS) {
            push(`${token.slice(0, 2)} ${token.slice(2)} ${tokens[1]}`);
          }
        }
      }
    }
  }

  if (variants.length < MAX_QUERY_VARIANTS && !variants.includes(raw)) {
    push(raw);
  }

  return variants;
}

const SEARCH_STOPWORDS = new Set([
  "公司",
  "股份",
  "有限",
  "集团",
  "产品",
  "介绍",
  "主营",
  "业务",
  "包括",
  "以及",
  "最新",
  "消息",
  "公告",
  "股价",
  "走势",
  "市值",
  "财务",
  "数据",
  "营收",
  "净利润",
  "概念",
  "板块",
  "行业",
  "地位",
  "优势",
  "竞争",
  "报告",
  "调研",
  "深度",
  "整理",
  "返回",
  "搜索",
  "查询",
  "请",
  "使用",
  "进行",
  "等",
  "年",
]);

/** 按原始 query 过滤误匹配条目（导出供单测）。 */
export function filterItemsByRelevance(items: InfoSearchItem[], query: string): InfoSearchItem[] {
  const anchors = extractRelevanceAnchors(query);
  if (anchors.length === 0) return items;
  const required = [...anchors].sort((a, b) => b.length - a.length)[0]!;
  if (required.length >= 3) {
    return items.filter((item) => {
      const hay = `${item.title}\n${item.snippet}`;
      return hay.includes(required);
    });
  }
  return items.filter((item) => {
    const hay = `${item.title}\n${item.snippet}`;
    return anchors.some((a) => hay.includes(a));
  });
}

function extractRelevanceAnchors(query: string): string[] {
  const anchors: string[] = [];
  const push = (v: string) => {
    const t = v.trim();
    if (t.length >= 2 && !anchors.includes(t)) anchors.push(t);
  };

  const entity = extractPrimaryChineseEntity(query);
  if (entity) push(entity);

  const code = query.match(/\b[036]\d{5}\b/)?.[0];
  if (code) push(code);

  for (const m of query.matchAll(/["'「『]([^"'」』]+)["'」』]/g)) {
    push(m[1] ?? "");
  }

  for (const token of query.split(/[\s,，、。；;:：/|]+/)) {
    const t = token.trim();
    if (t.length < 2 || SEARCH_STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    push(t);
  }

  return anchors;
}

/** 国内科技 RSS 聚合；可按关键词过滤标题/摘要。 */
export async function fetchDomesticTechNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keywords = topic
    .trim()
    .split(/\s+/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 2);
  const perFeed = Math.max(3, Math.ceil(limit / DOMESTIC_TECH_RSS_FEEDS.length) + 2);

  const batches = await Promise.all(
    DOMESTIC_TECH_RSS_FEEDS.map(async (feed) => {
      const xml = await fetchText(feed.url, opts);
      if (!xml) return [] as InfoSearchItem[];
      return parseRssItems(xml).map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.description.slice(0, 220),
        source: feed.source,
        publishedAt: item.pubDate,
      }));
    }),
  );

  let merged = batches.flat();
  if (keywords.length > 0) {
    merged = merged.filter((item) => {
      const hay = `${item.title}\n${item.snippet}`.toLowerCase();
      return keywords.some((k) => hay.includes(k));
    });
  }
  return applySearchFreshness(merged, { query: topic }).items.slice(0, limit);
}

/** 国内新闻：必应 RSS + 科技 RSS。 */
export async function fetchDomesticNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = topic.trim();
  if (!keyword) return [];

  const [bing, tech] = await Promise.all([
    searchBingChina(keyword, limit, opts),
    fetchDomesticTechNews(keyword, Math.min(6, limit), opts),
  ]);
  return applySearchFreshness(dedupeByUrl([...bing, ...tech]), { query: keyword }).items.slice(
    0,
    limit,
  );
}

async function fetchText(url: string, opts: DomesticFetchOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function dedupeByUrl(items: InfoSearchItem[]): InfoSearchItem[] {
  const seen = new Set<string>();
  const out: InfoSearchItem[] = [];
  for (const item of items) {
    const key = item.url.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseRssItems(xml: string): Array<{
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}> {
  const items: Array<{ title: string; link: string; description: string; pubDate?: string }> = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const title = extractXmlTag(block, "title");
    const link = extractXmlTag(block, "link");
    const description = extractXmlTag(block, "description");
    const pubDate = extractXmlTag(block, "pubDate");
    if (!title || !link) continue;
    items.push({ title, link, description, pubDate });
  }
  return items;
}

function extractXmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeHtmlEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : "";
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractBingHtmlResults(html: string): InfoSearchItem[] {
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null = null;
  while ((block = blockRe.exec(html))) {
    const chunk = block[1] ?? "";
    const linkMatch = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href = decodeHtmlEntities(linkMatch[1] ?? "").trim();
    const title = decodeHtmlEntities((linkMatch[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!href || !title || href.startsWith("javascript:")) continue;
    let url: string;
    try {
      url = new URL(href, BING_CN_SEARCH).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const snippetMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? decodeHtmlEntities((snippetMatch[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(
          0,
          220,
        )
      : "";
    out.push({ title, url, snippet, source: "必应中国" });
  }
  return out;
}
