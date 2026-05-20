import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InfoHubService, InfoSearchItem } from "./info-hub-service.js";

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

export class UpstreamSearchService {
  constructor(private readonly infoHubService: InfoHubService) {}

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
    const limit = clamp(Number(input.limit ?? 8), 1, 20);
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

    const web = await this.searchWeb(query, limit);
    notes.push(...web.notes);
    pushItems(web.items.map((x) => ({ ...x, platform: "web" })));

    // 中文语境下优先补充国内平台结果。
    if (hasChinese(query) || /微博|小红书|公众号|抖音|b站|国内/.test(query.toLowerCase())) {
      const [weibo, xhs, wechat] = await Promise.all([
        this.searchWeibo(query, Math.min(8, limit)),
        this.searchXiaohongshu(query, Math.min(8, limit)),
        this.searchWechat(query, Math.min(8, limit)),
      ]);
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

  async searchWeb(query: string, limit = 8): Promise<{
    provider: string;
    items: InfoSearchItem[];
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "none", items: [], notes: ["query 不能为空"] };
    }
    const boundedLimit = clamp(limit, 1, 20);
    const items = await this.infoHubService.search(keyword, boundedLimit);
    return {
      provider: "domestic-bing-cn",
      items,
      notes: ["必应中国 RSS + 国内科技 RSS"],
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
      return { provider: "yt-dlp", title: "", channel: "", description: "", notes: ["url 不能为空"] };
    }
    const run = await this.runCommand(resolveBin("yt-dlp"), ["--dump-json", "--skip-download", rawUrl], 25000);
    if (!run.ok) {
      return {
        provider: "yt-dlp",
        title: "",
        channel: "",
        description: "",
        notes: [formatFailure("yt-dlp", run)],
      };
    }
    try {
      const parsed = JSON.parse(run.stdout) as {
        title?: string;
        uploader?: string;
        duration?: number;
        description?: string;
      };
      return {
        provider: "yt-dlp",
        title: parsed.title ?? "",
        channel: parsed.uploader ?? "",
        durationSeconds: Number.isFinite(parsed.duration) ? parsed.duration : undefined,
        description: String(parsed.description ?? "").slice(0, 5000),
        notes: [],
      };
    } catch {
      return {
        provider: "yt-dlp",
        title: "",
        channel: "",
        description: run.stdout.slice(0, 5000),
        notes: ["yt-dlp 输出不是 JSON，已返回原始文本片段"],
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
    const attempts = [
      `weibo.search_weibo_content(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `weibo.search_content(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `weibo.get_trendings(limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 20000);
    if (!run.ok) {
      return { provider: "weibo", raw: "", notes: [run.note] };
    }
    return { provider: "weibo", raw: run.stdout.slice(0, 12000), notes: [] };
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
      return { provider: "bilibili", title: "", channel: "", description: "", notes: ["url 不能为空"] };
    }
    const run = await this.runCommand(resolveBin("yt-dlp"), ["--dump-json", "--skip-download", rawUrl], 25000);
    if (!run.ok) {
      return {
        provider: "bilibili",
        title: "",
        channel: "",
        description: "",
        notes: [formatFailure("yt-dlp", run)],
      };
    }
    try {
      const parsed = JSON.parse(run.stdout) as {
        title?: string;
        uploader?: string;
        duration?: number;
        description?: string;
      };
      return {
        provider: "bilibili",
        title: parsed.title ?? "",
        channel: parsed.uploader ?? "",
        durationSeconds: Number.isFinite(parsed.duration) ? parsed.duration : undefined,
        description: String(parsed.description ?? "").slice(0, 5000),
        notes: [],
      };
    } catch {
      return {
        provider: "bilibili",
        title: "",
        channel: "",
        description: run.stdout.slice(0, 5000),
        notes: ["yt-dlp 输出不是 JSON，已返回原始文本片段"],
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
    const attempts = [
      `xiaohongshu.search_feeds(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `xhs.search_feeds(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 25000);
    if (!run.ok) {
      return { provider: "xiaohongshu", raw: "", notes: [run.note] };
    }
    return { provider: "xiaohongshu", raw: run.stdout.slice(0, 12000), notes: [] };
  }

  async searchWechat(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "wechat", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const attempts = [
      `wechat.search_articles(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `wechat.search_wechat_articles(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `wechat.search(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 25000);
    if (!run.ok) {
      return { provider: "wechat", raw: "", notes: [run.note] };
    }
    return { provider: "wechat", raw: run.stdout.slice(0, 12000), notes: [] };
  }

  async searchDouyin(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "douyin", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const attempts = [
      `douyin.search(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `douyin.search_videos(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 25000);
    if (!run.ok) {
      return { provider: "douyin", raw: "", notes: [run.note] };
    }
    return { provider: "douyin", raw: run.stdout.slice(0, 12000), notes: [] };
  }

  async checkUpstreamHealth(): Promise<{
    bins: Record<string, { ok: boolean; detail: string }>;
    mcpHints: Record<string, string>;
  }> {
    const targets: Array<{ key: string; bin: string }> = [
      { key: "mcporter", bin: resolveBin("mcporter") },
      { key: "gh", bin: resolveBin("gh") },
      { key: "rdt", bin: resolveBin("rdt") },
      { key: "yt-dlp", bin: resolveBin("yt-dlp") },
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
}

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

function resolveBin(defaultName: "mcporter" | "gh" | "rdt" | "yt-dlp"): string {
  switch (defaultName) {
    case "mcporter":
      return process.env.MCPORTER_BIN?.trim() || "mcporter";
    case "gh":
      return process.env.GH_BIN?.trim() || "gh";
    case "rdt":
      return process.env.RDT_BIN?.trim() || "rdt";
    case "yt-dlp":
      return process.env.YTDLP_BIN?.trim() || "yt-dlp";
    default:
      return defaultName;
  }
}
