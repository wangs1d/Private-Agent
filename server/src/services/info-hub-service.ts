import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

export type InfoSearchItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
};

export type WebLinkItem = {
  text: string;
  url: string;
  sameHost: boolean;
};

export type SiteNavigateHop = {
  depth: number;
  url: string;
  title: string;
  summary: string;
  matched: boolean;
};

export type TrackedTopic = {
  topicId: string;
  sessionId: string;
  name: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  lastRunAt?: string;
  lastResult?: InfoSearchItem[];
  scheduleTaskId?: string;
};

type PersistedInfoHub = {
  topics?: TrackedTopic[];
};

export class InfoHubService {
  private readonly topics = new Map<string, TrackedTopic>();
  private readonly userAgent =
    "Mozilla/5.0 (compatible; PrivateAIAgent/1.0; +https://example.local/agent)";

  private get persistPath(): string {
    return process.env.INFO_TRACKING_FILE ?? join(process.cwd(), "data", "info-tracking.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedInfoHub;
      this.topics.clear();
      for (const topic of data.topics ?? []) {
        if (topic?.topicId && topic?.sessionId) {
          this.topics.set(topic.topicId, topic);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    await writeFile(
      this.persistPath,
      JSON.stringify({ topics: Array.from(this.topics.values()) }, null, 2),
      "utf8",
    );
  }

  listTopicsBySession(sessionId: string): TrackedTopic[] {
    return Array.from(this.topics.values())
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTopic(input: {
    sessionId: string;
    name: string;
    keywords: string[];
    scheduleTaskId?: string;
  }): Promise<TrackedTopic> {
    const now = new Date().toISOString();
    const topic: TrackedTopic = {
      topicId: randomUUID(),
      sessionId: input.sessionId,
      name: input.name.trim(),
      keywords: input.keywords.map((k) => k.trim()).filter(Boolean),
      createdAt: now,
      updatedAt: now,
      enabled: true,
      scheduleTaskId: input.scheduleTaskId,
    };
    this.topics.set(topic.topicId, topic);
    await this.persist();
    return topic;
  }

  async setEnabled(topicId: string, enabled: boolean): Promise<TrackedTopic> {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new Error("追踪话题不存在");
    }
    topic.enabled = enabled;
    topic.updatedAt = new Date().toISOString();
    this.topics.set(topicId, topic);
    await this.persist();
    return topic;
  }

  async runTopic(topicId: string): Promise<{ topic: TrackedTopic; items: InfoSearchItem[] }> {
    const topic = this.topics.get(topicId);
    if (!topic) throw new Error("追踪话题不存在");
    const query = topic.keywords.join(" ");
    const [news, docs] = await Promise.all([
      this.fetchNews(query, 6),
      this.search(query, 6),
    ]);
    const merged = dedupeByUrl([...news, ...docs]).slice(0, 10);
    topic.lastRunAt = new Date().toISOString();
    topic.lastResult = merged;
    topic.updatedAt = topic.lastRunAt;
    this.topics.set(topicId, topic);
    await this.persist();
    return { topic, items: merged };
  }

  async search(query: string, limit = 8): Promise<InfoSearchItem[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, limit)) : 8;
    const provider = (process.env.INFO_SEARCH_PROVIDER ?? "jina").trim().toLowerCase();
    const [web, hn] = await Promise.all([
      provider === "duckduckgo"
        ? this.searchWebByDuckDuckGo(keyword, boundedLimit)
        : this.searchWebByJina(keyword, boundedLimit),
      this.searchHackerNews(keyword, boundedLimit),
    ]);
    const merged = dedupeByUrl([...web, ...hn]).sort(sortBySourcePriority);
    return merged.slice(0, boundedLimit);
  }

  async fetchNews(topic: string, limit = 8): Promise<InfoSearchItem[]> {
    const query = topic.trim();
    if (!query) return [];
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const response = await fetch(rssUrl);
    if (!response.ok) {
      throw new Error(`新闻获取失败: ${response.status}`);
    }
    const xml = await response.text();
    const items = parseRssItems(xml).slice(0, limit);
    return items.map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.description,
      source: "Google News RSS",
      publishedAt: item.pubDate,
    }));
  }

  async readWebpage(url: string): Promise<{ title: string; content: string; summary: string }> {
    const normalizedUrl = this.normalizeUrl(url);
    const content = await this.readPageAsText(normalizedUrl);
    const title = inferTitleFromText(content) || "Untitled";
    const summary = summarizePlainText(content);
    return { title, content, summary };
  }

  async inspectWebpage(url: string): Promise<{
    title: string;
    summary: string;
    contentPreview: string;
    links: WebLinkItem[];
    sameHostLinks: WebLinkItem[];
  }> {
    const normalizedUrl = this.normalizeUrl(url);
    const { html, text } = await this.readPageContent(normalizedUrl);
    const title = extractTagText(html, "title") || inferTitleFromText(text) || "Untitled";
    const content = text;
    const summary = summarizePlainText(content);
    const links = extractLinks(html, normalizedUrl).slice(0, 30);
    const sameHostLinks = links.filter((x) => x.sameHost).slice(0, 20);
    return {
      title,
      summary,
      contentPreview: content.slice(0, 1200),
      links,
      sameHostLinks,
    };
  }

  async navigateSite(input: {
    startUrl: string;
    goalKeywords?: string[];
    maxDepth?: number;
    maxPages?: number;
    sameHostOnly?: boolean;
  }): Promise<{
    ok: true;
    startUrl: string;
    visitedCount: number;
    found: boolean;
    foundUrl?: string;
    foundTitle?: string;
    goalKeywords: string[];
    hops: SiteNavigateHop[];
  }> {
    const startUrl = this.normalizeUrl(input.startUrl);
    const start = new URL(startUrl);
    const sameHostOnly = input.sameHostOnly ?? true;
    const maxDepth = Math.min(Math.max(Number(input.maxDepth ?? 2) || 2, 0), 5);
    const maxPages = Math.min(Math.max(Number(input.maxPages ?? 20) || 20, 1), 80);
    const goalKeywords = (input.goalKeywords ?? ["注册", "register", "sign up"])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);

    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
    const seen = new Set<string>();
    const hops: SiteNavigateHop[] = [];
    let foundUrl: string | undefined;
    let foundTitle: string | undefined;

    while (queue.length > 0 && seen.size < maxPages) {
      const current = queue.shift()!;
      if (seen.has(current.url)) continue;
      seen.add(current.url);
      let html = "";
      try {
        html = await this.fetchHtml(current.url);
      } catch {
        continue;
      }
      const title = extractTagText(html, "title") || "Untitled";
      const content = htmlToText(html);
      const summary = summarizePlainText(content);
      const links = extractLinks(html, current.url);
      const haystack = `${title}\n${summary}\n${content.slice(0, 2500)}`.toLowerCase();
      const matched = goalKeywords.some((k) => haystack.includes(k));
      hops.push({ depth: current.depth, url: current.url, title, summary, matched });
      if (matched) {
        foundUrl = current.url;
        foundTitle = title;
        break;
      }
      if (current.depth >= maxDepth) continue;
      for (const link of links) {
        if (sameHostOnly && !link.sameHost) continue;
        if (!sameHostOnly) {
          try {
            const u = new URL(link.url);
            if (u.protocol !== "http:" && u.protocol !== "https:") continue;
          } catch {
            continue;
          }
        } else {
          try {
            const u = new URL(link.url);
            if (u.host !== start.host) continue;
          } catch {
            continue;
          }
        }
        if (seen.has(link.url)) continue;
        queue.push({ url: link.url, depth: current.depth + 1 });
      }
    }

    return {
      ok: true,
      startUrl,
      visitedCount: seen.size,
      found: Boolean(foundUrl),
      foundUrl,
      foundTitle,
      goalKeywords,
      hops,
    };
  }

  private normalizeUrl(url: string): string {
    const raw = String(url || "").trim();
    if (!raw) throw new Error("url 不能为空");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("url 格式非法");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("仅支持 http/https");
    }
    return parsed.toString();
  }

  private async fetchHtml(url: string): Promise<string> {
    const mode = (process.env.INFO_WEB_READER_PROVIDER ?? "jina").trim().toLowerCase();
    if (mode === "jina") {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(jinaUrl, {
        headers: {
          "user-agent": this.userAgent,
          "x-no-cache": "true",
        },
      });
      if (response.ok) {
        const text = await response.text();
        return `<html><head><title>${escapeHtmlForTag(
          inferTitleFromText(text) || "Untitled",
        )}</title></head><body><pre>${escapeHtmlForTag(text)}</pre></body></html>`;
      }
    }
    const response = await fetch(url, {
      headers: {
        "user-agent": this.userAgent,
      },
    });
    if (!response.ok) {
      throw new Error(`网页读取失败: ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }

  private async searchWebByDuckDuckGo(query: string, limit: number): Promise<InfoSearchItem[]> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": this.userAgent,
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    return extractDuckDuckGoResults(html).slice(0, limit);
  }

  private async searchWebByJina(query: string, limit: number): Promise<InfoSearchItem[]> {
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": this.userAgent,
        "x-no-cache": "true",
      },
    });
    if (!response.ok) {
      return this.searchWebByDuckDuckGo(query, limit);
    }
    const text = await response.text();
    const items = extractJinaSearchResults(text);
    if (items.length === 0) {
      return this.searchWebByDuckDuckGo(query, limit);
    }
    return items.slice(0, limit);
  }

  private async searchHackerNews(query: string, limit: number): Promise<InfoSearchItem[]> {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = (await response.json()) as {
      hits?: Array<{
        title?: string;
        url?: string;
        story_text?: string;
        created_at?: string;
      }>;
    };
    return (data.hits ?? [])
      .filter((h) => h.url && h.title)
      .map((h) => ({
        title: h.title ?? "Untitled",
        url: h.url ?? "",
        snippet: (h.story_text ?? "").slice(0, 180),
        source: "Hacker News",
        publishedAt: h.created_at,
      }));
  }

  private async readPageAsText(url: string): Promise<string> {
    const mode = (process.env.INFO_WEB_READER_PROVIDER ?? "jina").trim().toLowerCase();
    if (mode === "jina") {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(jinaUrl, {
        headers: {
          "user-agent": this.userAgent,
          "x-no-cache": "true",
        },
      });
      if (response.ok) {
        return (await response.text()).slice(0, 12000);
      }
    }
    const html = await this.fetchHtml(url);
    return htmlToText(html).slice(0, 12000);
  }

  private async readPageContent(url: string): Promise<{ html: string; text: string }> {
    const mode = (process.env.INFO_WEB_READER_PROVIDER ?? "jina").trim().toLowerCase();
    if (mode === "jina") {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(jinaUrl, {
        headers: {
          "user-agent": this.userAgent,
          "x-no-cache": "true",
        },
      });
      if (response.ok) {
        const text = await response.text();
        const html = `<html><head><title>${escapeHtmlForTag(
          inferTitleFromText(text) || "Untitled",
        )}</title></head><body><pre>${escapeHtmlForTag(text)}</pre></body></html>`;
        return { html, text: text.slice(0, 12000) };
      }
    }
    const html = await this.fetchHtml(url);
    const text = htmlToText(html).slice(0, 12000);
    return { html, text };
  }
}

function sortBySourcePriority(a: InfoSearchItem, b: InfoSearchItem): number {
  const rank = (source: string): number => {
    const normalized = source.trim().toLowerCase();
    if (normalized.includes("jina")) return 0;
    if (normalized.includes("duckduckgo")) return 1;
    if (normalized.includes("hacker news")) return 2;
    return 9;
  };
  return rank(a.source) - rank(b.source);
}

function dedupeByUrl(items: InfoSearchItem[]): InfoSearchItem[] {
  const seen = new Set<string>();
  const out: InfoSearchItem[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const key = item.url.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractTagText(html: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = html.match(regex);
  if (!match) return "";
  return decodeHtmlEntities(match[1]).trim();
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const plain = withoutScripts.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(plain).replace(/\s+/g, " ").trim();
}

function summarizePlainText(text: string): string {
  const chunks = text.split(/[。！？.!?]/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length === 0) return "";
  return chunks.slice(0, 3).join("。");
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

function parseRssItems(xml: string): Array<{ title: string; link: string; description: string; pubDate?: string }> {
  const items: Array<{ title: string; link: string; description: string; pubDate?: string }> = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
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

function extractLinks(html: string, baseUrl: string): WebLinkItem[] {
  const out: WebLinkItem[] = [];
  const seen = new Set<string>();
  const base = new URL(baseUrl);
  const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(html))) {
    const hrefRaw = decodeHtmlEntities(m[2] ?? "").trim();
    if (!hrefRaw) continue;
    let abs: URL;
    try {
      abs = new URL(hrefRaw, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    abs.hash = "";
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const text = decodeHtmlEntities((m[3] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    out.push({
      text: text || "(no-text-link)",
      url,
      sameHost: abs.host === base.host,
    });
  }
  return out;
}

function extractDuckDuckGoResults(html: string): InfoSearchItem[] {
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  const re =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<\/div>\s*<\/div>|\n\s*<div class="result__extras">)/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(html))) {
    const href = decodeHtmlEntities(m[1] ?? "").trim();
    const title = decodeHtmlEntities((m[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const block = m[3] ?? "";
    const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a?>/i);
    const snippetRaw = snippetMatch?.[1] ?? block;
    const snippet = decodeHtmlEntities(
      String(snippetRaw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    ).slice(0, 220);
    const direct = tryResolveDuckDuckGoTarget(href);
    if (!direct || !title) continue;
    if (seen.has(direct)) continue;
    seen.add(direct);
    out.push({
      title,
      url: direct,
      snippet,
      source: "DuckDuckGo",
    });
  }
  return out;
}

function tryResolveDuckDuckGoTarget(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      const u = new URL(href);
      if (u.hostname.includes("duckduckgo.com")) {
        const encoded = u.searchParams.get("uddg");
        if (!encoded) return null;
        const decoded = decodeURIComponent(encoded);
        const target = new URL(decoded);
        if (target.protocol !== "http:" && target.protocol !== "https:") return null;
        target.hash = "";
        return target.toString();
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  }
  if (href.startsWith("/l/?")) {
    try {
      const wrapped = new URL(`https://duckduckgo.com${href}`);
      const encoded = wrapped.searchParams.get("uddg");
      if (!encoded) return null;
      const decoded = decodeURIComponent(encoded);
      const target = new URL(decoded);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
      target.hash = "";
      return target.toString();
    } catch {
      return null;
    }
  }
  return null;
}

function inferTitleFromText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (/^title:/i.test(lines[0])) return lines[0].replace(/^title:/i, "").trim();
  return lines[0].slice(0, 120);
}

function escapeHtmlForTag(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractJinaSearchResults(text: string): InfoSearchItem[] {
  const blocks = text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const urlLine = lines.find((line) => /^https?:\/\//i.test(line)) ?? "";
    if (!urlLine) continue;
    let url: URL;
    try {
      url = new URL(urlLine);
    } catch {
      continue;
    }
    url.hash = "";
    const normalizedUrl = url.toString();
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const title = lines[0].replace(/^\d+\.\s*/, "").slice(0, 180);
    const snippet = lines
      .slice(1)
      .filter((x) => !/^https?:\/\//i.test(x))
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 220);
    out.push({
      title: title || normalizedUrl,
      url: normalizedUrl,
      snippet,
      source: "Jina Search",
    });
  }
  return out;
}
