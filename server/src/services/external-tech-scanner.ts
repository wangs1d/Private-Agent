/**
 * 外部技术扫描器（Phase 5.1）
 *
 * 设计原则（Token 节省）：
 * - L1 规则层（无 LLM）：定期用 HTTP 拉取 GitHub releases + npm registry，
 *   对比当前已安装版本，纯规则判断"是否有新版本"。
 * - L2 LLM 层（仅发现新版本时）：调用 mini 模型评估升级收益/风险，输出 JSON。
 *   90%+ 扫描无新版本时跳过 LLM；有新版本时输入仅 changelog 摘要（≤ 2000 char）。
 * - 复用 LlmResponseCache（namespace="tech_scanner", TTL=24h）避免重复评估同一版本。
 *
 * 降级开关：BRAIN_TECH_SCANNER_ENABLED=0 时 scan() 直接返回空数组。
 *
 * 安全约束：
 * - 只读外部 API（GET），不写入任何文件
 * - URL 白名单（api.github.com / registry.npmjs.org），防 SSRF
 * - 升级提案走 EvolutionCortex 管线，需用户确认才执行
 */

import type { ExternalChatProvider } from "../external-model/types.js";
import { TaskTier, getModelOverrideForTask } from "../config/model-routing.js";
import { getLlmResponseCache } from "./llm-response-cache.js";

/** 技术关注项（来自 tech-watchlist.json） */
export interface TechWatchItem {
  /** 关注领域标识，如 "asr" / "tts" / "vlm" / "llm" / "mcp" */
  domain: string;
  /** GitHub repo（可选），如 "openai/whisper" */
  githubRepo?: string;
  /** npm 包名（可选），如 "whisper.cpp" */
  npmPackage?: string;
  /** 当前已安装版本（可选，用于对比） */
  currentVersion?: string;
  /** 备注（人类可读） */
  note?: string;
}

/** 扫描结果 */
export interface TechScanResult {
  /** 关注项 */
  watch: TechWatchItem;
  /** 最新版本（API 返回） */
  latestVersion: string | null;
  /** 是否有新版本 */
  hasUpdate: boolean;
  /** L2 评估结果（仅 hasUpdate=true 时） */
  assessment?: {
    upgradeBenefit: "high" | "medium" | "low";
    riskLevel: "high" | "medium" | "low";
    suggestedAction: string;
    rationale: string;
  };
  /** 扫描时间戳 */
  scannedAt: string;
  /** 错误信息（API 失败等） */
  error?: string;
}

/** 是否启用技术扫描 */
export function isTechScannerEnabled(): boolean {
  const raw = process.env.BRAIN_TECH_SCANNER_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/** URL 白名单（防 SSRF） */
const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "registry.npmjs.org",
]);

/** 默认 watchlist（可通过 tech-watchlist.json 覆盖） */
const DEFAULT_WATCHLIST: TechWatchItem[] = [
  { domain: "asr", githubRepo: "openai/whisper", note: "语音识别" },
  { domain: "tts", githubRepo: "coqui-ai/TTS", note: "语音合成" },
  { domain: "vlm", npmPackage: "@anthropic-ai/sdk", note: "视觉语言模型 SDK" },
  { domain: "mcp", npmPackage: "@modelcontextprotocol/sdk", note: "MCP 协议 SDK" },
];

/**
 * 简单 HTTP GET（Node.js 原生 fetch，Node 18+ 内置）。
 * 仅允许白名单 host，防 SSRF。
 */
async function safeGet(url: string, opts: { headers?: Record<string, string> } = {}): Promise<{ ok: boolean; status: number; text: string }> {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, status: 0, text: `host not allowed: ${parsed.hostname}` };
  }
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "PrivateAgent-TechScanner/1.0", ...opts.headers },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: String(err) };
  }
}

/** 从 GitHub releases API 解析最新版本 */
function parseLatestGitHubRelease(text: string): string | null {
  try {
    const data = JSON.parse(text) as { tag_name?: string };
    if (data.tag_name) {
      // 去掉 v 前缀
      return data.tag_name.replace(/^v/, "");
    }
    return null;
  } catch {
    return null;
  }
}

/** 从 npm registry 解析最新版本 */
function parseLatestNpmVersion(text: string): string | null {
  try {
    const data = JSON.parse(text) as { "dist-tags"?: { latest?: string } };
    return data["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}

/** 版本比较：返回 true 表示 latest > current */
function isNewerVersion(current: string, latest: string): boolean {
  const parseVer = (v: string) => v.split(".").map((n) => parseInt(n.replace(/\D/g, "") || "0", 10));
  const c = parseVer(current);
  const l = parseVer(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const ci = c[i] ?? 0;
    const li = l[i] ?? 0;
    if (li > ci) return true;
    if (li < ci) return false;
  }
  return false;
}

/**
 * 外部技术扫描器
 *
 * 使用方式：
 *   const scanner = new ExternalTechScanner(provider);
 *   const results = await scanner.scan(watchlist);
 *   // results 中 hasUpdate=true 的项可走 EvolutionCortex 提案
 */
export class ExternalTechScanner {
  private readonly provider: ExternalChatProvider | null;
  private readonly cache = getLlmResponseCache().forNamespace<TechScanResult["assessment"]>({
    namespace: "tech_scanner",
    ttlMs: 24 * 60 * 60 * 1000, // 24 小时
    maxSize: 64,
  });

  constructor(provider: ExternalChatProvider | null = null) {
    this.provider = provider;
  }

  /**
   * 扫描关注列表，返回每个项的最新版本信息
   * @param watchlist 关注列表（默认使用 DEFAULT_WATCHLIST）
   */
  async scan(watchlist: TechWatchItem[] = DEFAULT_WATCHLIST): Promise<TechScanResult[]> {
    if (!isTechScannerEnabled()) return [];

    const results: TechScanResult[] = [];
    for (const item of watchlist) {
      const result = await this.scanOne(item);
      results.push(result);
    }
    return results;
  }

  private async scanOne(watch: TechWatchItem): Promise<TechScanResult> {
    const scannedAt = new Date().toISOString();
    let latestVersion: string | null = null;
    let error: string | undefined;

    // L1 规则层：拉取最新版本
    if (watch.githubRepo) {
      const url = `https://api.github.com/repos/${watch.githubRepo}/releases/latest`;
      const resp = await safeGet(url, { headers: { Accept: "application/vnd.github+json" } });
      if (resp.ok) {
        latestVersion = parseLatestGitHubRelease(resp.text);
      } else {
        error = `github_api_${resp.status}`;
      }
    } else if (watch.npmPackage) {
      const url = `https://registry.npmjs.org/${encodeURIComponent(watch.npmPackage)}`;
      const resp = await safeGet(url);
      if (resp.ok) {
        latestVersion = parseLatestNpmVersion(resp.text);
      } else {
        error = `npm_api_${resp.status}`;
      }
    }

    const hasUpdate = latestVersion !== null && (
      !watch.currentVersion || isNewerVersion(watch.currentVersion, latestVersion)
    );

    const result: TechScanResult = {
      watch,
      latestVersion,
      hasUpdate,
      scannedAt,
      error,
    };

    // L2 LLM 层：仅发现新版本时评估
    if (hasUpdate && latestVersion) {
      result.assessment = await this.assessUpgrade(watch, latestVersion);
    }

    return result;
  }

  /**
   * L2：用 mini 模型评估升级收益/风险
   * 输入仅版本号 + 关注项备注，输出 JSON
   */
  private async assessUpgrade(
    watch: TechWatchItem,
    latestVersion: string,
  ): Promise<TechScanResult["assessment"] | undefined> {
    // 缓存命中（同一版本 24h 内不重复评估）
    const cacheKey = `${watch.domain}:${latestVersion}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!this.provider?.isEnabled()) return undefined;

    const prompt =
      `评估技术升级。只返回 JSON。\n\n` +
      `领域：${watch.domain}\n` +
      `包：${watch.githubRepo ?? watch.npmPackage ?? "(unknown)"}\n` +
      `新版本：${latestVersion}\n` +
      `当前版本：${watch.currentVersion ?? "(未安装)"}\n` +
      `备注：${watch.note ?? ""}\n\n` +
      `输出 JSON：{"upgradeBenefit":"high|medium|low","riskLevel":"high|medium|low","suggestedAction":"简短一句话","rationale":"简短理由"}`;

    let raw = "";
    try {
      await this.provider.streamCompletion(
        `tech-scan:${watch.domain}:${Date.now()}`,
        { text: prompt },
        (delta) => { raw += delta; },
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 0,
          modelOverride: getModelOverrideForTask(TaskTier.MINI),
        },
      );
    } catch {
      return undefined;
    }

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return undefined;

    try {
      const parsed = JSON.parse(match[0]) as {
        upgradeBenefit: string;
        riskLevel: string;
        suggestedAction: string;
        rationale: string;
      };
      const assessment: TechScanResult["assessment"] = {
        upgradeBenefit: (["high", "medium", "low"].includes(parsed.upgradeBenefit) ? parsed.upgradeBenefit : "medium") as "high" | "medium" | "low",
        riskLevel: (["high", "medium", "low"].includes(parsed.riskLevel) ? parsed.riskLevel : "medium") as "high" | "medium" | "low",
        suggestedAction: String(parsed.suggestedAction ?? "").slice(0, 200),
        rationale: String(parsed.rationale ?? "").slice(0, 200),
      };
      this.cache.set(cacheKey, assessment);
      return assessment;
    } catch {
      return undefined;
    }
  }

  /** 获取默认 watchlist */
  static getDefaultWatchlist(): TechWatchItem[] {
    return DEFAULT_WATCHLIST;
  }
}
