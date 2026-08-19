import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InfoHubService, InfoSearchItem } from "./info-hub-service.js";
import {
  applySearchFreshness,
  formatSearchFreshnessNote,
  getSearchAnchorNow,
  SearchCache,
} from "./search-enhancements.js";
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
};

export class UpstreamSearchService {
  // 社交平台搜索结果缓存（3 分钟 TTL，避免重复调用 mcporter）
  private readonly socialCache = new SearchCache<{ provider: string; raw: string; notes: string[] }>({
    maxSize: 50,
    ttlMs: 3 * 60 * 1000,
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
    const raw = await this.infoHubService.search(keyword, boundedLimit);
    const fresh = applySearchFreshness(raw, { query: keyword });
    const maxAgeDays = Number(process.env.SEARCH_MAX_ITEM_AGE_DAYS ?? 120);
    return {
      provider: "domestic-bing-cn",
      items: fresh.items,
      fetchedAt: anchor.iso,
      searchDateLocal: anchor.label,
      notes: [
        "必应中国 RSS + 国内科技 RSS",
        formatSearchFreshnessNote({ anchor, droppedStale: fresh.droppedStale, maxAgeDays }),
      ],
    };
  }

  async searchImages(query: string, limit = 8, actorId = "anonymous"): Promise<{
    provider: string;
    mediaType: "image";
    items: MediaSearchItem[];
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "bing-images", mediaType: "image", items: [], notes: ["query 不能为空"] };
    }
    const boundedLimit = clamp(limit, 1, 12);
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
      return { provider: "weibo", raw: "", notes: [run.note] };
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
      return { provider: "xiaohongshu", raw: "", notes: [run.note] };
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
      return { provider: "wechat", raw: "", notes: [run.note] };
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
      return { provider: "douyin", raw: "", notes: [run.note] };
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
    const imgMatch = chunk.match(/<img\b[^>]*\bsrc=(["'])(.*?)\1/i);
    const thumbnailUrl = imgMatch ? absolutizeBingUrl(decodeHtmlEntities(imgMatch[2] ?? "")) : undefined;
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
