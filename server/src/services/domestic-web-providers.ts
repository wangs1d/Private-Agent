import type { InfoSearchItem } from "./info-hub-service.js";

const BING_CN_SEARCH = "https://cn.bing.com/search";
const DEFAULT_TIMEOUT_MS = 18_000;

const DOMESTIC_TECH_RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "36氪", url: "https://36kr.com/feed" },
  { source: "IT之家", url: "https://www.ithome.com/rss/" },
];

export type DomesticFetchOptions = {
  userAgent: string;
  timeoutMs?: number;
};

/** 必应中国 RSS 搜索（国内网络通常可达）。 */
export async function searchBingChina(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];

  const rssUrl = `${BING_CN_SEARCH}?q=${encodeURIComponent(keyword)}&format=rss`;
  const xml = await fetchText(rssUrl, opts);
  if (!xml) return [];

  const items = parseRssItems(xml)
    .slice(0, limit)
    .map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.description.slice(0, 220),
      source: "必应中国",
      publishedAt: item.pubDate,
    }));
  if (items.length > 0) return items;

  const htmlUrl = `${BING_CN_SEARCH}?q=${encodeURIComponent(keyword)}`;
  const html = await fetchText(htmlUrl, opts);
  if (!html) return [];
  return extractBingHtmlResults(html).slice(0, limit);
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
  return merged.slice(0, limit);
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
  return dedupeByUrl([...bing, ...tech]).slice(0, limit);
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
