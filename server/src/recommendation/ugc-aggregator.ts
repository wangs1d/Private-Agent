/**
 * 推荐口碑 UGC 聚合（方案 docs/recommendation-value-upgrade-plan.md P3）。
 *
 * 数据源：小红书搜索（mcporter xiaohongshu/xhs alias，与社交域共用同一
 * upstreamSearchService 通道）。定位是「真实口碑摘要」：优缺点从真实帖子
 * 标题规则抽取（平台词表），来源帖子标题+链接随卡下发可点——LLM 不参与
 * 内容生成（防编造口碑），后续可加 LLM 去重合并（端口已留）。
 *
 * 容错纪律：mcporter alias 未配置 / 搜索失败 / 无帖子 → 返回 null，卡片
 * 口碑区整体不渲染（不装作有口碑）；死线由调用方控制（推荐链路总预算内）。
 */

import type { SuggestUgc, SuggestUgcPost } from "./suggest-engine.js";

/** 从 mcporter raw 输出宽容解析帖子列表：JSON 优先，markdown 链接兜底 */
export function parseUgcPosts(raw: string): SuggestUgcPost[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  // 1) JSON：直接解析或提取首个 {...}/[...] 块；递归找带 title 的数组
  const jsonish = extractJsonish(text);
  if (jsonish) {
    const posts = collectTitleEntries(jsonish);
    if (posts.length > 0) return posts;
  }

  // 2) markdown 链接兜底：[title](url)
  const out: SuggestUgcPost[] = [];
  for (const m of text.matchAll(/\[([^\]\n]{4,80})\]\((https?:\/\/[^\s)]+)\)/g)) {
    const title = (m[1] ?? "").trim();
    const url = (m[2] ?? "").trim();
    if (title) out.push({ title, url });
  }
  if (out.length > 0) return dedupePosts(out);

  // 3) 行式兜底：`- 标题` / `1. 标题`（mcporter 文本输出）
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/^[\s\-*\d.、]+/, "").trim();
    if (t.length >= 8 && t.length <= 80 && !/^(ok|done|error|失败|成功)/i.test(t)) {
      out.push({ title: t });
    }
  }
  return dedupePosts(out).slice(0, 12);
}

/** 宽容提取 JSON 值：直接 parse → 围栏 → 首个 {..} / [..] 平衡块 */
function extractJsonish(text: string): unknown {
  const attempts = [text, ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)).map((m) => m[1] ?? "")];
  for (const candidate of attempts) {
    const t = candidate.trim();
    if (!t) continue;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      /* 继续 */
    }
    for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
      const start = t.indexOf(open);
      const end = t.lastIndexOf(close);
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(t.slice(start, end + 1)) as unknown;
        } catch {
          /* 继续 */
        }
      }
    }
  }
  return null;
}

/** 递归收集形如 {title, url?} 的对象（mcporter JSON 结构未固定，宽容匹配） */
function collectTitleEntries(node: unknown, depth = 0): SuggestUgcPost[] {
  if (depth > 4 || node == null) return [];
  if (Array.isArray(node)) {
    const out: SuggestUgcPost[] = [];
    for (const item of node) {
      if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        const title = String(o.title ?? o.name ?? o.note_title ?? "").trim();
        if (title) {
          const url = String(o.url ?? o.link ?? o.note_url ?? o.href ?? "").trim() || undefined;
          out.push({ title, ...(url ? { url } : {}) });
        }
      }
    }
    if (out.length > 0) return out;
    for (const item of node) {
      const nested = collectTitleEntries(item, depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const nested = collectTitleEntries(value, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function dedupePosts(posts: SuggestUgcPost[]): SuggestUgcPost[] {
  const seen = new Set<string>();
  const out: SuggestUgcPost[] = [];
  for (const p of posts) {
    const key = p.title.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** 好评/避雷词表：从真实帖子标题抽取（覆盖不到的进 mentions 不进 pros/cons） */
const PROS_WORDS_RE =
  /(值得买|值得入手|推荐|好用|真香|无脑入|闭眼入|性价比|天花板|惊喜|满意|表现好|主力|耐用|越用越香)/;
const CONS_WORDS_RE =
  /(踩雷|翻车|避雷|不建议|别买|不要买|后悔|拉胯|失望|短板|小坑|劝退|溢价|智商税|衰减|翻新)/;

/** 规则抽取口碑摘要：标题含好评/避雷词分桶，其余计提及 */
export function summarizeUgc(posts: SuggestUgcPost[]): {
  mentions: number;
  pros: string[];
  cons: string[];
} {
  const pros: string[] = [];
  const cons: string[] = [];
  for (const p of posts) {
    if (CONS_WORDS_RE.test(p.title)) cons.push(p.title);
    else if (PROS_WORDS_RE.test(p.title)) pros.push(p.title);
  }
  return {
    mentions: posts.length,
    pros: pros.slice(0, 3),
    cons: cons.slice(0, 2),
  };
}

export interface UgcSearchDeps {
  /** 小红书搜索端口（装配段注入 upstreamSearchService.searchXiaohongshu） */
  search: (query: string, limit?: number) => Promise<{ raw: string } | null>;
  now?: () => number;
}

/**
 * 聚合主推商品的小红书口碑：搜索 → 解析帖子 → 规则抽取摘要。
 * 无结果/失败/超时返回 null（调用方不附口碑区，不阻断推荐）。
 */
export async function aggregateXiaohongshuUgc(
  deps: UgcSearchDeps,
  productName: string,
  opts: { deadlineMs?: number } = {},
): Promise<SuggestUgc | null> {
  const label = String(productName ?? "").trim();
  if (!label || typeof deps.search !== "function") return null;

  const deadlineMs = opts.deadlineMs ?? 6_000;
  const budget = deadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = Promise.race([
    deps.search(`${label} 值得买`, 10).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budget);
    }),
  ]).finally(() => clearTimeout(timer));

  const res = await search;
  const posts = res ? parseUgcPosts(res.raw) : [];
  if (posts.length === 0) return null;

  const { mentions, pros, cons } = summarizeUgc(posts);
  return {
    platform: "xiaohongshu",
    platformLabel: "小红书",
    mentions,
    ...(pros.length > 0 ? { pros } : {}),
    ...(cons.length > 0 ? { cons } : {}),
    posts: posts.slice(0, 4),
  };
}
