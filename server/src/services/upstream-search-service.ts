import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InfoHubService, InfoSearchItem } from "./info-hub-service.js";
import {
  applySearchFreshness,
  formatSearchFreshnessNote,
  getSearchAnchorNow,
  SearchCache,
} from "./search-enhancements.js";
import { searchImagesViaSearchApi, type ImageApiItem } from "./search-api-provider.js";
import type { ImageGenerationService } from "./image-generation-service.js";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export type UnifiedSearchItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  platform: string;
};

export type MediaSearchItem = {
  type: "image" | "video";
  title: string;
  pageUrl: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  source: string;
  snippet?: string;
  width?: number;
  height?: number;
  duration?: string;
  /** 对比分组元数据（由 searchImagesBatch 注入，供前端分组渲染） */
  compareSide?: "A" | "B";
  compareLabel?: string;
  compareGroup?: string;
};

export class UpstreamSearchService {
  // 社交平台搜索结果缓存（3 分钟 TTL，避免重复调用 mcporter）
  private readonly socialCache = new SearchCache<{ provider: string; raw: string; notes: string[] }>({
    maxSize: 50,
    ttlMs: 3 * 60 * 1000,
  });

  // 泛网页搜索 query 级缓存（短 TTL）。
  // 同一 query 在短窗口内被重复搜索（Agent 重问/变体重叠/fetch 前判断）时直接命中，
  // 省一次 API/爬取网络请求，也避免把同一批结果反复注入给 LLM 造成 token 重复消耗。
  private readonly webQueryCache = new SearchCache<{
    provider: string;
    items: InfoSearchItem[];
    fetchedAt: string;
    searchDateLocal: string;
    notes: string[];
  }>({
    maxSize: 120,
    ttlMs: 30 * 1000,
  });

  private imageStorageService?: ImageGenerationService;

  constructor(private readonly infoHubService: InfoHubService) {}

  setImageStorageService(service: ImageGenerationService): void {
    this.imageStorageService = service;
  }

  async searchUnified(input: {
    query: string;
    limit?: number;
    platform?: string;
  }): Promise<{
    provider: string;
    platform: string;
    items: UnifiedSearchItem[];
    notes: string[];
  }> {
    const query = String(input.query ?? "").trim();
    const limit = clamp(Number(input.limit ?? 12), 1, 25);
    const platform = String(input.platform ?? "auto").trim().toLowerCase();
    if (!query) {
      return { provider: "none", platform, items: [], notes: ["query 不能为空"] };
    }

    if (platform === "web") {
      const web = await this.searchWeb(query, limit);
      return {
        provider: web.provider,
        platform,
        items: web.items.map((x) => ({ ...x, platform: "web" })),
        notes: web.notes,
      };
    }
    if (platform === "weibo") {
      const hit = await this.searchWeibo(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "weibo", "weibo"),
        notes: hit.notes,
      };
    }
    if (platform === "xiaohongshu") {
      const hit = await this.searchXiaohongshu(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "xiaohongshu", "xiaohongshu"),
        notes: hit.notes,
      };
    }
    if (platform === "wechat") {
      const hit = await this.searchWechat(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "wechat", "wechat"),
        notes: hit.notes,
      };
    }
    if (platform === "douyin") {
      const hit = await this.searchDouyin(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "douyin", "douyin"),
        notes: hit.notes,
      };
    }
    if (platform === "github") {
      const hit = await this.searchGithubRepos(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: hit.items.map((x) => ({
          title: x.fullName,
          url: x.url,
          snippet: x.description,
          source: "GitHub",
          platform: "github",
        })),
        notes: hit.notes,
      };
    }

    const notes: string[] = [];
    const merged: UnifiedSearchItem[] = [];
    const seen = new Set<string>();
    const pushItems = (items: UnifiedSearchItem[]) => {
      for (const item of items) {
        const key = item.url.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    };

    // 并行化：web 搜索 + 社交平台搜索同时发起，避免串行等待
    const isChinese = hasChinese(query) || /微博|小红书|公众号|抖音|b站|国内/.test(query.toLowerCase());
    const socialPromise = isChinese
      ? Promise.all([
          this.searchWeibo(query, Math.min(8, limit)),
          this.searchXiaohongshu(query, Math.min(8, limit)),
          this.searchWechat(query, Math.min(8, limit)),
        ])
      : null;

    const web = await this.searchWeb(query, limit);
    notes.push(...web.notes);
    pushItems(web.items.map((x) => ({ ...x, platform: "web" })));

    // 等待社交平台结果（已与 web 并行执行）
    if (socialPromise) {
      const [weibo, xhs, wechat] = await socialPromise;
      notes.push(...weibo.notes, ...xhs.notes, ...wechat.notes);
      pushItems(rawToItems(weibo.raw, "weibo", "weibo"));
      pushItems(rawToItems(xhs.raw, "xiaohongshu", "xiaohongshu"));
      pushItems(rawToItems(wechat.raw, "wechat", "wechat"));
    }

    return {
      provider: `auto:${web.provider}`,
      platform: "auto",
      items: merged.slice(0, limit),
      notes: dedupeText(notes),
    };
  }

  async searchWeb(query: string, limit = 12): Promise<{
    provider: string;
    items: InfoSearchItem[];
    fetchedAt: string;
    searchDateLocal: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return {
        provider: "none",
        items: [],
        fetchedAt: new Date().toISOString(),
        searchDateLocal: getSearchAnchorNow().label,
        notes: ["query 不能为空"],
      };
    }
    const boundedLimit = clamp(limit, 1, 25);
    const anchor = getSearchAnchorNow();
    const cacheKey = `${keyword.toLowerCase()}|${boundedLimit}`;
    const cached = this.webQueryCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        notes: [...cached.notes, "命中 30s 搜索缓存"],
      };
    }
    const raw = await this.infoHubService.search(keyword, boundedLimit);
    const fresh = applySearchFreshness(raw, { query: keyword });
    const maxAgeDays = Number(process.env.SEARCH_MAX_ITEM_AGE_DAYS ?? 120);
    const providerUsed = inferSearchProvider(fresh.items);
    const result = {
      provider: providerUsed,
      items: fresh.items,
      fetchedAt: anchor.iso,
      searchDateLocal: anchor.label,
      notes: [
        providerUsed === "domestic-bing-cn"
          ? "必应中国 RSS + 国内科技 RSS"
          : `搜索 API(${providerUsed}) 优先 + 必应/国内爬虫补全`,
        formatSearchFreshnessNote({ anchor, droppedStale: fresh.droppedStale, maxAgeDays }),
      ],
    };
    this.webQueryCache.set(cacheKey, result);
    return result;
  }

  async searchImages(query: string, limit = 4, actorId = "anonymous"): Promise<{
    provider: string;
    mediaType: "image";
    items: MediaSearchItem[];
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "bing-images", mediaType: "image", items: [], notes: ["query 不能为空"] };
    }
    // 单次默认 4、上限 8：单 call 不应铺一整面图墙；
    // LLM 需要更多张时应拆成多个细粒度 query 并行搜（如多个地点/多个主题各搜一次），
    // 由前端 renderBlocks 把「每段文字→对应一组照片」自然交错。
    const boundedLimit = clamp(limit, 1, 8);

    // 优先走已接入的搜索 API（search-images-via-search-api）拿真实图源 URL；
    // 与正文搜索 searchWeb 同源策略：API 优先，爬图片网页仅作兜底。
    const apiItems = await searchImagesViaSearchApi(keyword, boundedLimit);
    if (apiItems.length > 0) {
      const items = await this.materializeImageResults(
        apiItems.map((it) => ({
          type: "image" as const,
          title: it.title,
          pageUrl: it.pageUrl || it.mediaUrl,
          mediaUrl: it.mediaUrl,
          thumbnailUrl: it.thumbnailUrl,
          source: it.source || "SearchApi",
        })),
        actorId,
        boundedLimit,
      );
      if (items.length > 0) {
        return {
          provider: "search-api-images",
          mediaType: "image",
          items,
          notes: [`搜索 API 图片搜索优先（已转存 PNG）；pageUrl 保留原始来源页`],
        };
      }
    }

    // API 未接入/缺 key/失败/空结果 → 回退到爬 cn.bing.com 图片网页兜底。
    const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(keyword)}&form=HDRSC2`;
    const html = await this.fetchText(url, IMAGE_FETCH_TIMEOUT_MS);
    const rawItems = parseBingImageResults(html, boundedLimit);
    const items = await this.materializeImageResults(rawItems, actorId, boundedLimit);
    if (items.length > 0) {
      return {
        provider: "bing-images",
        mediaType: "image",
        items,
        notes: ["mediaUrl/thumbnailUrl 已转存为服务端本地 PNG；pageUrl 保留原始来源页"],
      };
    }

    return {
      provider: "bing-images",
      mediaType: "image",
      items: [],
      notes: ["未能把图片结果转存为 PNG，已避免返回普通网页链接"],
    };
  }

  /**
   * 对比式批量图片搜索（代码层实现，不依赖 LLM prompt 编排）。
   *
   * 一次调用按「对比维度 × 两侧」并行出图，返回分组结构 mediaGroups：
   *   - query 含 `A vs B`/`A对比B`/`A和B对比` 时自动拆成 sideA/sideB 两侧；
   *   - dimensions 提供多个维度（水屋/沙屋/餐厅…）时，每个维度生成
   *     `${sideA} ${维度}` 与 `${sideB} ${维度}` 两组并行搜索；
   *   - 未提供 dimensions 时退化为单组：用两侧公共子串推断维度标题。
   *
   * 每一张图都打上 compareSide / compareLabel / compareGroup 标记，
   * 前端据此按维度分组、左右两侧分栏渲染（对比图不再混作一张九宫格）。
   */
  async searchImagesBatch(
    query: string,
    dimensions: string[] | undefined,
    limitPerGroup: number,
    actorId: string,
  ): Promise<{
    provider: string;
    mediaType: "image";
    items: MediaSearchItem[];
    mediaGroups?: Array<{
      title: string;
      sideA: string;
      sideB?: string;
      itemsA: MediaSearchItem[];
      itemsB: MediaSearchItem[];
    }>;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "none", mediaType: "image", items: [], mediaGroups: [], notes: ["query 不能为空"] };
    }

    // 1) 解析两侧：query 内带对比连接词则拆成 A/B，否则整句作为单侧
    const pair = splitCompareQuery(keyword);
    const sideA = pair?.sideA ?? keyword;
    const sideB = pair?.sideB;

    // 2) 组装分组规格：dimensions 优先；否则单组 + LCS 推断维度标题
    const dimList = (dimensions ?? [])
      .map((d) => String(d ?? "").trim())
      .filter((d) => d && d.length <= 20)
      .slice(0, MAX_COMPARE_GROUPS);
    const groups: Array<{ title: string; qA: string; qB?: string }> = [];
    if (dimList.length > 0) {
      for (const dim of dimList) {
        groups.push({
          title: dim,
          qA: `${sideA} ${dim}`.trim(),
          qB: sideB ? `${sideB} ${dim}`.trim() : undefined,
        });
      }
    } else {
      const dim = pair ? cleanDimension(longestCommonSubstring(sideA, sideB ?? "")) : "";
      groups.push({ title: dim, qA: sideA, qB: sideB });
    }

    // 3) 每侧保留张数（对比图追求"分类清、不混排"，单侧限制更小）
    const perSide = Math.max(1, Math.min(limitPerGroup, MAX_IMAGES_PER_SIDE));

    // 4) 所有组 × 两侧并行搜索（组间并行，受 12s 工具超时约束；搜索内部自带转存预算）
    const settled = await Promise.allSettled(
      groups.map(async (g) => {
        const [a, b] = await Promise.all([
          this.searchImages(g.qA, perSide, actorId),
          g.qB ? this.searchImages(g.qB, perSide, actorId) : Promise.resolve(null),
        ]);
        return { g, a, b };
      }),
    );

    const mediaGroups: Array<{
      title: string;
      sideA: string;
      sideB?: string;
      itemsA: MediaSearchItem[];
      itemsB: MediaSearchItem[];
    }> = [];
    const flatItems: MediaSearchItem[] = [];
    const oneSidedDims: string[] = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const { g, a, b } = r.value;
      const itemsA = tagCompareSide(a?.items ?? [], "A", sideA, g.title);
      const itemsB = tagCompareSide(b?.items ?? [], "B", sideB ?? "", g.title);
      if (itemsA.length === 0 && itemsB.length === 0) continue;
      // 容错标注：某维度仅搜到单侧图片时，记录维度名供 notes 透出（前端分栏显示空侧）
      if (itemsA.length === 0 || itemsB.length === 0) {
        oneSidedDims.push(g.title);
      }
      mediaGroups.push({ title: g.title, sideA, sideB, itemsA, itemsB });
      flatItems.push(...itemsA, ...itemsB);
    }

    // 5) 兜底：全组失败 → 退化单侧搜索，保证至少出图
    if (mediaGroups.length === 0) {
      const fallback = await this.searchImages(sideA, perSide, actorId);
      if (fallback.items.length > 0) {
        const dim = pair ? cleanDimension(longestCommonSubstring(sideA, sideB ?? "")) : "";
        mediaGroups.push({
          title: dim,
          sideA,
          sideB,
          itemsA: tagCompareSide(fallback.items, "A", sideA, dim),
          itemsB: [],
        });
        flatItems.push(...fallback.items);
      }
    }

    const notes: string[] = [
      `已按 ${mediaGroups.length} 个维度分组对比出图，每侧各取 ${perSide} 张`,
    ];
    if (oneSidedDims.length > 0) {
      notes.push(
        `维度「${oneSidedDims.join("、")}」仅搜到单侧图片，另一侧暂无图`,
      );
    }

    return {
      provider: pair ? "compare-batch" : "image-batch",
      mediaType: "image",
      items: flatItems,
      mediaGroups,
      notes,
    };
  }

  async searchVideos(query: string, limit = 8): Promise<{
    provider: string;
    mediaType: "video";
    items: MediaSearchItem[];
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "bing-videos", mediaType: "video", items: [], notes: ["query 不能为空"] };
    }
    const boundedLimit = clamp(limit, 1, 12);
    const url = `https://cn.bing.com/videos/search?q=${encodeURIComponent(keyword)}`;
    const html = await this.fetchText(url, 10_000);
    const parsed = parseBingVideoResults(html, boundedLimit);
    if (parsed.length >= Math.min(3, boundedLimit)) {
      return {
        provider: "bing-videos",
        mediaType: "video",
        items: parsed,
        notes: ["返回 pageUrl 可打开播放页；thumbnailUrl 可用于对话内预览"],
      };
    }

    const web = await this.searchWeb(`${keyword} 视频 OR site:bilibili.com OR site:youtube.com`, boundedLimit);
    const fallback = web.items
      .filter((item) => isLikelyVideoUrl(item.url) || /视频|youtube|bilibili|哔哩|播放/i.test(`${item.title} ${item.snippet}`))
      .slice(0, boundedLimit)
      .map((item) => ({
        type: "video" as const,
        title: item.title,
        pageUrl: item.url,
        source: inferMediaSource(item.url, item.source),
        snippet: item.snippet,
      }));
    return {
      provider: parsed.length > 0 ? "bing-videos:mixed" : "bing-videos:fallback-web",
      mediaType: "video",
      items: dedupeMediaByPageUrl([...parsed, ...fallback]).slice(0, boundedLimit),
      notes: parsed.length > 0
        ? ["视频页结果较少，已补充视频相关网页结果"]
        : ["视频页解析失败，已降级返回视频相关网页结果"],
    };
  }

  async readWeb(url: string): Promise<{ title: string; content: string; summary: string }> {
    return this.infoHubService.readWebpage(url);
  }

  async searchGithubRepos(query: string, limit = 10): Promise<{
    provider: string;
    items: Array<{ fullName: string; description: string; url: string; stars?: number }>;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "none", items: [], notes: ["query 不能为空"] };
    }
    const boundedLimit = clamp(limit, 1, 20);
    const args = [
      "search",
      "repos",
      keyword,
      "--limit",
      String(boundedLimit),
      "--json",
      "nameWithOwner,description,url,stargazerCount",
    ];
    const run = await this.runCommand(resolveBin("gh"), args, 15000);
    if (!run.ok) {
      return {
        provider: "gh",
        items: [],
        notes: [formatFailure("gh", run)],
      };
    }
    try {
      const parsed = JSON.parse(run.stdout) as Array<{
        nameWithOwner?: string;
        description?: string;
        url?: string;
        stargazerCount?: number;
      }>;
      const items = parsed
        .filter((x) => x.url && x.nameWithOwner)
        .map((x) => ({
          fullName: x.nameWithOwner ?? "",
          description: x.description ?? "",
          url: x.url ?? "",
          stars: Number.isFinite(x.stargazerCount) ? x.stargazerCount : undefined,
        }));
      return { provider: "gh", items, notes: [] };
    } catch {
      return {
        provider: "gh",
        items: [],
        notes: ["gh 输出解析失败，请先本地验证 `gh search repos` 命令"],
      };
    }
  }

  async searchReddit(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "rdt", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const run = await this.runCommand(resolveBin("rdt"), ["search", keyword, "--limit", String(boundedLimit)], 20000);
    if (!run.ok) {
      return { provider: "rdt", raw: "", notes: [formatFailure("rdt", run)] };
    }
    return { provider: "rdt", raw: run.stdout.slice(0, 12000), notes: [] };
  }

  async readYoutube(url: string): Promise<{
    provider: string;
    title: string;
    channel: string;
    durationSeconds?: number;
    description: string;
    notes: string[];
  }> {
    const rawUrl = String(url ?? "").trim();
    if (!rawUrl) {
      return { provider: "youtube-oembed", title: "", channel: "", description: "", notes: ["url 不能为空"] };
    }
    // 使用 YouTube oEmbed 公开接口获取标题/作者/封面（无需登录、无外部二进制依赖）
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
      const text = await this.fetchText(oembedUrl, 10_000);
      const parsed = JSON.parse(text) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      if (parsed.title) {
        return {
          provider: "youtube-oembed",
          title: parsed.title ?? "",
          channel: parsed.author_name ?? "",
          description: parsed.thumbnail_url ? `封面: ${parsed.thumbnail_url}` : "",
          notes: [],
        };
      }
      return {
        provider: "youtube-oembed",
        title: "",
        channel: "",
        description: "",
        notes: ["oEmbed 未返回标题，可能链接无效或视频受限"],
      };
    } catch {
      return {
        provider: "youtube-oembed",
        title: "",
        channel: "",
        description: "",
        notes: ["YouTube oEmbed 解析失败，请确认链接可公开访问"],
      };
    }
  }

  async searchWeibo(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "weibo", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `weibo:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `weibo.search_weibo_content(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `weibo.search_content(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 12_000);
    if (!run.ok) {
      return this.relayPlatform("weibo", keyword, boundedLimit, run.note);
    }
    const result = { provider: "weibo", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async readBilibili(url: string): Promise<{
    provider: string;
    title: string;
    channel: string;
    durationSeconds?: number;
    description: string;
    notes: string[];
  }> {
    const rawUrl = String(url ?? "").trim();
    if (!rawUrl) {
      return { provider: "bilibili-api", title: "", channel: "", description: "", notes: ["url 不能为空"] };
    }
    // 使用 B站公开信息接口（无需登录、无外部二进制依赖）
    const bvid = rawUrl.match(/[bB][vV][0-9A-Za-z]{8,}/)?.[0];
    if (!bvid) {
      return { provider: "bilibili-api", title: "", channel: "", description: "", notes: ["链接中未找到 bvid"] };
    }
    try {
      const text = await this.fetchText(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, 10_000);
      const parsed = JSON.parse(text) as {
        code?: number;
        data?: {
          title?: string;
          desc?: string;
          pic?: string;
          duration?: number;
          owner?: { name?: string };
        };
      };
      const data = parsed.data;
      if (data?.title) {
        return {
          provider: "bilibili-api",
          title: data.title ?? "",
          channel: data.owner?.name ?? "",
          durationSeconds: Number.isFinite(data.duration) ? data.duration : undefined,
          description: String(data.desc ?? "").slice(0, 5000),
          notes: data.pic ? [`封面: ${data.pic}`] : [],
        };
      }
      return {
        provider: "bilibili-api",
        title: "",
        channel: "",
        description: "",
        notes: ["B站接口未返回视频信息，可能视频已删除或需要登录"],
      };
    } catch {
      return {
        provider: "bilibili-api",
        title: "",
        channel: "",
        description: "",
        notes: ["B站接口解析失败，请确认链接有效"],
      };
    }
  }

  async searchXiaohongshu(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "xiaohongshu", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `xhs:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `xiaohongshu.search_feeds(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `xhs.search_feeds(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 15_000);
    if (!run.ok) {
      return this.relayPlatform("xiaohongshu", keyword, boundedLimit, run.note);
    }
    const result = { provider: "xiaohongshu", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async searchWechat(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "wechat", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `wechat:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `wechat.search_articles(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `wechat.search_wechat_articles(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 15_000);
    if (!run.ok) {
      return this.relayPlatform("wechat", keyword, boundedLimit, run.note);
    }
    const result = { provider: "wechat", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async searchDouyin(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "douyin", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `douyin:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `douyin.search(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `douyin.search_videos(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 15_000);
    if (!run.ok) {
      return this.relayPlatform("douyin", keyword, boundedLimit, run.note);
    }
    const result = { provider: "douyin", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async checkUpstreamHealth(): Promise<{
    bins: Record<string, { ok: boolean; detail: string }>;
    mcpHints: Record<string, string>;
  }> {
    const targets: Array<{ key: string; bin: string }> = [
      { key: "mcporter", bin: resolveBin("mcporter") },
      { key: "gh", bin: resolveBin("gh") },
      { key: "rdt", bin: resolveBin("rdt") },
    ];
    const bins: Record<string, { ok: boolean; detail: string }> = {};
    for (const t of targets) {
      const run = await this.runCommand(t.bin, ["--version"], 6000);
      bins[t.key] = run.ok
        ? { ok: true, detail: (run.stdout || run.stderr || "ok").split(/\r?\n/)[0] ?? "ok" }
        : { ok: false, detail: (run.stderr || run.stdout || "not found").slice(0, 200) };
    }
    return {
      bins,
      mcpHints: {
        weibo: "需要 mcporter 中存在 weibo server alias",
        xiaohongshu: "需要 mcporter 中存在 xiaohongshu 或 xhs server alias",
        wechat: "需要 mcporter 中存在 wechat server alias",
        douyin: "需要 mcporter 中存在 douyin server alias",
      },
    };
  }

  // ---- 平台未配置 MCP 时的公开网页兜底 ----
  // 实测：微博/小红书/抖音的「正文/笔记」在无登录态下均无法直接抓取（访客验证/签名/动态渲染），
  // 且 Bing 中国忽略 `site:` 语法、DuckDuckGo 超时——通用搜索引擎拿不到真实平台域名页面。
  // 因此兜底必须做「平台域名过滤」，只保留命中平台域名的条目，命中不了就诚实返回空，
  // 避免把搜索引擎的泛结果（如财经/知乎页）错标为该平台来源（来源欺骗）。
  private async relayPlatform(
    platform: "weibo" | "xiaohongshu" | "wechat" | "douyin",
    keyword: string,
    limit: number,
    reason: string,
  ): Promise<{ provider: string; raw: string; notes: string[] }> {
    const MATCH: Record<"weibo" | "xiaohongshu" | "wechat" | "douyin", RegExp> = {
      weibo: /(^|\.)weibo\.(com|cn)$/i,
      xiaohongshu: /(^|\.)xiaohongshu\.com$/i,
      wechat: /(^|\.)(mp\.)?weixin\.qq\.com$/i,
      douyin: /(^|\.)douyin\.com$/i,
    };
    const SUFFIX: Record<"weibo" | "xiaohongshu" | "wechat" | "douyin", string> = {
      weibo: "weibo.com",
      xiaohongshu: "xiaohongshu.com",
      wechat: "mp.weixin.qq.com",
      douyin: "douyin.com",
    };
    const baseNote = `${platform} 未配置 MCP（${reason}），且无登录态无法直接抓取正文`;

    // 先用多引擎做 `site:` 限定并过滤出平台域名条目
    const relayQuery = `${keyword} site:${SUFFIX[platform]}`;
    const web = await this.searchWeb(relayQuery, limit);
    const matched = web.items.filter((it) => {
      try {
        return MATCH[platform].test(new URL(it.url).hostname);
      } catch {
        return false;
      }
    });
    if (matched.length > 0) {
      // 格式：相邻行 {标题}\n{url}\n{摘要}，兼容 rawToItems 的「上一行/下一行」解析
      const raw = matched.map((it) => `${it.title || ""}\n${it.url}\n${(it.snippet || "").slice(0, 220)}`).join("\n");
      return {
        provider: `${platform}-relay`,
        raw,
        notes: [`${baseNote}，已返回被搜索引擎收录的 ${platform} 页面（间接结果，可能不完整）`],
      };
    }

    // 抖音：定向搜索不可得时，官方热榜接口可拿到（word_list），作为「抖音信息」的可得来源
    if (platform === "douyin") {
      const hot = await this.fetchDouyinHotSearch(Math.max(5, limit));
      if (hot.length > 0) {
        const raw = hot.map((it) => `${it.title}\n${it.url}\n${it.snippet}`).join("\n");
        return {
          provider: "douyin-hot",
          raw,
          notes: [`${baseNote}，已返回抖音官方热榜（非关键词精确结果，仅热点话题）`],
        };
      }
    }

    return {
      provider: `${platform}-relay`,
      raw: "",
      notes: [`${baseNote}；公开搜索引擎也未返回该平台域名页面，建议配置 mcporter 的 ${platform} server 以获取完整结果`],
    };
  }

  /** 抖音官方热榜公开接口（实测 word_list 可拿，无登录态） */
  private async fetchDouyinHotSearch(limit: number): Promise<UnifiedSearchItem[]> {
    const text = await this.fetchText(
      "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp",
      6000,
    );
    if (!text) return [];
    try {
      const data = JSON.parse(text) as { data?: { word_list?: Array<{ word?: string; hot_value?: number; sentence?: string }> } };
      const list = data?.data?.word_list ?? [];
      return list
        .slice(0, limit)
        .map((w) => {
          const word = String(w?.word ?? "").trim();
          if (!word) return null;
          const hotValue = Number.isFinite(w?.hot_value) ? `（热度 ${w?.hot_value}）` : "";
          return {
            title: `#${word}${hotValue}`,
            url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
            snippet: String(w?.sentence ?? w?.word ?? "").slice(0, 120) || "抖音热榜",
            source: "抖音热榜",
            platform: "douyin" as const,
          };
        })
        .filter((x): x is { title: string; url: string; snippet: string; source: string; platform: "douyin" } => x !== null);
    } catch {
      return [];
    }
  }

  private async callMcporterAttempts(
    callExprList: string[],
    timeoutMs: number,
  ): Promise<{ ok: true; stdout: string } | { ok: false; note: string }> {
    for (const callExpr of callExprList) {
      const run = await this.runCommand(resolveBin("mcporter"), ["call", callExpr], timeoutMs);
      if (run.ok) {
        return { ok: true, stdout: run.stdout };
      }
    }
    return { ok: false, note: "mcporter 调用失败，请确认已安装并完成对应平台 MCP 配置" };
  }

  private async runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 6,
        windowsHide: true,
      });
      return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof err.code === "number" ? err.code : 1;
      if (err.code === "ENOENT") {
        return {
          ok: false,
          stdout: "",
          stderr: `${command} 未安装或不在 PATH 中`,
          code,
        };
      }
      return {
        ok: false,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? "命令执行失败"),
        code,
      };
    }
  }

  private async fetchText(url: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent":
            process.env.WEB_FETCH_USER_AGENT ??
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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

  private async materializeImageResults(
    items: MediaSearchItem[],
    actorId: string,
    limit: number,
  ): Promise<MediaSearchItem[]> {
    const storage = this.imageStorageService;
    if (!storage) return items.slice(0, limit);
    const out: MediaSearchItem[] = [];
    // 硬预算：整个转存阶段必须在预算内返回（无论是否全部完成），
    // 否则整次 search_images 会在外圈 12s 工具超时里被整体 kill、items 归零，
    // 导致前端媒体卡片无法注入、照片展示不出来。这里返回"已达成的部分结果"即可。
    const deadline = Date.now() + IMAGE_MATERIALIZE_BUDGET_MS;
    let cursor = 0;

    const workers = Array.from({ length: IMAGE_MATERIALIZE_CONCURRENCY }, async () => {
      while (out.length < limit) {
        if (Date.now() >= deadline) return;
        const idx = cursor++;
        const item = items[idx];
        if (!item) return;
        const remoteUrl = item.mediaUrl || item.thumbnailUrl;
        if (!remoteUrl) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        try {
          // 用剩余预算作为本次下载的截断超时，确保并发任务不会越过预算、
          // Promise.all 能及时收尾，避免整体超时导致 items 丢失。
          const pngUrl = await storage.downloadAndStorePng(remoteUrl, actorId, remaining);
          out.push({
            ...item,
            mediaUrl: pngUrl,
            thumbnailUrl: pngUrl,
            snippet: [item.snippet, "已转存为 PNG"].filter(Boolean).join("；"),
          });
        } catch {
          // 某些外站图片会防盗链或格式不受支持，跳过该候选，继续转存下一张。
        }
      }
    });

    await Promise.all(workers);
    return out;
  }
}

// 图片转存的并发数（并行下载，避免逐张串行拖垮 12s 工具超时）
const IMAGE_MATERIALIZE_CONCURRENCY = 3;
// 图片转存阶段的硬预算：在此时间内返回已达成的部分 items，
// 保证 search_images 在工具超时前正常 resolve，前端能拿到媒体卡片。
const IMAGE_MATERIALIZE_BUDGET_MS = 6_500;
// 图片结果页抓取超时：配合转存预算，保证"抓取 + 转存"总耗时 < 12s 工具预算。
const IMAGE_FETCH_TIMEOUT_MS = 5_000;

function clamp(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) return min;
  return Math.max(min, Math.min(max, Math.floor(input)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 对比式批量图片搜索：代码层拆「A vs B」两侧 + 多维度分组（不依赖 LLM prompt）
// ─────────────────────────────────────────────────────────────────────────────

/** 对比分组数量上限（受 12s 工具超时约束，避免并行搜索过多拖垮整体） */
const MAX_COMPARE_GROUPS = 3;
/** 单侧最多保留图片张数 */
const MAX_IMAGES_PER_SIDE = 3;
/** 维度标题里需要剔除的噪音词 */
const DIMENSION_FILTER_WORDS = [
  "图片", "照片", "图", "长什么样", "长啥样", "怎么样", "什么样", "样子",
  "对比", "比較", "比较", "哪个好", "怎么选", "选择", "选哪个", "看看", "有哪些", "推荐",
];

/**
 * 从 query 中识别成对对比结构：`A vs B` / `A对比B` / `A比较B` / `A pk B` /
 * `A和B对比` / `A与B对比`。需要显式对比连接词，避免误拆普通并列（"鱼和薯条"）。
 * 返回 null 表示非成对 query。
 */
function splitCompareQuery(query: string): { sideA: string; sideB: string } | null {
  const q = String(query ?? "").trim().replace(/\s+/g, " ");
  if (!q) return null;

  // 1) 中置对比连接词：A vs B / A对比B / A比较B / A pk B
  const mid = q.match(
    /^(.*?)\s+(?:vs|VS|pk|PK|对比|比較|比较)(?:\s*[:：]\s*|\s+)(.*)$/,
  );
  if (mid && mid[1].trim() && mid[2].trim()) {
    return { sideA: mid[1].trim(), sideB: mid[2].trim() };
  }

  // 2) 尾部对比结构：A和B对比 / A与B比较（连接词在句末）
  const tail = q.match(
    /^(.*?)(?:和|与)(.*?)(?:对比|比較|比较|PK|pk|哪个好|怎么选|选哪个|选择)(?:\s*)$/,
  );
  if (tail && tail[1].trim() && tail[2].trim()) {
    return { sideA: tail[1].trim(), sideB: tail[2].trim() };
  }

  return null;
}

/**
 * 最长公共子串：用于从「马尔代夫水屋 vs 印尼水屋」这类成对 query 中
 * 提取两侧公共的维度词（如「水屋」）。query 短（<40 字符），O(n³) 可接受。
 */
function longestCommonSubstring(a: string, b: string): string {
  if (!a || !b) return "";
  let best = "";
  const n = a.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= n; j++) {
      const sub = a.slice(i, j);
      if (sub.trim().length > best.length && b.includes(sub)) {
        best = sub;
      }
    }
  }
  return best.trim();
}

/** 清洗维度标题：剔除「图片/对比/哪个好」等噪音词，压缩空白。 */
function cleanDimension(dim: string): string {
  if (!dim) return "";
  let out = dim.trim();
  for (const w of DIMENSION_FILTER_WORDS) {
    out = out.split(w).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 给每张图打上对比分组元数据（供前端按维度分组、左右分栏渲染）。 */
function tagCompareSide(
  items: MediaSearchItem[],
  side: "A" | "B",
  label: string,
  group: string,
): MediaSearchItem[] {
  return items.map((it) => ({
    ...it,
    compareSide: side,
    compareLabel: label,
    compareGroup: group,
  }));
}

/**
 * 依据返回结果中的来源(source)推断实际使用的搜索提供方。
 * 搜索 API 命中时，其 result 的 source 会带 API 名（search-api-provider 的 toItems 传入）。
 * 用此判断 API 是否真正生效，避免 provider 恒为爬虫名的可观测盲区。
 */
function inferSearchProvider(items: InfoSearchItem[]): string {
  const apiSources = ["Tavily", "Serper", "Bing API", "Jina", "AnySearch"];
  const present = new Set<string>();
  for (const item of items) {
    if (item.source) present.add(item.source);
  }
  // 若 API 来源确实出现在结果里，优先标记为 api:xxx；否则视为未走 API，保持国内爬虫名。
  for (const name of apiSources) {
    if (present.has(name)) return `api:${name.toLowerCase().replace(/\s+/g, "-")}`;
  }
  return "domestic-bing-cn";
}

function formatFailure(name: string, run: CommandResult): string {
  const msg = run.stderr || run.stdout || "无错误输出";
  return `${name} 调用失败(${run.code}): ${msg.slice(0, 300)}`;
}

function rawToItems(raw: string, source: string, platform: string): UnifiedSearchItem[] {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: UnifiedSearchItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/https?:\/\/\S+/i);
    if (!m) continue;
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: lines[i - 1]?.slice(0, 180) || url,
      url,
      snippet: lines[i + 1]?.slice(0, 220) || "",
      source,
      platform,
    });
  }
  return out;
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

function dedupeText(items: string[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const s = item.trim();
    if (s) set.add(s);
  }
  return Array.from(set);
}

function parseBingImageResults(html: string, limit: number): MediaSearchItem[] {
  const out: MediaSearchItem[] = [];
  const seen = new Set<string>();
  const attrRe = /\bm=(["'])([\s\S]*?)\1/gi;
  let m: RegExpExecArray | null = null;
  while ((m = attrRe.exec(html))) {
    const decoded = decodeHtmlEntities(m[2] ?? "");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(decoded);
    } catch {
      continue;
    }
    const mediaUrl = pickString(data.murl);
    const thumbnailUrl = pickString(data.turl);
    const pageUrl = pickString(data.purl) || mediaUrl;
    if (!pageUrl || (!mediaUrl && !thumbnailUrl)) continue;
    const key = (mediaUrl || pageUrl).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "image",
      title: pickString(data.t) || pickString(data.desc) || "图片结果",
      pageUrl,
      mediaUrl,
      thumbnailUrl,
      source: inferMediaSource(pageUrl, "Bing Images"),
      width: pickNumber(data.w),
      height: pickNumber(data.h),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function parseBingVideoResults(html: string, limit: number): MediaSearchItem[] {
  const out: MediaSearchItem[] = [];
  const seen = new Set<string>();
  const blockRe = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null = null;
  while ((m = blockRe.exec(html))) {
    const rawHref = decodeHtmlEntities(m[2] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    let pageUrl = rawHref;
    try {
      pageUrl = new URL(rawHref, "https://cn.bing.com/videos/search").toString();
    } catch {
      continue;
    }
    if (!isLikelyVideoUrl(pageUrl) && !/\/videos\//i.test(pageUrl)) continue;
    const chunk = m[0];
    const title = decodeHtmlEntities(stripTags(m[3] ?? "")).slice(0, 160) || "视频结果";
    // 优先取结果块自带的 data-thumbnail（真实缩略图地址），其次 <img> 的 src；
    // 两者都没有则该视频无真实缩略图（前端显示视频占位图标，不再把播放页/
    // 搜索页 URL 当作图片地址下发，避免前端 Image.network 加载 HTML 破图）。
    const dataThumb = chunk.match(/data-thumbnail=(["'])([^"']+)\1/i);
    const imgSrc = chunk.match(/<img\b[^>]*\bsrc=(["'])([^"']+)\1/i);
    const rawThumb = dataThumb?.[2] ?? imgSrc?.[2];
    const thumbnailUrl = rawThumb ? absolutizeBingUrl(decodeHtmlEntities(rawThumb)) : undefined;
    const key = pageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "video",
      title,
      pageUrl,
      mediaUrl: pageUrl,
      thumbnailUrl,
      source: inferMediaSource(pageUrl, "Bing Videos"),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function dedupeMediaByPageUrl(items: MediaSearchItem[]): MediaSearchItem[] {
  const seen = new Set<string>();
  const out: MediaSearchItem[] = [];
  for (const item of items) {
    const key = item.pageUrl.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function absolutizeBingUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, "https://cn.bing.com").toString();
  } catch {
    return undefined;
  }
}

function isLikelyVideoUrl(url: string): boolean {
  return /(?:youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video\/|v\.qq\.com|ixigua\.com|douyin\.com|kuaishou\.com|youku\.com|iqiyi\.com|mgtv\.com|\/video\/)/i.test(url);
}

function inferMediaSource(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (/youtube\.com|youtu\.be/.test(host)) return "YouTube";
    if (/bilibili\.com/.test(host)) return "Bilibili";
    if (/douyin\.com/.test(host)) return "抖音";
    if (/ixigua\.com/.test(host)) return "西瓜视频";
    if (/qq\.com/.test(host)) return "腾讯视频";
    if (/youku\.com/.test(host)) return "优酷";
    if (/iqiyi\.com/.test(host)) return "爱奇艺";
    if (/mgtv\.com/.test(host)) return "芒果TV";
    return host || fallback;
  } catch {
    return fallback;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function resolveBin(defaultName: "mcporter" | "gh" | "rdt"): string {
  switch (defaultName) {
    case "mcporter":
      return process.env.MCPORTER_BIN?.trim() || "mcporter";
    case "gh":
      return process.env.GH_BIN?.trim() || "gh";
    case "rdt":
      return process.env.RDT_BIN?.trim() || "rdt";
    default:
      return defaultName;
  }
}
