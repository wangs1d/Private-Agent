import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import {
  fetchDomesticNews,
  fetchDomesticTechNews,
  searchBingChina,
  type DomesticFetchOptions,
} from "./domestic-web-providers.js";
import { applySearchFreshness } from "./search-freshness.js";

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
    const domesticOpts: DomesticFetchOptions = { userAgent: this.userAgent };

    const isTechKeyword = /科技|技术|ai|芯片|互联网|数码|it\b/i.test(keyword);

    const [web, tech] = await Promise.all([
      searchBingChina(keyword, boundedLimit, domesticOpts),
      isTechKeyword ? fetchDomesticTechNews(keyword, Math.min(6, boundedLimit), domesticOpts) : Promise.resolve([] as InfoSearchItem[]),
    ]);

    if (isTechKeyword && tech.length > 0) {
      return applySearchFreshness(dedupeByUrl([...web, ...tech]), { query: keyword }).items.slice(0, boundedLimit);
    }

    return applySearchFreshness(web, { query: keyword }).items.slice(0, boundedLimit);
  }

  async fetchNews(topic: string, limit = 8): Promise<InfoSearchItem[]> {
    const query = topic.trim();
    if (!query) return [];
    return fetchDomesticNews(query, limit, { userAgent: this.userAgent });
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

  private async readPageAsText(url: string): Promise<string> {
    const html = await this.fetchHtml(url);
    return htmlToText(html).slice(0, 12000);
  }

  private async readPageContent(url: string): Promise<{ html: string; text: string }> {
    const html = await this.fetchHtml(url);
    const text = htmlToText(html).slice(0, 12000);
    return { html, text };
  }
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

function inferTitleFromText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (/^title:/i.test(lines[0])) return lines[0].replace(/^title:/i, "").trim();
  return lines[0].slice(0, 120);
}

