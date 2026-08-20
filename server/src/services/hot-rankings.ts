/**
 * 实时热点榜单聚合。
 *
 * 并行抓取微博 / 百度 / 知乎 / B站 的公开热榜接口，返回结构化 { platform, rank, title, hot, url }。
 * 任一平台失败都不影响其他平台（Promise.allSettled + 单项捕捉），整体优雅降级，
 * 全部失败时返回 []。用于给 Agent 提供「今天大家都在关注什么」的结构化热点流。
 */

export type HotRankItem = {
  platform: string;
  rank: number;
  title: string;
  /** 热度值/热度标签：数字热度或「热/爆/高」等强度词，无则空串 */
  hot: string;
  url?: string;
};

export type HotRankSource = "weibo" | "baidu" | "zhihu" | "bilibili";

export type HotRankResult = {
  items: HotRankItem[];
  fetchedSources: HotRankSource[];
  notes: string[];
};

const HOT_TIMEOUT_MS = 6000;

const HOT_SOURCE_LABELS: Record<HotRankSource, string> = {
  weibo: "微博",
  baidu: "百度",
  zhihu: "知乎",
  bilibili: "B站",
};

/** 微信/微博/知乎 需要携带浏览器 UA 才不会被反爬拒绝。 */
const HOT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function hotFetch(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": HOT_USER_AGENT, accept: "application/json,text/html,*/*", ...headers },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWeiboHot(limit: number): Promise<HotRankItem[]> {
  const json = await hotFetch("https://weibo.com/ajax/side/hotSearch", {
    referer: "https://weibo.com/hot/search",
  });
  if (!isObj(json)) return [];
  const data = (json as Record<string, unknown>).data;
  if (!isObj(data)) return [];
  const realtime = (data as Record<string, unknown>).realtime;
  if (!Array.isArray(realtime)) return [];
  const items: HotRankItem[] = [];
  for (const item of realtime.slice(0, limit)) {
    if (!isObj(item)) continue;
    const word = str((item as Record<string, unknown>).word).trim();
    if (!word || items.some((x) => x.title === word)) continue;
    const num = (item as Record<string, unknown>).num;
    const note = str((item as Record<string, unknown>).note);
    items.push({
      platform: "weibo",
      rank: items.length + 1,
      title: word,
      hot: num != null ? String(num) : note || "热",
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(word)}`,
    });
  }
  return items;
}

async function fetchBaiduHot(limit: number): Promise<HotRankItem[]> {
  const json = await hotFetch("https://top.baidu.com/api/board?platform=wise&tab=realtime");
  if (!isObj(json)) return [];
  const data = (json as Record<string, unknown>).data;
  if (!isObj(data)) return [];
  const cards = (data as Record<string, unknown>).cards;
  if (!Array.isArray(cards)) return [];
  // 结构：cards[].content[].content[] 两层嵌套，话题项带 word 字段
  const topicItems = collectLeaves(cards).filter((obj) => obj.word !== undefined);
  const items: HotRankItem[] = [];
  for (const rec of topicItems.slice(0, limit)) {
    const word = str(rec.word).trim();
    if (!word || items.some((x) => x.title === word)) continue;
    const hotScore = rec.hotScore;
    const hotShow = rec.hotShow ?? rec.hotTag;
    items.push({
      platform: "baidu",
      rank: items.length + 1,
      title: word,
      hot: hotScore != null ? String(hotScore) : isObj(hotShow) ? str((hotShow as Record<string, unknown>).hotValue) : "热",
      url: `https://www.baidu.com/s?wd=${encodeURIComponent(word)}`,
    });
  }
  return items;
}

async function fetchZhihuHot(limit: number): Promise<HotRankItem[]> {
  const json = await hotFetch("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true", {
    referer: "https://www.zhihu.com/hot",
    "accept-language": "zh-CN,zh;q=0.9",
  });
  if (!isObj(json)) return [];
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const items: HotRankItem[] = [];
  for (const item of data.slice(0, limit)) {
    if (!isObj(item)) continue;
    const target = (item as Record<string, unknown>).target;
    if (!isObj(target)) continue;
    const rec = target as Record<string, unknown>;
    const title = str(rec.title).trim();
    const id = str(rec.id);
    if (!title || !id) continue;
    items.push({
      platform: "zhihu",
      rank: items.length + 1,
      title,
      hot: str((item as Record<string, unknown>).detail_text) || "热",
      url: `https://www.zhihu.com/question/${id}`,
    });
  }
  return items;
}

async function fetchBilibiliHot(limit: number): Promise<HotRankItem[]> {
  const json = await hotFetch("https://api.bilibili.com/x/web-interface/ranking/v2");
  if (!isObj(json)) return [];
  const data = (json as Record<string, unknown>).data;
  if (!isObj(data)) return [];
  const list = (data as Record<string, unknown>).list;
  if (!Array.isArray(list)) return [];
  const items: HotRankItem[] = [];
  for (const item of list.slice(0, limit)) {
    if (!isObj(item)) continue;
    const rec = item as Record<string, unknown>;
    const title = str(rec.title).trim();
    const bvid = str(rec.bvid);
    const aid = str(rec.aid);
    if (!title || (!bvid && !aid)) continue;
    items.push({
      platform: "bilibili",
      rank: items.length + 1,
      title,
      hot: "热门",
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`,
    });
  }
  return items;
}

/**
 * 抓取实时热点榜单。platforms 为空则抓取全部；结果按平台内榜单顺序排列。
 * 直至 limit 条，跨平台按「先到先得」简单混合。
 */
export async function fetchHotRankings(
  limit: number,
  platformsSource?: HotRankSource[],
): Promise<HotRankResult> {
  const bounded = Math.max(1, Math.min(60, Math.floor(limit) || 10));
  const platforms: HotRankSource[] =
    platformsSource && platformsSource.length > 0
      ? platformsSource
      : ["weibo", "baidu", "bilibili"]; // 知乎需登录态(401)，不作为默认源，可显式尝试

  const fetchers: Record<HotRankSource, (l: number) => Promise<HotRankItem[]>> = {
    weibo: fetchWeiboHot,
    baidu: fetchBaiduHot,
    zhihu: fetchZhihuHot,
    bilibili: fetchBilibiliHot,
  };

  const settled = await Promise.allSettled(
    platforms.map(async (p) => ({ p, items: await fetchers[p](bounded) })),
  );

  const all: HotRankItem[] = [];
  const fetchedSources: HotRankSource[] = [];
  const notes: string[] = [];
  for (const entry of settled) {
    if (entry.status !== "fulfilled") continue;
    const { p, items } = entry.value;
    if (items.length === 0) {
      notes.push(`${HOT_SOURCE_LABELS[p]} 榜单暂不可用（未配置/被反爬/需登录态/接口变更）`);
      continue;
    }
    fetchedSources.push(p);
    all.push(...items);
  }

  return {
    items: all.slice(0, bounded),
    fetchedSources,
    notes,
  };
}

/**
 * 深度递归展开任意数组/对象，收集叶子对象（无子数组的对象）。
 * 用于解析百度热榜两层嵌套结构。
 */
function collectLeaves(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, out);
  } else if (isObj(value)) {
    const values = Object.values(value);
    const hasChildArray = values.some((v) => Array.isArray(v));
    if (hasChildArray) {
      for (const v of values) collectLeaves(v, out);
    } else {
      out.push(value);
    }
  }
  return out;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}