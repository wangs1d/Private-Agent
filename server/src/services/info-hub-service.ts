import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import {
  discoverHtmlSourcesFromResults,
  fetchDomesticNews,
  fetchDomesticOfficialNews,
  fetchDomesticTechNews,
  filterItemsByRelevance,
  searchBingChina,
  searchBingChinaRelaxed,
  type DomesticFetchOptions,
} from "./domestic-web-providers.js";
import { fetchWebPageEnhanced, extractWithReadability, decodeWithEncoding } from "./web-fetch-enhancer.js";
import {
  SearchCache,
  RssHealthMonitor,
  classifySearchIntent,
  SessionSearchCache,
  sortByQuality,
  applySearchFreshness,
  withRetry,
  type IntentAnalysis,
} from "./search-enhancements.js";

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
  // 真实浏览器 UA，避免被反爬识别（IT之家/36氪 等会拒绝自定义 UA）
  private readonly userAgent =
    process.env.WEB_FETCH_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  // 搜索结果缓存（LRU + TTL）
  private readonly searchCache = new SearchCache<InfoSearchItem[]>({
    maxSize: Number(process.env.SEARCH_CACHE_SIZE ?? 200),
    ttlMs: Number(process.env.SEARCH_CACHE_TTL_MS ?? 5 * 60 * 1000),
  });
  // RSS 源健康检查
  private readonly rssHealth = new RssHealthMonitor();
  // 同会话跨查询复用
  private readonly sessionCache = new SessionSearchCache();
  // 网页内容缓存（LRU + TTL 10 分钟）
  private readonly pageContentCache = new SearchCache<string>({
    maxSize: 100,
    ttlMs: 10 * 60 * 1000,
  });
  private readonly pageContentCacheFull = new SearchCache<{ html: string; text: string }>({
    maxSize: 50,
    ttlMs: 10 * 60 * 1000,
  });

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

  async search(query: string, limit = 12, sessionId?: string): Promise<InfoSearchItem[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(25, limit)) : 12;

    // 意图识别：影响搜索策略
    const intent = classifySearchIntent(keyword);
    const effectiveLimit = Math.max(boundedLimit, intent.suggestedLimit ?? 0);

    // 1. 会话内复用（相似查询直接返回之前结果）
    if (sessionId) {
      const reusable = this.sessionCache.findReusable(sessionId, keyword);
      if (reusable && reusable.length > 0) {
        return reusable.slice(0, effectiveLimit);
      }
    }

    // 2. 缓存命中检查（相同 query 直接返回）
    const cacheKey = `${keyword}:${effectiveLimit}`;
    const cached = this.searchCache.getWithStats(cacheKey);
    if (cached) {
      return cached;
    }

    // 3. 实际搜索
    const domesticOpts: DomesticFetchOptions = { userAgent: this.userAgent, rssHealth: this.rssHealth };
    const isTechKeyword = /科技|技术|ai|芯片|互联网|数码|it\b/i.test(keyword);
    const isNewsKeyword = intent.intent === "latest" || intent.requiresFreshWeb;

    // 必应对长查询效果差，用核心实体构造简洁查询
    // 关键修复：classifySearchIntent 已经按「具体性优先级」排好序（字母+数字 > 中文+数字 > 中英混合 > 短中文 > 纯英文），
    // 不能简单地按长度重排（会破坏顺序，例如「今天A股最新消息」按长度会拿到「最新消息」而不是「A股」）。
    // 策略：取第一个「够长且有信息量」的实体；过短（≤1 字符）或过于泛化（仅含时效词）的实体跳过。
    let bingQuery = keyword;
    const stopwordEntity = /^(最新|最近|今日|今天|现在|目前|刚刚|新闻|消息|资讯|事件|发生|动态|头条|怎么|如何|什么|情况)$/i;
    const bestEntity = intent.entities.find(
      (e) => e.length >= 2 && !stopwordEntity.test(e),
    );
    if (bestEntity && keyword.length > 6) {
      // 实体存在且短于原 query（避免退化），优先用实体
      bingQuery = bestEntity;
    }

    // 4. 第一轮：实体化查询（精准）+ 科技/官方 RSS（按关键词）
    //    同时并行发起完整原始 query 搜索（第二轮回退），避免串行等待
    const bingPromises: Promise<InfoSearchItem[]>[] = [
      searchBingChina(bingQuery, effectiveLimit, domesticOpts),
    ];
    if (bingQuery !== keyword) {
      bingPromises.push(searchBingChina(keyword, effectiveLimit, domesticOpts));
    }
    const [bingResults, tech, official] = await Promise.all([
      Promise.all(bingPromises),
      isTechKeyword ? fetchDomesticTechNews(keyword, Math.min(8, effectiveLimit), domesticOpts) : Promise.resolve([] as InfoSearchItem[]),
      isNewsKeyword ? fetchDomesticOfficialNews(keyword, Math.min(12, effectiveLimit), domesticOpts) : Promise.resolve([] as InfoSearchItem[]),
    ]);

    let merged = dedupeByUrl([...official, ...bingResults.flat(), ...tech]); // 官方媒体 RSS 排前面（实时性更高）

    // 5. 第二轮扩搜：结果偏少时就主动放宽，不等到完全 0 条
    const sparseThreshold = Math.min(effectiveLimit, Math.max(4, Math.ceil(effectiveLimit * 0.6)));
    if (merged.length < sparseThreshold) {
      const fallbackQueries = [
        keyword,
        bingQuery,
        ...intent.entities.slice(1, 3),
      ]
        .map((value) => value.trim())
        .filter(Boolean);
      const relaxedBatches = await Promise.all(
        [...new Set(fallbackQueries)].slice(0, 3).map((value) =>
          searchBingChinaRelaxed(value, effectiveLimit, domesticOpts),
        ),
      );
      const relaxedMerged = dedupeByUrl(relaxedBatches.flat());
      if (relaxedMerged.length > 0) {
        // 宽松扩搜（skipRelevanceFilter）可能带回与主题无关的噪音（如必应对短实体/单字母的误匹配，
        // 例：query「今天A股最新消息」会混入 AcFun/Ascii 等含「A」的结果）。
        // 扩宽条数后这类噪音会被一起带进来，这里用相关性过滤兜底，保留真正相关的结果。
        const relevant = filterItemsByRelevance(relaxedMerged, keyword);
        if (relevant.length > 0) {
          merged = dedupeByUrl([...merged, ...relevant]);
        }
      }
    }

    // 动态源发现：当预定义源 + 必应结果不足时，从已有搜索结果中识别新闻网站，
    // 自动爬取其首页拿到实时新闻（必应索引有延迟，首页是实时更新的）
    const allBingResults = dedupeByUrl(bingResults.flat());
    if (merged.length < effectiveLimit && allBingResults.length > 0) {
      const discovered = await discoverHtmlSourcesFromResults(allBingResults, keyword, domesticOpts);
      if (discovered.length > 0) {
        merged = dedupeByUrl([...merged, ...discovered]);
      }
    }

    // 质量评分排序：相关性(50%) + 权威度(30%) + 时效性(20%)
    const scored = sortByQuality(merged, keyword);
    const result = applySearchFreshness(scored, { query: keyword }).items.slice(0, effectiveLimit);

    // 4. 写入缓存 + 会话记录
    // 时效性查询缓存时间更短（1 分钟），非时效性查询用默认 TTL
    const ttlOverride = isNewsKeyword ? 60 * 1000 : undefined;
    this.searchCache.set(cacheKey, result, ttlOverride);
    if (sessionId) {
      this.sessionCache.record(sessionId, keyword, result);
    }

    return result;
  }

  async fetchNews(topic: string, limit = 8): Promise<InfoSearchItem[]> {
    const query = topic.trim();
    if (!query) return [];
    // 增强后的国内新闻：必应 + 科技 RSS + 官方媒体 RSS（已内置并行 + 新鲜度排序 + 健康检查）
    return fetchDomesticNews(query, limit, { userAgent: this.userAgent, rssHealth: this.rssHealth });
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
      // 优先用 Readability 提取正文（质量更高），失败时降级到正则
      let content = "";
      try {
        const readabilityResult = extractWithReadability(html, current.url);
        content = readabilityResult.text.length >= 100 ? readabilityResult.text : htmlToText(html);
      } catch {
        content = htmlToText(html);
      }
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": this.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!response.ok) {
        throw new Error(`网页读取失败: ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") ?? "";
      // 复用 web-fetch-enhancer 的编码检测逻辑（支持 GBK/GB2312）
      return decodeWithEncoding(buffer, contentType);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readPageAsText(url: string): Promise<string> {
    // 缓存命中：直接返回（TTL 10 分钟）
    const cached = this.pageContentCache.get(url);
    if (cached) return cached;

    // 抓取 + 指数退避重试（网络波动时自动重试 2 次）
    const result = await withRetry(() =>
      fetchWebPageEnhanced(
        url,
        { userAgent: this.userAgent, timeoutMs: 10_000 },
        (html) => htmlToText(html),
      ),
    );
    const text = result.text.slice(0, 10000);
    this.pageContentCache.set(url, text);
    return text;
  }

  private async readPageContent(url: string): Promise<{ html: string; text: string }> {
    // 缓存命中：直接返回（TTL 10 分钟）
    const cached = this.pageContentCacheFull.get(url);
    if (cached) return cached;

    const result = await withRetry(() =>
      fetchWebPageEnhanced(
        url,
        { userAgent: this.userAgent, timeoutMs: 10_000 },
        (html) => htmlToText(html),
      ),
    );
    const data = {
      html: result.html,
      text: result.text.slice(0, 10000),
    };
    this.pageContentCacheFull.set(url, data);
    return data;
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
  // 1. 移除 HTML 注释
  let cleaned = html.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. 移除噪音标签（导航、页脚、侧边栏、广告等非正文区域）
  const NOISE_TAGS = [
    "nav", "footer", "aside",
    "noscript", "svg", "canvas", "iframe", "object", "embed",
    "template", "dialog", "modal", "popup",
    "script", "style",
  ];
  for (const tag of NOISE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  // 3. 移除常见广告/推广区域（通过 class/id 属性识别）
  // 匹配包含广告关键词的 div/section/aside 标签块
  const adKeywords = "ad[s]?|banner|sponsor|promo|widget|sidebar|cookie[- ]?consent|newsletter|social[- ]?share|related[- ]?post|comment|disqus";
  cleaned = cleaned.replace(
    new RegExp(`<(div|section|aside)[^>]*(?:class|id)[^>]*(${adKeywords})[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
    " ",
  );
  // 匹配任意标签中含广告关键词的 class/id 属性
  cleaned = cleaned.replace(
    new RegExp(`<[^>]+(?:class|id)[^>]*["']\\s*(${adKeywords})\\s*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, "gi"),
    " ",
  );

  // 4. 保留语义化内容标签的文本，其余标签替换为空格
  const CONTENT_TAGS = new Set([
    "main", "article", "section",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "td", "th", "dd", "dt",
    "blockquote", "pre", "code", "figcaption", "caption",
    "span", "a", "strong", "em", "b", "i", "u", "mark", "time",
    "label", "option", "summary", "details",
  ]);

  let result = "";
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(cleaned)) !== null) {
    // 标签前的纯文本
    if (match.index > lastIndex) {
      result += cleaned.slice(lastIndex, match.index);
    }
    const tagName = match[1].toLowerCase();
    const isClosingTag = match[0].startsWith("</");

    // 内容标签：闭合时加换行分隔
    if (CONTENT_TAGS.has(tagName)) {
      if (isClosingTag && /^(p|h[1-6]|li|tr|dd|dt|figcaption|caption|blockquote|pre)$/.test(tagName)) {
        result += "\n";
      } else if (!isClosingTag && /^(h[1-6])$/.test(tagName)) {
        result += "\n"; // 标题前换行
      }
      // 其他内容标签内的文本自然保留
    } else {
      // 非内容标签替换为空格
      result += " ";
    }
    lastIndex = match.index + match[0].length;
  }

  // 处理末尾剩余文本
  if (lastIndex < cleaned.length) {
    result += cleaned.slice(lastIndex);
  }

  return decodeHtmlEntities(result)
    .replace(/[ \t]+/g, " ")       // 多空格/制表符合并
    .replace(/\n[ \t]+\n/g, "\n")   // 空行中的空格清理
    .replace(/\n{3,}/g, "\n\n")     // 超过2个连续空行压缩为2个
    .trim();
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

