/**
 * 购物建议引擎（纯函数，无 LLM、无 IO）。
 *
 * runtime 集成形态：shopping.suggest 工具的 handler 调用本引擎，从自有
 * 商品库确定性产出结构化建议（候选 + 证据 + 转置对比表 + 媒体）；
 * 卡片由 tool-card-registry 从工具回执确定性构建，LLM 的口头回复只作
 * 前导正文（场景匹配在 LLM 拿到结构化数据后自然完成）。
 *
 * 搬去 Agent World 做生态功能时：本文件与 catalog/seeds/types 一起搬运，
 * 零宿主依赖。
 */

import type { ProductCatalog, ProductRecord } from "./product-catalog.js";

export type SuggestVideo = { title: string; url?: string; source?: string };

export type SuggestCandidate = {
  productId: string;
  brand: string;
  name: string;
  /** 参考价区间，如「¥1899–2249」 */
  priceLabel: string;
  image?: string;
  reasons: string[];
  cautions: string[];
  videos: SuggestVideo[];
};

export type SuggestCompare = {
  dims: string[];
  /** 转置后的行：每行 = 维度 + 各候选取值（label 与 values 一一对应） */
  rows: Array<{ label: string; values: string[] }>;
};

export type SuggestResult = {
  query: string;
  summary: string;
  candidates: SuggestCandidate[];
  compare?: SuggestCompare;
};

function shortName(p: ProductRecord): string {
  return `${p.brand} ${p.name}`.trim();
}

function priceLabelOf(p: ProductRecord): string {
  const min = Math.min(...p.channels.map((c) => c.priceCny));
  const max = Math.max(...p.channels.map((c) => c.priceCny));
  return min === max ? `¥${min}` : `¥${min}–${max}`;
}

function toCandidate(p: ProductRecord): SuggestCandidate {
  const review = p.reviewSummary;
  const reasons = [
    ...review.pros.slice(0, 2).map((x) => `口碑优点：${x}`),
    `适合：${review.suitedFor}`,
  ];
  const cautions = [
    ...review.cons.slice(0, 2).map((x) => `注意：${x}`),
    ...(review.avoidIf ? [`不适合：${review.avoidIf}`] : []),
  ];
  return {
    productId: p.id,
    brand: p.brand,
    name: p.name,
    priceLabel: priceLabelOf(p),
    image: p.image,
    reasons,
    cautions,
    videos: p.media
      .filter((m) => m.type === "video")
      .map((m) => ({ title: m.title, url: m.url, source: m.source })),
  };
}

/** 转置对比表（维度为行、候选为列），过滤整行无数据的死维度 */
function buildCompare(products: ProductRecord[]): SuggestCompare {
  const cmp = products.length >= 2
    ? catalogCompare(products)
    : { dims: [] as string[], rows: [] as Array<{ label: string; values: string[] }> };
  const rows: SuggestCompare["rows"] = [];
  for (let i = 0; i < cmp.dims.length; i++) {
    const values = products.map((p) => {
      const spec = p.specs.find(
        (s) => s.label === cmp.dims[i] ||
          s.label.includes(cmp.dims[i]) ||
          cmp.dims[i].includes(s.label),
      );
      if (spec) return spec.value;
      if (cmp.dims[i] === "价格") return priceLabelOf(p);
      return "—";
    });
    if (values.some((v) => v !== "—")) {
      rows.push({ label: cmp.dims[i], values });
    }
  }
  return { dims: cmp.dims, rows };
}

function catalogCompare(products: ProductRecord[]): {
  dims: string[];
} {
  if (products.length < 2) return { dims: [] };
  const [first, ...rest] = products;
  const common = (first?.specs ?? [])
    .map((s) => s.label)
    .filter((label) => rest.every((p) => p.specs.some((s) => s.label === label)))
    .slice(0, 5);
  return { dims: [...common, "价格"] };
}

/**
 * 从商品库确定性构建购物建议。
 * - item 支持多关键词（如「XM5 Bose」），catalog.search 按命中计分；
 * - 候选 ≤ maxCandidates（默认 3）；≥2 时附转置对比表；
 * - 全部字段来自商品库（pros/cons/suitedFor/avoidIf/参数/渠道价），可溯源。
 */
export function buildSuggestion(
  catalog: ProductCatalog,
  input: { item: string; budget?: number; maxCandidates?: number },
): SuggestResult | null {
  const found = catalog.search({
    query: input.item,
    budgetMax: input.budget,
    limit: input.maxCandidates ?? 3,
  });
  if (found.length === 0) return null;

  const candidates = found.map(toCandidate);
  return {
    query: input.item,
    summary:
      candidates.length === 1
        ? `商品库中「${input.item}」匹配到 ${candidates.length} 款：${shortName(found[0]!)}`
        : `商品库中「${input.item}」匹配到 ${candidates.length} 款，已并排对比`,
    candidates,
    ...(candidates.length >= 2 ? { compare: buildCompare(found) } : {}),
  };
}
