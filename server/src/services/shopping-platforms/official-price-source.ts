/**
 * 官方联盟 API 比价数据源（2026-09-24，对标 Muse 双通道取数的官方通道侧）。
 *
 * 定调（2026-09-22 比价数据源决策的落地）：查价走联盟 API，用我们自己的开发者
 * 凭据，全服务器侧、零用户操作；Playwright+Cookie 链路降级为兜底。覆盖：
 *   - 淘宝客 taobao.tbk.dg.material.optional（open.taobao.com TOP 网关，个人可申请）
 *   - 京东联盟 jd.union.open.goods.query（union.jd.com，API 网关 routerjson）
 *   - 多多进宝 pdd.ddk.goods.search（open.pinduoduo.com）
 *
 * 凭据只存在于本模块内（env 读取 + 签名），绝不随工具返回值/错误消息外泄——
 * 错误统一 redactCredentials 后上抛（凭据不进 agent 上下文铁律）。
 *
 * 签名算法（各平台公开文档口径）：
 *   - 淘宝 TOP：MD5(secret + sorted(k1v1k2v2…) + secret) 大写
 *   - 京东联盟：MD5(secret + sorted(k1v1k2v2…) + secret) 大写（360buy_param_json 不参与签名外的 JSON 转义差异）
 *   - 多多进宝：MD5(secret + sorted(k1v1k2v2…) + secret) 大写
 * 未配凭据的平台 isConfigured()=false，网关直接跳过（上层走兜底通道）。
 */
import { createHash } from "node:crypto";

import { redactCredentials } from "../../security/redact.js";
import type { ProductSummary } from "./types.js";

/** 官方源单平台查询结果 */
export interface OfficialQuoteResult {
  ok: boolean;
  products: ProductSummary[];
  /** 失败原因（已脱敏） */
  error?: string;
  /** 是否因未配置凭据被跳过（上层据此静默走兜底，不算失败） */
  notConfigured?: boolean;
}

interface PlatformClient {
  platform: string;
  isConfigured(): boolean;
  search(query: string, limit: number): Promise<ProductSummary[]>;
}

function md5Upper(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
}

/** TOP/联盟通用签名：secret + 按键 ASCII 升序 k+v 拼接 + secret，MD5 大写 */
export function signParams(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params).sort();
  const concat = sorted.map((k) => `${k}${params[k]}`).join("");
  return md5Upper(`${secret}${concat}${secret}`);
}

const DEFAULT_TIMEOUT_MS = 8_000;

export type HttpPostForm = (url: string, params: Record<string, string>) => Promise<string>;

async function postForm(
  url: string,
  params: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 剔除空值参（空值不参与签名与请求，各平台网关通用惯例） */
function compactParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== "" && v != null) out[k] = v;
  }
  return out;
}

// ─────────────────────────── 淘宝客 ───────────────────────────

export interface TaobaoTbkConfig {
  appKey: string;
  appSecret: string;
  /** 推广位 adzone_id（淘宝客后台必填） */
  adzoneId: string;
}

export function readTaobaoTbkConfigFromEnv(): TaobaoTbkConfig | null {
  const appKey = process.env.TAOBAO_TBK_APP_KEY?.trim();
  const appSecret = process.env.TAOBAO_TBK_APP_SECRET?.trim();
  const adzoneId = process.env.TAOBAO_TBK_ADZONE_ID?.trim();
  if (!appKey || !appSecret || !adzoneId) return null;
  return { appKey, appSecret, adzoneId };
}

/** 淘宝联盟商品解析：material_optional_response.list_contents[].*（字段缺失容错） */
export function parseTaobaoTbkResponse(raw: string): ProductSummary[] {
  const data = JSON.parse(raw) as {
    tbk_dg_material_optional_response?: {
      result_list?: Array<{
        num_iid?: number | string;
        title?: string;
        zk_final_price?: string | number;
        reserve_price?: string | number;
        url?: string;
        click_url?: string;
        white_image?: string;
        pict_url?: string;
        small_images?: string[];
        shop_title?: string;
      }>;
    };
  };
  const list = data.tbk_dg_material_optional_response?.result_list ?? [];
  return list
    .filter((it) => it?.title)
    .map((it) => ({
      title: String(it.title),
      price: Number(it.zk_final_price ?? it.reserve_price) || undefined,
      url: it.click_url || it.url || undefined,
      itemId: it.num_iid != null ? String(it.num_iid) : undefined,
      shop: it.shop_title || undefined,
      // 白底图（商品主体图）优先，退化到类目主图；推荐线图片第一优先级
      imageUrl: it.white_image || it.pict_url || undefined,
    }));
}

export function taobaoTbkClient(cfg: TaobaoTbkConfig, post: HttpPostForm = postForm): PlatformClient {
  return {
    platform: "taobao",
    isConfigured: () => true,
    async search(query, limit) {
      const params: Record<string, string> = {
        method: "taobao.tbk.dg.material.optional",
        app_key: cfg.appKey,
        timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
        format: "json",
        v: "2.0",
        sign_method: "md5",
        fields: "num_iid,title,zk_final_price,reserve_price,click_url,url,shop_title,white_image,pict_url",
        q: query,
        adzone_id: cfg.adzoneId,
        page_size: String(Math.min(Math.max(limit, 1), 20)),
      };
      // 先剔空再签名（空值参不参与签名，与网关口径一致）
      const signed = compactParams(params);
      signed.sign = signParams(signed, cfg.appSecret);
      const raw = await post("https://gw.api.taobao.com/router/rest", signed);
      return parseTaobaoTbkResponse(raw);
    },
  };
}

// ─────────────────────────── 京东联盟 ───────────────────────────

export interface JdUnionConfig {
  appKey: string;
  appSecret: string;
}

export function readJdUnionConfigFromEnv(): JdUnionConfig | null {
  const appKey = process.env.JD_UNION_APP_KEY?.trim();
  const appSecret = process.env.JD_UNION_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  return { appKey, appSecret };
}

/** 京东联盟 jd.union.open.goods.query 解析：jd_union_open_goods_query_response → data → list[] */
export function parseJdUnionResponse(raw: string): ProductSummary[] {
  const data = JSON.parse(raw) as {
    jd_union_open_goods_query_response?: {
      result?: Array<{
        data?: {
          skuName?: string;
          skuId?: number | string;
          priceInfo?: { price?: number; lowestPrice?: number };
          imageInfo?: { imageList?: Array<{ url?: string }> };
          shopInfo?: { shopName?: string };
          materialUrl?: string;        };
      }>;
    };
  };
  const list = data.jd_union_open_goods_query_response?.result ?? [];
  return list
    .map((it) => it?.data)
    .filter((d): d is NonNullable<typeof d> => Boolean(d?.skuName))
    .map((d) => ({
      title: String(d.skuName),
      price: d.priceInfo?.price ?? d.priceInfo?.lowestPrice ?? undefined,
      url: d.materialUrl || undefined,
      itemId: d.skuId != null ? String(d.skuId) : undefined,
      shop: d.shopInfo?.shopName || undefined,
      // 京东联盟商品主图（imageList 首张），推荐线图片第一优先级
      imageUrl: d.imageInfo?.imageList?.find((img) => img?.url)?.url || undefined,
    }));
}

export function jdUnionClient(cfg: JdUnionConfig, post: HttpPostForm = postForm): PlatformClient {
  return {
    platform: "jd",
    isConfigured: () => true,
    async search(query, limit) {
      const bizParam = JSON.stringify({
        goodsReqDTO: { keyword: query, pageIndex: 1, pageSize: Math.min(Math.max(limit, 1), 20) },
      });
      const params: Record<string, string> = {
        method: "jd.union.open.goods.query",
        app_key: cfg.appKey,
        access_token: process.env.JD_UNION_ACCESS_TOKEN?.trim() ?? "",
        timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
        format: "json",
        v: "1.0",
        sign_method: "md5",
        "360buy_param_json": bizParam,
      };
      const signed = compactParams(params);
      signed.sign = signParams(signed, cfg.appSecret);
      const raw = await post("https://api.jd.com/routerjson", signed);
      return parseJdUnionResponse(raw);
    },
  };
}

// ─────────────────────────── 多多进宝 ───────────────────────────

export interface PddDdkConfig {
  clientId: string;
  clientSecret: string;
}

export function readPddDdkConfigFromEnv(): PddDdkConfig | null {
  const clientId = process.env.PDD_DDK_CLIENT_ID?.trim();
  const clientSecret = process.env.PDD_DDK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** 多多进宝 pdd.ddk.goods.search 解析：goods_search_response → goods_list[]（价格为分） */
export function parsePddDdkResponse(raw: string): ProductSummary[] {
  const data = JSON.parse(raw) as {
    goods_search_response?: {
      goods_list?: Array<{
        goods_name?: string;
        goods_sign?: string;
        goods_id?: number | string;
        min_group_price?: number;
        min_normal_price?: number;
        goods_image_url?: string;
        shop_name?: string;
        coupon_min_order_amount?: number;
        search_id?: string;
      }>;
    };
  };
  const list = data.goods_search_response?.goods_list ?? [];
  return list
    .filter((it) => it?.goods_name)
    .map((it) => {
      // 到手价优先：有券取 min_group_price（券后团购价），否则 min_normal_price；单位分
      const cents = it.min_group_price ?? it.min_normal_price;
      return {
        title: String(it.goods_name),
        price: cents != null && cents > 0 ? cents / 100 : undefined,
        itemId: it.goods_sign || (it.goods_id != null ? String(it.goods_id) : undefined),
        shop: it.shop_name || undefined,
        // 修正：goods_image_url 是商品主图，此前误填进 url（点开会落到一张图片）；
        // 商品落地页 URL 需用 goods_sign 生成推广链接，此处不冒充
        imageUrl: it.goods_image_url || undefined,
      } satisfies ProductSummary;
    });
}

export function pddDdkClient(cfg: PddDdkConfig, post: HttpPostForm = postForm): PlatformClient {
  return {
    platform: "pdd",
    isConfigured: () => true,
    async search(query, limit) {
      const params: Record<string, string> = {
        type: "pdd.ddk.goods.search",
        client_id: cfg.clientId,
        access_token: process.env.PDD_DDK_ACCESS_TOKEN?.trim() ?? "",
        timestamp: String(Math.floor(Date.now() / 1000)),
        keyword: query,
        page: "1",
        page_size: String(Math.min(Math.max(limit, 1), 20)),
      };
      const signed = compactParams(params);
      signed.sign = signParams(signed, cfg.clientSecret);
      const raw = await post("https://gw.pinduoduo.com/api/router", signed);
      return parsePddDdkResponse(raw);
    },
  };
}

// ─────────────────────────── 网关 ───────────────────────────

/**
 * 官方比价网关：按平台取官方报价。未配置凭据的平台 notConfigured=true，
 * 上层静默走 Playwright 兜底；配置了但请求失败 → ok=false + 脱敏错误，
 * 上层同样落兜底（官方源只是优先，不是依赖）。
 */
export class OfficialPriceGateway {
  private readonly clients = new Map<string, PlatformClient>();

  constructor(opts?: {
    taobao?: TaobaoTbkConfig | null;
    jd?: JdUnionConfig | null;
    pdd?: PddDdkConfig | null;
    /** 测试注入 HTTP 层（默认真实 postForm） */
    post?: HttpPostForm;
  }) {
    const taobao = opts?.taobao === undefined ? readTaobaoTbkConfigFromEnv() : opts.taobao;
    const jd = opts?.jd === undefined ? readJdUnionConfigFromEnv() : opts.jd;
    const pdd = opts?.pdd === undefined ? readPddDdkConfigFromEnv() : opts.pdd;
    if (taobao) {
      const c = taobaoTbkClient(taobao, opts?.post);
      this.clients.set(c.platform, c);
    }
    if (jd) {
      const c = jdUnionClient(jd, opts?.post);
      this.clients.set(c.platform, c);
    }
    if (pdd) {
      const c = pddDdkClient(pdd, opts?.post);
      this.clients.set(c.platform, c);
    }
  }

  /** 已配置凭据、可走官方源的平台 */
  configuredPlatforms(): string[] {
    return [...this.clients.keys()];
  }

  isConfiguredFor(platform: string): boolean {
    return this.clients.has(String(platform ?? "").trim().toLowerCase());
  }

  async search(platform: string, query: string, limit: number): Promise<OfficialQuoteResult> {
    const key = String(platform ?? "").trim().toLowerCase();
    const client = this.clients.get(key);
    if (!client) return { ok: false, products: [], notConfigured: true };
    try {
      const products = await client.search(query, limit);
      return { ok: true, products };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, products: [], error: redactCredentials(message) };
    }
  }
}
