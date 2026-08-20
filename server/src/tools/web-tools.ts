import type { InfoHubService } from "../services/info-hub-service.js";
import type { UpstreamSearchService } from "../services/upstream-search-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import { resolveActorId } from "../agent/actor-id.js";
import { fetchHotRankings, type HotRankSource } from "../services/hot-rankings.js";

function toBoundedLimit(input: unknown, fallback: number): number {
  const limit = Number(input ?? fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(25, Math.floor(limit)));
}

/** 截断正文，控制返回 token 量。 */
function trimContent(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…[正文过长已截断]";
}

export function registerWebTools(
  toolRegistry: ToolRegistry,
  infoHubService: InfoHubService,
  upstreamSearchService: UpstreamSearchService,
): void {
  toolRegistry.register("search_web", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 12);
    if (!query) return { provider: "none", items: [], notes: ["query 不能为空"] };
    return upstreamSearchService.searchWeb(query, limit);
  });

  toolRegistry.register("search_images", async (input, context) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 8);
    if (!query) return { provider: "none", mediaType: "image", items: [], notes: ["query 不能为空"] };
    return upstreamSearchService.searchImages(query, limit, resolveActorId(context));
  });

  toolRegistry.register("search_videos", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 8);
    if (!query) return { provider: "none", mediaType: "video", items: [], notes: ["query 不能为空"] };
    return upstreamSearchService.searchVideos(query, limit);
  });

  toolRegistry.register("fetch_web", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", content: "", summary: "url 不能为空" };
    const includeLinks = input.include_links === true;
    const result = await infoHubService.readWebpage(url);
    // 如果需要链接，额外调用 inspectWebpage 补充
    if (includeLinks) {
      const inspect = await infoHubService.inspectWebpage(url);
      return { ...result, links: inspect.links, sameHostLinks: inspect.sameHostLinks };
    }
    return result;
  });

  /**
   * 深度搜索：一次调用完成「搜索 + 抓取 Top 网页正文」。
   * 先按 query 搜索，再并行读取前 fetch_pages 条结果的完整正文（去噪后纯文本），
   * 一条结果同时带 snippet 与 content。避免 Agent 先 search_web 拿到链接、
   * 再逐个 fetch_web 的来回跳跃，贴近扣子的「搜索含正文」体验。
   */
  toolRegistry.register("deep_search", async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) return { results: [], notes: ["query 不能为空"] };
    const searchLimit = toBoundedLimit(input.limit, 8);
    const maxPages = Math.max(1, Math.min(10, Math.floor(Number(input.fetch_pages ?? 3)) || 3));
    const contentLimit = Math.max(800, Math.min(6000, Math.floor(Number(input.content_limit ?? 2200)) || 2200));

    const res = await upstreamSearchService.searchWeb(query, searchLimit);

    const toRead = res.items.filter((item) => item.url && /^https?:\/\//i.test(item.url)).slice(0, maxPages);
    if (toRead.length === 0) {
      return { query, provider: res.provider, results: res.items, notes: ["未找到可深读的有效链接，只有摘要"] };
    }

    const readResults = await Promise.allSettled(toRead.map((item) => infoHubService.readWebpage(item.url!)));

    const results: Array<{
      title: string;
      url: string;
      source?: string;
      snippet: string;
      content: string;
      summary: string;
    }> = [];
    for (let i = 0; i < toRead.length; i++) {
      const item = toRead[i];
      const entry = readResults[i];
      const page = entry.status === "fulfilled" ? entry.value : null;
      results.push({
        title: page?.title || item.title,
        url: item.url!,
        source: item.source,
        snippet: item.snippet || "",
        content: page ? trimContent(page.content, contentLimit) : "",
        summary: page?.summary || "",
      });
    }

    // 未被深读的剩余条目标记只有 snippet
    for (const item of res.items.slice(maxPages)) {
      if (!item.url) continue;
      results.push({
        title: item.title,
        url: item.url,
        source: item.source,
        snippet: item.snippet || "",
        content: "",
        summary: "",
      });
    }

    return { query, provider: res.provider, results };
  });

  /**
   * 实时热点榜单：聚合微博/百度/知乎/B站 当前热门话题。
   */
  toolRegistry.register("hot_rankings", async (input) => {
    const limit = Math.max(1, Math.min(60, Math.floor(Number(input.limit ?? 20)) || 20));
    const rawPlatforms = Array.isArray(input.platforms)
      ? input.platforms.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
      : [];
    const allowed = new Set<HotRankSource>(["weibo", "baidu", "zhihu", "bilibili"]);
    const platforms = rawPlatforms.filter((p) => allowed.has(p as HotRankSource)) as HotRankSource[];
    const result = await fetchHotRankings(limit, platforms);
    return {
      items: result.items,
      fetchedSources: result.fetchedSources,
      notes: result.notes,
    };
  });

  // Backward compatibility: keep historical aliases on built-in path.
  toolRegistry.register("info.search", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 12);
    if (!query) return { items: [] };
    const items = await infoHubService.search(query, limit);
    return { items };
  });

  toolRegistry.register("info.read_webpage", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", content: "", summary: "url 不能为空" };
    return infoHubService.readWebpage(url);
  });

  toolRegistry.register("info.inspect_webpage", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", summary: "url 不能为空", contentPreview: "", links: [], sameHostLinks: [] };
    return infoHubService.inspectWebpage(url);
  });

  toolRegistry.register("info.navigate_site", async (input) => {
    const startUrl = String(input.startUrl ?? "").trim();
    if (!startUrl) return { ok: false, error: "startUrl 不能为空" };
    const goalKeywords = Array.isArray(input.goalKeywords)
      ? input.goalKeywords.map((k) => String(k).trim()).filter(Boolean)
      : undefined;
    const maxDepth = Number(input.maxDepth);
    const maxPages = Number(input.maxPages);
    const sameHostOnly = input.sameHostOnly !== false;
    return infoHubService.navigateSite({
      startUrl,
      goalKeywords,
      maxDepth: Number.isFinite(maxDepth) ? maxDepth : undefined,
      maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
      sameHostOnly,
    });
  });
}
