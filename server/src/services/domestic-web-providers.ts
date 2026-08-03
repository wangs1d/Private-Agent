import type { InfoSearchItem } from "./info-hub-service.js";
import {
  applySearchFreshness,
  prependRecencyQueryVariants,
  classifySearchIntent,
  type RssHealthMonitor,
} from "./search-enhancements.js";

const BING_CN_SEARCH = "https://cn.bing.com/search";
const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_QUERY_VARIANTS = 3; // 精简到 3：实体变体(1) + 原文(1) + recency变体(1)，减少并行请求

const DOMESTIC_TECH_RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "36氪", url: "https://36kr.com/feed" },
  { source: "IT之家", url: "https://www.ithome.com/rss/" },
];

// 国内官方/主流媒体 RSS 源（实时性高，分钟级更新）
// 用于 fetchDomesticNews，补充必应 RSS 的实时性不足
// 分类覆盖：滚动新闻（综合）+ 重要新闻 + 国内 + 国际 + 财经 + 社会
const DOMESTIC_NEWS_RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "中国新闻网滚动", url: "http://www.chinanews.com/rss/scroll-news.xml" },
  { source: "中国新闻网要闻", url: "http://www.chinanews.com/rss/importnews.xml" },
  { source: "中国新闻网国内", url: "http://www.chinanews.com/rss/china.xml" },
  { source: "中国新闻网国际", url: "http://www.chinanews.com/rss/world.xml" },
  { source: "中国新闻网财经", url: "http://www.chinanews.com/rss/finance.xml" },
  { source: "中国新闻网社会", url: "http://www.chinanews.com/rss/society.xml" },
  { source: "人民网时政", url: "http://www.people.com.cn/rss/politics.xml" },
  { source: "人民网国际", url: "http://www.people.com.cn/rss/world.xml" },
  { source: "人民网科技", url: "http://www.people.com.cn/rss/IT.xml" },
  // 注：环球网 rss.huanqiu.com 和联合早报 www.zaobao.com/rss/* 实测已失效（返回 HTML 而非 RSS XML），暂不接入
  // 央视网 news.cctv.com/rss/* 也已失效（404）
];

// HTML 新闻源（无 RSS，通过爬取列表页提取）
// URL 中的日期模式用于提取发布时间：
//   央视网: /2026/07/13/ARTIxxx.shtml
//   联合早报: /news/china/story20260712-9352905
//   新浪: /2026-07-13/doc-xxx.shtml
//   中国日报: /a/202607/13/WSxxx.html
//   光明网/中青网: /2026-07/13/content_xxx.htm(l)
//   海外网: /n/2026/0701/cxxx-xxx.html
const DOMESTIC_NEWS_HTML_FEEDS: Array<{ source: string; url: string; baseUrl: string }> = [
  // 精简到 6 个核心源（原 13 个），减少并行 fan-out 同时保持覆盖面
  // 央视网（官方媒体，首页覆盖最全）
  { source: "央视网", url: "https://news.cctv.com/", baseUrl: "https://news.cctv.com" },
  // 联合早报（境外华文媒体）
  { source: "联合早报", url: "https://www.zaobao.com.sg/news/china", baseUrl: "https://www.zaobao.com.sg" },
  // 新浪（门户，综合覆盖面广）
  { source: "新浪", url: "https://news.sina.com.cn/", baseUrl: "https://news.sina.com.cn" },
  // 网易（门户）
  { source: "网易", url: "https://news.163.com/", baseUrl: "https://news.163.com" },
  // 中国日报（官方媒体）
  { source: "中国日报", url: "https://cn.chinadaily.com.cn/", baseUrl: "https://cn.chinadaily.com.cn" },
  // 光明网（官方媒体）
  { source: "光明网", url: "https://news.gmw.cn/", baseUrl: "https://news.gmw.cn" },
];

/**
 * 网站域名注册表（用于动态源发现）
 * 当预定义源结果不足时，从已有搜索结果中识别网站域名，自动爬取相关页面。
 *
 * 分类策略：
 *   - news：新闻网站，爬取首页列表页（拿到比必应索引更新的新闻）
 *   - tech：技术社区，爬取搜索结果中的具体页面，提取相关文章链接
 *   - qa：问答网站，爬取搜索结果中的具体页面，提取相关问题链接
 *   - wiki：百科网站，爬取搜索结果中的具体页面，提取相关词条链接
 */
type SiteCategory = "news" | "tech" | "qa" | "wiki";

type SiteEntry = {
  domain: string;
  source: string;
  category: SiteCategory;
  /** 新闻类：首页 URL（列表页）；其他类：留空 */
  homepage?: string;
  baseUrl: string;
};

const SITE_REGISTRY: SiteEntry[] = [
  // === 新闻类（爬取首页列表） ===
  { domain: "sina.com.cn", source: "新浪", category: "news", homepage: "https://news.sina.com.cn/", baseUrl: "https://news.sina.com.cn" },
  { domain: "163.com", source: "网易", category: "news", homepage: "https://news.163.com/", baseUrl: "https://news.163.com" },
  { domain: "cctv.com", source: "央视网", category: "news", homepage: "https://news.cctv.com/", baseUrl: "https://news.cctv.com" },
  { domain: "chinanews.com.cn", source: "中国新闻网", category: "news", homepage: "http://www.chinanews.com/", baseUrl: "http://www.chinanews.com" },
  { domain: "people.com.cn", source: "人民网", category: "news", homepage: "http://www.people.com.cn/", baseUrl: "http://www.people.com.cn" },
  { domain: "chinadaily.com.cn", source: "中国日报", category: "news", homepage: "https://cn.chinadaily.com.cn/", baseUrl: "https://cn.chinadaily.com.cn" },
  { domain: "gmw.cn", source: "光明网", category: "news", homepage: "https://news.gmw.cn/", baseUrl: "https://news.gmw.cn" },
  { domain: "cyol.com", source: "中青网", category: "news", homepage: "http://news.cyol.com/", baseUrl: "http://news.cyol.com" },
  { domain: "zaobao.com.sg", source: "联合早报", category: "news", homepage: "https://www.zaobao.com.sg/news/china", baseUrl: "https://www.zaobao.com.sg" },
  { domain: "ifeng.com", source: "凤凰网", category: "news", homepage: "https://news.ifeng.com/", baseUrl: "https://news.ifeng.com" },
  { domain: "xinhuanet.com", source: "新华网", category: "news", homepage: "http://www.xinhuanet.com/", baseUrl: "http://www.xinhuanet.com" },
  { domain: "eastday.com", source: "东方网", category: "news", homepage: "https://news.eastday.com/", baseUrl: "https://news.eastday.com" },
  { domain: "haiwainet.cn", source: "海外网", category: "news", homepage: "https://opinion.haiwainet.cn/", baseUrl: "https://opinion.haiwainet.cn" },
  { domain: "cri.cn", source: "国际在线", category: "news", homepage: "https://news.cri.cn/", baseUrl: "https://news.cri.cn" },
  { domain: "ce.cn", source: "中国经济网", category: "news", homepage: "http://www.ce.cn/", baseUrl: "http://www.ce.cn" },
  { domain: "youth.cn", source: "中国青年网", category: "news", homepage: "https://www.youth.cn/", baseUrl: "https://www.youth.cn" },
  { domain: "cnr.cn", source: "央广网", category: "news", homepage: "https://news.cnr.cn/", baseUrl: "https://news.cnr.cn" },
  { domain: "thepaper.cn", source: "澎湃新闻", category: "news", homepage: "https://www.thepaper.cn/", baseUrl: "https://www.thepaper.cn" },

  // === 技术社区（爬取具体页面，提取相关文章链接） ===
  { domain: "csdn.net", source: "CSDN", category: "tech", baseUrl: "https://www.csdn.net" },
  { domain: "juejin.cn", source: "掘金", category: "tech", baseUrl: "https://juejin.cn" },
  { domain: "cnblogs.com", source: "博客园", category: "tech", baseUrl: "https://www.cnblogs.com" },
  { domain: "segmentfault.com", source: "SegmentFault", category: "tech", baseUrl: "https://segmentfault.com" },
  { domain: "oschina.net", source: "开源中国", category: "tech", baseUrl: "https://www.oschina.net" },
  { domain: "developer.mozilla.org", source: "MDN", category: "tech", baseUrl: "https://developer.mozilla.org" },
  { domain: "stackoverflow.com", source: "Stack Overflow", category: "tech", baseUrl: "https://stackoverflow.com" },
  { domain: "github.com", source: "GitHub", category: "tech", baseUrl: "https://github.com" },
  { domain: "runoob.com", source: "菜鸟教程", category: "tech", baseUrl: "https://www.runoob.com" },

  // === 问答类（爬取具体页面，提取相关问题链接） ===
  { domain: "zhihu.com", source: "知乎", category: "qa", baseUrl: "https://www.zhihu.com" },
  { domain: "quora.com", source: "Quora", category: "qa", baseUrl: "https://www.quora.com" },

  // === 百科类（爬取具体页面，提取相关词条链接） ===
  { domain: "baike.baidu.com", source: "百度百科", category: "wiki", baseUrl: "https://baike.baidu.com" },
  { domain: "zh.wikipedia.org", source: "维基百科", category: "wiki", baseUrl: "https://zh.wikipedia.org" },
  { domain: "baike.so.com", source: "360百科", category: "wiki", baseUrl: "https://baike.so.com" },
];

/** 从 URL 提取主域名（去掉 www. 前缀） */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 匹配域名到网站注册表条目 */
function matchSiteDomain(host: string): SiteEntry | undefined {
  for (const site of SITE_REGISTRY) {
    if (host === site.domain || host.endsWith("." + site.domain)) {
      return site;
    }
  }
  return undefined;
}

export type DomesticFetchOptions = {
  userAgent: string;
  timeoutMs?: number;
  /** RSS 健康监控器（可选，传入后会自动记录成功/失败并降级不健康源） */
  rssHealth?: RssHealthMonitor;
};

/** 必应中国搜索（并行变体 + 快速返回）。长句会误匹配，故自动简化 query 并过滤无关结果。 */
export async function searchBingChina(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
  flags: { skipRelevanceFilter?: boolean } = {},
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];

  const allVariants = prependRecencyQueryVariants(buildSearchQueryVariants(keyword), keyword);
  const variants = allVariants.slice(0, MAX_QUERY_VARIANTS);

  if (variants.length === 0) return [];

  const timeoutPerVariant = calculateTimeoutPerVariant(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, variants.length);

  const results = await Promise.allSettled(
    variants.map((variant) =>
      fetchBingChinaOnceWithTimeout(variant, limit, { ...opts, timeoutMs: timeoutPerVariant }),
    ),
  );

  let collected: InfoSearchItem[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled" || result.value.length === 0) continue;
    // 宽松模式：跳过相关性过滤，保留所有原始结果（用于回退搜索）
    const relevant = flags.skipRelevanceFilter
      ? result.value
      : filterItemsByRelevance(result.value, keyword);
    if (relevant.length === 0) continue;
    collected = [...collected, ...relevant];
  }

  // 合并去重后只调用一次 applySearchFreshness（避免冗余排序）
  return applySearchFreshness(dedupeByUrl(collected), { query: keyword }).items.slice(0, limit);
}

/** 宽松模式必应搜索：跳过相关性过滤 + 不要求最低命中数，返回所有能找到的结果。 */
export async function searchBingChinaRelaxed(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  return searchBingChina(query, limit, opts, { skipRelevanceFilter: true });
}

function calculateTimeoutPerVariant(totalBudgetMs: number, variantCount: number): number {
  const safeCount = Math.max(1, variantCount);
  const perVariant = Math.floor(totalBudgetMs / safeCount);
  const minPerVariant = 2_000;
  const maxPerVariant = 8_000;
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

  // 关键修复：使用 classifySearchIntent 的实体提取（支持中英混合、英文+数字等），
  // 不要只用 extractPrimaryChineseEntity（它只支持纯中文，会丢失「A」在「A股」中的角色）。
  // 这样「今天A股最新消息」会得到 [A股, 今天A股最新消息, ...] 而不是 [今天A股, ...]
  const intentAnalysis = classifySearchIntent(raw);
  const intentEntity = intentAnalysis.entities.find(
    (e) =>
      e.length >= 2 &&
      !/^(最新|最近|今日|今天|现在|目前|刚刚|新闻|消息|资讯|事件|发生|动态|头条|怎么|如何|什么|情况)$/i.test(e),
  );

  // 兼容旧逻辑：纯中文实体（如果 intent 没找到好实体，再用 extractPrimaryChineseEntity）
  const entity = intentEntity ?? extractPrimaryChineseEntity(raw);

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
  // 对所有长度的 anchors 都使用 OR 逻辑：结果只需包含任一 anchor 即可
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

  // === 关键修复：拆解无分隔符的混合 query ===
  // 原 bug：对 "今天A股最新消息" 这种无空格的 query，整个字符串被当一个 token，
  // 导致 anchors = ["今天A股最新消息"]，任何 item.title/snippet 都不含这个完整短语，全部被过滤掉。
  // 修复：从 query 中拆出"更具体"的子串（中英混合、英文-数字、中文-数字、英文+数字型号）。
  // 1. 中英混合词（如 A股、B股、H股、AI芯片）
  for (const m of query.matchAll(/[a-zA-Z]{1,3}[\u4e00-\u9fff]{1,4}/g)) {
    push(m[0]);
  }
  // 2. 英文-数字型号（GPT-5、iPhone 17、Claude 4）
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9]{0,15}[\s\-_]?\d{1,3}[A-Za-z]?\b/g)) {
    push(m[0].trim());
  }
  // 3. 中文-数字型号（蜘蛛侠4、华为Mate60）— 中文主体+数字版本
  for (const m of query.matchAll(/[\u4e00-\u9fff]{1,8}[A-Za-z0-9]{0,8}[\s\-_]?\d{1,3}[A-Za-z]?\b/g)) {
    const s = m[0].trim();
    if (/[\u4e00-\u9fff]/.test(s) && /\d/.test(s)) push(s);
  }
  // 4. 中文连续段（2-6 字）— 比 8-10 字阈值更小，避免过短噪音
  for (const m of query.matchAll(/[\u4e00-\u9fff]{2,6}/gu)) {
    const s = m[0];
    if (!SEARCH_STOPWORDS.has(s)) push(s);
  }

  for (const token of query.split(/[\s,，、。；;:：/|]+/)) {
    const t = token.trim();
    if (t.length < 2 || SEARCH_STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    push(t);
  }

  return anchors;
}

/** 从查询中提取核心实体关键词（移除时效性词汇后分段） */
function extractCoreKeywords(topic: string): string[] {
  const q = topic.trim().toLowerCase();
  // 移除常见时效性词汇（作为分隔符，切分出核心实体）
  const cleaned = q.replace(/最新|最近|今日|今天|现在|目前|刚刚|新闻|消息|资讯|事件|发生|breaking|news|event|latest|recent|current|today/gi, " ");
  // 按非中文/非英文/非数字字符切分
  const words = cleaned
    .split(/[\s,，、。；;:：/|?？!！]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  // 中文连续段（2 字以上）
  const cnRuns = [...cleaned.matchAll(/[\u4e00-\u9fff]{2,}/gu)].map((m) => m[0]);
  // 英文/数字词（如 a股、ai、gpt）
  const enRuns = [...cleaned.matchAll(/[a-z0-9]{1,}[股市]?/gi)].map((m) => m[0].toLowerCase())
    .filter((w) => w.length >= 2);
  return [...new Set([...words, ...cnRuns, ...enRuns])];
}

/** 国内科技 RSS 聚合；可按关键词过滤标题/摘要。 */
export async function fetchDomesticTechNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keywords = extractCoreKeywords(topic);
  // 健康检查：过滤降级源
  const feeds = opts.rssHealth
    ? opts.rssHealth.filterAvailable(DOMESTIC_TECH_RSS_FEEDS)
    : DOMESTIC_TECH_RSS_FEEDS;
  if (feeds.length === 0) return [];
  const perFeed = Math.max(3, Math.ceil(limit / feeds.length) + 2);

  const batches = await Promise.all(
    feeds.map(async (feed) => {
      const xml = await fetchText(feed.url, opts);
      if (!xml) {
        opts.rssHealth?.recordFailure(feed.source);
        return [] as InfoSearchItem[];
      }
      opts.rssHealth?.recordSuccess(feed.source);
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
  // 不再在此处调用 applySearchFreshness，由调用方统一处理
  return merged.slice(0, limit);
}

/** 国内官方媒体 RSS 聚合 + HTML 列表爬取（中国新闻网/人民网 RSS + 央视网/新浪/网易/中国日报等 HTML）。 */
export async function fetchDomesticOfficialNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keywords = extractCoreKeywords(topic);
  // 健康检查：过滤降级源
  const feeds = opts.rssHealth
    ? opts.rssHealth.filterAvailable(DOMESTIC_NEWS_RSS_FEEDS)
    : DOMESTIC_NEWS_RSS_FEEDS;
  const rssPerFeed = Math.max(3, Math.ceil(limit / Math.max(1, feeds.length)) + 2);

  // 并行：RSS 源 + HTML 爬取源
  // HTML 源不提前 slice（列表页抓到的条目多，关键词过滤后才精准）
  const [rssBatches, htmlBatches] = await Promise.all([
    Promise.all(
      feeds.map(async (feed) => {
        const xml = await fetchText(feed.url, opts);
        if (!xml) {
          opts.rssHealth?.recordFailure(feed.source);
          return [] as InfoSearchItem[];
        }
        opts.rssHealth?.recordSuccess(feed.source);
        return parseRssItems(xml)
          .slice(0, rssPerFeed)
          .map((item) => ({
            title: item.title,
            url: item.link,
            snippet: item.description.slice(0, 220),
            source: feed.source,
            publishedAt: item.pubDate,
          }));
      }),
    ),
    Promise.all(
      DOMESTIC_NEWS_HTML_FEEDS.map(async (feed) => {
        const html = await fetchText(feed.url, opts);
        if (!html) return [] as InfoSearchItem[];
        // 每个源最多保留 40 条（避免无日期旧新闻过多占用配额）
        return parseHtmlNewsList(html, feed.source, feed.baseUrl).slice(0, 40);
      }),
    ),
  ]);

  let merged = [...rssBatches.flat(), ...htmlBatches.flat()];
  // 核心实体过滤：必须包含至少一个核心关键词（如"A股"、"股票"），避免返回无关新闻
  if (keywords.length > 0) {
    merged = merged.filter((item) => {
      const hay = `${item.title}\n${item.snippet}`.toLowerCase();
      return keywords.some((k) => hay.includes(k));
    });
  }
  // 不再在此处调用 applySearchFreshness，由调用方统一处理
  return merged.slice(0, limit);
}

/**
 * 从 HTML 列表页解析新闻条目。
 * 提取 <a> 标签中的新闻标题和链接，从 URL 中提取发布日期。
 *
 * 支持的 URL 日期格式：
 *   - 央视网: /2026/07/13/ARTIxxx.shtml
 *   - 联合早报: /news/china/story20260712-9352905
 *   - 新浪: /2026-07-13/doc-xxx.shtml
 *   - 中国日报: /a/202607/13/WSxxx.html
 *   - 光明网/中青网: /2026-07/13/content_xxx.htm(l)
 *   - 海外网: /n/2026/0701/cxxx-xxx.html
 */
function parseHtmlNewsList(html: string, source: string, baseUrl: string): InfoSearchItem[] {
  // 提取所有 <a href="...">文本</a>，文本长度 8-100
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{8,100})<\/a>/gi)];
  const items: InfoSearchItem[] = [];
  const seen = new Set<string>();

  for (const m of links) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    // 过滤导航类文本
    if (/^(首页|登录|注册|更多|关于|联系|广告|服务|评论|收藏|分享|打印|关闭|下一页|上一页)/.test(text)) continue;
    if (text.length < 10) continue;
    // 排除非新闻页面（图集/视频/专题/直播等）
    if (/\/(slide|photo|video|v\.|zt|special|live)\//i.test(href)) continue;
    // 只保留新闻详情页 URL（.html/.shtml/.htm 结尾，或包含 /article/、doc-、content_、/a/\d、/c\d+-）
    if (
      !/\.(html|shtml|htm)$/i.test(href) &&
      !/\/(story|article)\d*/i.test(href) &&
      !/\/doc-/i.test(href) &&
      !/\/content_/i.test(href) &&
      !/\/a\/\d{6}/i.test(href) &&
      !/\/c\d+-\d/i.test(href)
    ) continue;

    // 规范化 URL
    let url = href;
    if (href.startsWith("//")) url = "https:" + href;
    else if (href.startsWith("/")) url = baseUrl + href;
    else if (!/^https?:\/\//i.test(href)) continue;

    // 去重（同一 URL 只保留一次）
    if (seen.has(url)) continue;
    seen.add(url);

    // 从 URL 提取日期
    const publishedAt = extractDateFromUrl(href);

    items.push({
      title: text,
      url,
      snippet: text, // HTML 列表页通常无摘要，用标题代替
      source,
      publishedAt,
    });
  }

  return items;
}

/** 从新闻 URL 中提取发布日期 */
function extractDateFromUrl(url: string): string | undefined {
  // 央视网: /2026/07/13/ARTIxxx.shtml
  // 海外网: /n/2026/0701/cxxx-xxx.html（月日连在一起）
  const cctv = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (cctv) {
    const d = new Date(Number(cctv[1]), Number(cctv[2]) - 1, Number(cctv[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 海外网: /n/2026/0701/cxxx-xxx.html
  const hww = url.match(/\/(\d{4})\/(\d{2})(\d{2})\//);
  if (hww) {
    const d = new Date(Number(hww[1]), Number(hww[2]) - 1, Number(hww[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 新浪: /2026-07-13/doc-xxx.shtml
  const sina = url.match(/\/(\d{4})-(\d{2})-(\d{2})\//);
  if (sina) {
    const d = new Date(Number(sina[1]), Number(sina[2]) - 1, Number(sina[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 中国日报: /a/202607/13/WSxxx.html
  const cd = url.match(/\/(\d{4})(\d{2})\/(\d{2})\//);
  if (cd) {
    const d = new Date(Number(cd[1]), Number(cd[2]) - 1, Number(cd[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 光明网/中青网: /2026-07/13/content_xxx.htm
  const gmw = url.match(/\/(\d{4})-(\d{2})\/(\d{2})\//);
  if (gmw) {
    const d = new Date(Number(gmw[1]), Number(gmw[2]) - 1, Number(gmw[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 联合早报: story20260712-9352905
  const zb = url.match(/story(\d{8})-/);
  if (zb) {
    const s = zb[1];
    const d = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/**
 * 从具体页面中提取相关链接（用于技术/问答/百科类网站）。
 *
 * 与新闻类不同，技术文章/问答/百科没有"首页列表"，
 * 但页面正文通常包含相关文章/问题/词条的链接。
 * 爬取这些页面，提取同域名的相关链接，扩展搜索覆盖面。
 *
 * 每个页面最多提取 10 条相关链接，避免过多噪音。
 */
async function extractRelatedLinksFromPage(
  pageUrl: string,
  site: SiteEntry,
  topic: string,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const html = await fetchText(pageUrl, opts);
  if (!html) return [];

  // 提取页面中所有 <a> 链接
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{8,100})<\/a>/gi)];
  const items: InfoSearchItem[] = [];
  const seen = new Set<string>();
  const keywords = extractCoreKeywords(topic);
  const baseUrlHost = extractDomain(site.baseUrl);

  for (const m of links) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    // 过滤导航类文本
    if (/^(首页|登录|注册|更多|关于|联系|广告|服务|评论|收藏|分享|打印|关闭|下一页|上一页|下载|举报|反馈)/.test(text)) continue;
    if (text.length < 8) continue;

    // 规范化为绝对 URL
    let absUrl: string;
    try {
      absUrl = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }

    // 只保留同域名的链接（避免外链噪音）
    const linkHost = extractDomain(absUrl);
    if (!linkHost || !linkHost.endsWith(baseUrlHost)) continue;

    if (seen.has(absUrl)) continue;
    seen.add(absUrl);

    // 排除与当前页面相同的 URL
    if (absUrl === pageUrl) continue;

    // 用关键词过滤（标题或链接文本包含主题关键词）
    if (keywords.length > 0) {
      const hay = `${text}\n${absUrl}`.toLowerCase();
      if (!keywords.some((k) => hay.includes(k))) continue;
    }

    items.push({
      title: text,
      url: absUrl,
      snippet: text,
      source: site.source,
      publishedAt: extractDateFromUrl(absUrl),
    });

    if (items.length >= 10) break; // 每个页面最多 10 条
  }

  return items;
}

/**
 * 动态源发现：从已有搜索结果中识别网站域名，自动爬取相关页面。
 *
 * 分类策略：
 *   - news（新闻）：爬取首页列表页，拿到比必应索引更新的新闻
 *   - tech/qa/wiki（技术/问答/百科）：爬取搜索结果中的具体页面，
 *     提取其中的相关链接（相关文章/问题/词条），扩展覆盖面
 *
 * 触发时机：search() 方法中，预定义源 + 必应结果不足时调用。
 */
export async function discoverHtmlSourcesFromResults(
  searchResults: InfoSearchItem[],
  topic: string,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  if (searchResults.length === 0) return [];

  // 1. 从已有搜索结果中识别网站域名
  //    对于非新闻类，同时记录该域名下的具体页面 URL（用于后续爬取）
  const discovered = new Map<string, SiteEntry>();
  const pageUrlsByDomain = new Map<string, string[]>();

  for (const item of searchResults) {
    const host = extractDomain(item.url);
    if (!host) continue;
    const match = matchSiteDomain(host);
    if (!match) continue;

    if (!discovered.has(match.domain)) {
      discovered.set(match.domain, match);
    }

    // 对于非新闻类，记录搜索结果中的具体页面 URL
    if (match.category !== "news") {
      const urls = pageUrlsByDomain.get(match.domain) ?? [];
      urls.push(item.url);
      pageUrlsByDomain.set(match.domain, urls);
    }
  }

  if (discovered.size === 0) return [];

  // 2. 排除已在预定义 HTML 源中的新闻域名（避免重复爬取）
  const predefinedDomains = new Set(
    DOMESTIC_NEWS_HTML_FEEDS.map((f) => extractDomain(f.baseUrl)),
  );

  // 3. 根据类别构建爬取任务
  const tasks: Promise<InfoSearchItem[]>[] = [];

  for (const [domain, site] of discovered) {
    if (site.category === "news") {
      // 新闻类：爬取首页列表页
      if (predefinedDomains.has(domain) || !site.homepage) continue;
      const homepage = site.homepage;
      tasks.push(
        (async () => {
          const html = await fetchText(homepage, opts);
          if (!html) return [] as InfoSearchItem[];
          return parseHtmlNewsList(html, site.source, site.baseUrl).slice(0, 40);
        })(),
      );
    } else {
      // 技术/问答/百科类：爬取搜索结果中的具体页面，提取相关链接
      const urls = (pageUrlsByDomain.get(domain) ?? []).slice(0, 2); // 每个域名最多爬 2 个页面
      for (const url of urls) {
        tasks.push(extractRelatedLinksFromPage(url, site, topic, opts));
      }
    }
  }

  if (tasks.length === 0) return [];

  // 4. 并行执行（最多 6 个任务，避免过多网络请求）
  const batches = await Promise.all(tasks.slice(0, 6));

  // 5. 合并 + 关键词过滤
  const keywords = extractCoreKeywords(topic);
  let merged = batches.flat();
  if (keywords.length > 0) {
    merged = merged.filter((item) => {
      const hay = `${item.title}\n${item.snippet}`.toLowerCase();
      return keywords.some((k) => hay.includes(k));
    });
  }

  return merged;
}

/** 国内新闻：必应 RSS + 科技 RSS + 官方媒体 RSS（实时性最优组合）。 */
export async function fetchDomesticNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = topic.trim();
  if (!keyword) return [];

  const [bing, tech, official] = await Promise.all([
    searchBingChina(keyword, limit, opts),
    fetchDomesticTechNews(keyword, Math.min(6, limit), opts),
    fetchDomesticOfficialNews(keyword, Math.min(8, limit), opts),
  ]);
  // 官方媒体 RSS 排前面（实时性最高），然后必应，然后科技 RSS
  return applySearchFreshness(dedupeByUrl([...official, ...bing, ...tech]), { query: keyword }).items.slice(
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
