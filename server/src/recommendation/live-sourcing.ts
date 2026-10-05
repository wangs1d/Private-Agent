/**
 * 推荐线实时聚合数据源（方案 docs/recommendation-value-upgrade-plan.md P1-A）。
 *
 * 定调（2026-10-05 拍板）：推荐数据源「实时聚合为主、种子库为冷启动缓存」。
 * shopping.suggest 在自有商品库未命中时，走联盟 API（OfficialPriceGateway，
 * 与比价线同一网关实例）并行拉在售商品，归一化去重后转 ProductRecord 落库——
 * 本次直接出推荐，后续同品类查询由商品库直接命中（缓存语义）。
 *
 * 渠道分级：已配置凭据的平台并行查询（8s 死线）；全部未配置/全失败时如实
 * 返回空 + notes（不编造），上层保持「库无此品」的诚实话术。Playwright+
 * Cookie 兜底不在此层（需要用户浏览器会话，且远超推荐链路延迟预算）。
 */

import { createHash } from "node:crypto";

import type { OfficialPriceGateway } from "../services/shopping-platforms/official-price-source.js";
import type { ProductSummary } from "../services/shopping-platforms/types.js";
import { normalizeTitle, diceSimilarity, extractSpecTokens } from "../services/shopping-platforms/title-normalize.js";
import type { ProductRecord } from "./product-catalog.js";

export type LiveProduct = {
  platform: string;
  itemId?: string;
  title: string;
  price?: number;
  url?: string;
  imageUrl?: string;
  shop?: string;
};

export type LiveFetchResult = {
  products: LiveProduct[];
  platformsSearched: string[];
  notes: string[];
};

export interface LiveSourcingDeps {
  gateway: Pick<OfficialPriceGateway, "configuredPlatforms" | "search">;
  now?: () => number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const PLATFORM_LABELS: Record<string, string> = {
  taobao: "淘宝",
  jd: "京东",
  pdd: "拼多多",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** 归一化标题相似度超过此阈值视为同款（与比价线口径一致） */
const SAME_PRODUCT_DICE_THRESHOLD = 0.55;
/** 单平台默认拉取条数：拉多一点供去重，最终截 top N */
const PER_PLATFORM_LIMIT = 5;
const DEADLINE_MS = 8_000;
const MAX_CANDIDATES = 5;

/**
 * 并行查已配置平台 → 预算过滤 → 归一化去重 → 按价升序截前 MAX_CANDIDATES。
 * 每平台独立超时/失败容错（allSettled），单平台失败不影响其余。
 */
export async function fetchLiveProducts(
  deps: LiveSourcingDeps,
  query: string,
  opts: { budgetMax?: number; deadlineMs?: number } = {},
): Promise<LiveFetchResult> {
  const keyword = String(query ?? "").trim();
  const notes: string[] = [];
  if (!keyword) return { products: [], platformsSearched: [], notes: ["query 为空"] };

  const platforms = deps.gateway.configuredPlatforms();
  if (platforms.length === 0) {
    return {
      products: [],
      platformsSearched: [],
      notes: ["联盟API未配置凭据（TAOBAO_TBK_/JD_UNION_/PDD_DDK_*），实时聚合跳过"],
    };
  }

  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const deadline = (deps.now?.() ?? Date.now()) + deadlineMs;
  const settled = await Promise.allSettled(
    platforms.map(async (platform) => {
      const remaining = deadline - (deps.now?.() ?? Date.now());
      if (remaining <= 500) return [] as ProductSummary[];
      const res = await deps.gateway.search(platform, keyword, PER_PLATFORM_LIMIT);
      if (!res.ok || res.notConfigured) {
        if (res.error) notes.push(`${platformLabel(platform)}：${res.error}`);
        return [] as ProductSummary[];
      }
      return res.products;
    }),
  );

  const raw: LiveProduct[] = [];
  for (let i = 0; i < platforms.length; i++) {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      for (const p of r.value) {
        if (!p?.title) continue;
        const price = typeof p.price === "number" && p.price > 0 ? p.price : undefined;
        if (price == null) continue; // 无实时价的在售品不进实时推荐（价格是推荐硬依据）
        if (typeof opts.budgetMax === "number" && opts.budgetMax > 0) {
          // 与商品库同口径：预算外 15% 弹性内保留（模型可拿来做「加点预算」建议）
          if (price > opts.budgetMax * 1.15) continue;
        }
        raw.push({
          platform: platforms[i]!,
          itemId: p.itemId,
          title: String(p.title),
          price,
          url: p.url,
          imageUrl: p.imageUrl,
          shop: p.shop,
        });
      }
    } else {
      notes.push(`${platformLabel(platforms[i]!)}：查询失败`);
    }
  }
  if (raw.length === 0) {
    return { products: [], platformsSearched: platforms, notes: [...notes, "各平台均无可用结果"] };
  }

  const deduped = dedupeByNormalizedTitle(raw);
  deduped.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));
  return {
    products: deduped.slice(0, MAX_CANDIDATES),
    platformsSearched: platforms,
    notes,
  };
}

/**
 * 归一化标题去重：同款跨平台/同平台重复项合并，保留价低者（实时价硬依据）。
 * 规格硬约束：双方规格 token（13套/15套、500ml…）不同且无交集时视为不同款——
 * 中文短标题 Dice 相似度对「仅规格不同」的同系列商品会误判同款。
 */
export function dedupeByNormalizedTitle(products: LiveProduct[]): LiveProduct[] {
  const kept: LiveProduct[] = [];
  for (const p of products) {
    const dup = kept.find((k) => isSameProduct(k, p));
    if (!dup) {
      kept.push(p);
      continue;
    }
    if ((p.price ?? Number.MAX_SAFE_INTEGER) < (dup.price ?? Number.MAX_SAFE_INTEGER)) {
      kept[kept.indexOf(dup)] = p;
    }
  }
  return kept;
}

function isSameProduct(a: LiveProduct, b: LiveProduct): boolean {
  if (a.itemId && b.itemId && a.platform === b.platform && a.itemId === b.itemId) return true;
  const specsA = extractSpecTokens(a.title);
  const specsB = extractSpecTokens(b.title);
  const overlap = specsA.some((t) => specsB.includes(t));
  if (specsA.length > 0 && specsB.length > 0 && !overlap) return false; // 规格冲突 → 不同款
  if (normalizeTitle(a.title) === normalizeTitle(b.title)) return true;
  return diceSimilarity(a.title, b.title) >= SAME_PRODUCT_DICE_THRESHOLD;
}

/**
 * LiveProduct → ProductRecord（落库缓存形态）。
 * id 稳定可复现（平台+itemId 或标题哈希）；无参数/无口碑快照（如实留空，
 * UGC 口碑接入前 reviewSummary 用中性占位）；tags 带 query 保证 catalog.search 可命中。
 */
export function liveProductToRecord(lp: LiveProduct, query: string, now = Date.now()): ProductRecord {
  const idSeed = lp.itemId ? `${lp.platform}-${lp.itemId}` : `${lp.platform}-${normalizeTitle(lp.title)}`;
  const id = `live-${createHash("sha1").update(idSeed).digest("hex").slice(0, 12)}`;
  const title = lp.title.trim();
  const name = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  const price = lp.price ?? 0;
  return {
    id,
    brand: "",
    name,
    category: "live",
    tags: [query.trim(), ...query.trim().split(/\s+/)].filter(Boolean),
    desc: title,
    ...(lp.imageUrl ? { image: lp.imageUrl } : {}),
    specs: [],
    channels: [
      {
        name: platformLabel(lp.platform),
        priceCny: price,
        ...(lp.url ? { url: lp.url } : {}),
      },
    ],
    reviewSummary: {
      pros: [],
      cons: [],
      suitedFor: "暂无聚合口碑（实时商品）",
      avoidIf: "",
      sampleSize: 0,
      updatedAt: now,
    },
    media: [],
    seededAt: now,
    source: "live",
    liveFetchedAt: now,
  };
}
