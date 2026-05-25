import type { InfoSearchItem } from "./info-hub-service.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_MAX_AGE_DAYS = Number(process.env.SEARCH_MAX_ITEM_AGE_DAYS ?? 120);

const STALE_QUERY_ALLOW_RE =
  /历史|去年|往年|回顾|成立于|发展历程|发展史|是什么|百科|维基|wiki|历年|过去\d+年/i;

const RECENCY_QUERY_BOOST_RE =
  /最新|最近|今天|今日|昨晚|刚刚|实时|新闻|股价|行情|公告|热映|排片|电影|天气|价格|赛程|版本|发布|动态|头条|资讯|调研|公司|股票|\d{6}\b|20\d{2}年?\d{0,2}月?/i;

export type SearchAnchorNow = {
  iso: string;
  year: number;
  month: number;
  day: number;
  label: string;
};

export function getSearchAnchorNow(timezone = DEFAULT_TIMEZONE): SearchAnchorNow {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? now.getUTCFullYear());
  const month = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  const day = Number(parts.find((p) => p.type === "day")?.value ?? 1);
  const label = `${year}年${month}月${day}日`;
  return { iso: now.toISOString(), year, month, day, label };
}

export function queryAllowsStaleResults(query: string): boolean {
  return STALE_QUERY_ALLOW_RE.test(query);
}

export function shouldBoostQueryRecency(query: string): boolean {
  if (queryAllowsStaleResults(query)) return false;
  return RECENCY_QUERY_BOOST_RE.test(query) || query.trim().length > 0;
}

/** 为必应检索前置「年月 / 最新」变体，提高实时结果占比。 */
export function prependRecencyQueryVariants(variants: string[], query: string): string[] {
  if (!shouldBoostQueryRecency(query)) return variants;
  const anchor = getSearchAnchorNow();
  const ym = `${anchor.year}年${anchor.month}月`;
  const core = variants.find((v) => v.length > 0 && v.length <= 24) ?? variants[0] ?? query.trim();
  const boosted = [`${core} ${ym}`, `${core} 最新`, ...variants];
  return [...new Set(boosted.map((v) => v.trim()).filter(Boolean))];
}

export function parsePublishedAtMs(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const text = raw.trim();
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;

  const cn = text.match(/(\d{1,2})\s*(\d{1,2})月\s*(\d{4})/);
  if (cn) {
    const d = new Date(Number(cn[3]), Number(cn[2]) - 1, Number(cn[1]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }

  const cn2 = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (cn2) {
    const d = new Date(Number(cn2[1]), Number(cn2[2]) - 1, Number(cn2[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }

  return undefined;
}

export function inferPublishedAtMsFromUrl(url: string): number | undefined {
  const slash = url.match(/\/(20\d{2})(\d{2})(\d{2})\//);
  if (slash) {
    const d = new Date(Number(slash[1]), Number(slash[2]) - 1, Number(slash[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  const dashed = url.match(/\/(20\d{2})-(\d{2})-(\d{2})\//);
  if (dashed) {
    const d = new Date(Number(dashed[1]), Number(dashed[2]) - 1, Number(dashed[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  return undefined;
}

export function inferPublishedAtMsFromText(text: string): number | undefined {
  const iso = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  return undefined;
}

export function resolveItemPublishedAtMs(item: InfoSearchItem): number | undefined {
  return (
    parsePublishedAtMs(item.publishedAt) ??
    inferPublishedAtMsFromUrl(item.url) ??
    inferPublishedAtMsFromText(`${item.title}\n${item.snippet}`)
  );
}

export type ApplySearchFreshnessResult = {
  items: InfoSearchItem[];
  droppedStale: number;
  sortedBy: "publishedAtDesc";
};

export function applySearchFreshness(
  items: InfoSearchItem[],
  input: { query: string; maxAgeDays?: number; nowMs?: number },
): ApplySearchFreshnessResult {
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const nowMs = input.nowMs ?? Date.now();
  const allowStale = queryAllowsStaleResults(input.query);
  const maxAgeMs = maxAgeDays * 86_400_000;

  const enriched = items.map((item) => ({
    item,
    publishedMs: resolveItemPublishedAtMs(item),
  }));

  let droppedStale = 0;
  const kept = allowStale
    ? enriched
    : enriched.filter(({ publishedMs }) => {
        if (publishedMs == null) return true;
        if (nowMs - publishedMs <= maxAgeMs) return true;
        droppedStale += 1;
        return false;
      });

  kept.sort((a, b) => {
    const aMs = a.publishedMs;
    const bMs = b.publishedMs;
    if (aMs != null && bMs != null) return bMs - aMs;
    if (aMs != null) return -1;
    if (bMs != null) return 1;
    return 0;
  });

  return {
    items: kept.map((x) => x.item),
    droppedStale,
    sortedBy: "publishedAtDesc",
  };
}

export function formatSearchFreshnessNote(input: {
  anchor: SearchAnchorNow;
  droppedStale: number;
  maxAgeDays: number;
}): string {
  const parts = [
    `检索基准时间：${input.anchor.label}（${DEFAULT_TIMEZONE}）`,
    "结果已按发布时间从新到旧排序",
  ];
  if (input.droppedStale > 0) {
    parts.push(`已剔除 ${input.droppedStale} 条超过 ${input.maxAgeDays} 天的旧结果`);
  }
  return parts.join("；");
}
