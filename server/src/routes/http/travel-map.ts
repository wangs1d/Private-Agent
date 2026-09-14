import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * 行程规划浏览器页面路由（「行程卡 → 系统浏览器打开」链路）。
 *
 * 页面本体是自包含 HTML（server/web/travel-map/panel.html，MapLibre 内联），
 * 行程数据经 POST /travel-plans 存入进程内存，页面以 ?id=xxx 同源取回后
 * 调 window.__travelPanel.loadPlan 渲染。数据不落盘、随进程生命周期存亡。
 *
 * 桌面应用侧：TravelPlanBrowserLauncher（client/flutter_app）先 POST 载荷
 * 再用系统浏览器打开 /travel-map?id=xxx；server 不可达时桌面侧自行降级到
 * 独立子进程窗口。
 */

const webRoot = join(import.meta.dirname ?? ".", "../../../web/travel-map");

/** 内存行程载荷：id → { payload, createdAt } */
interface StoredPlan {
  payload: unknown;
  createdAt: number;
}
const plans = new Map<string, StoredPlan>();

/** 容量与时效约束：最多 32 份、每份 24h 过期（懒清理） */
const MAX_PLANS = 32;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

function prunePlans(): void {
  const now = Date.now();
  for (const [id, item] of plans) {
    if (now - item.createdAt > PLAN_TTL_MS) plans.delete(id);
  }
  while (plans.size > MAX_PLANS) {
    // 淘汰最旧的一份
    let oldestId = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, item] of plans) {
      if (item.createdAt < oldestAt) {
        oldestAt = item.createdAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    plans.delete(oldestId);
  }
}

/** MapLibre 本地内联（与客户端 travel_map_assets.dart 同款替换规则） */
const MAPLIBRE_CSS_TAG =
  '<link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />';
const MAPLIBRE_JS_TAG =
  '<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>';

function buildTravelMapHtml(): string {
  let html = readFileSync(join(webRoot, "panel.html"), "utf8");
  const cssPath = join(webRoot, "vendor", "maplibre-gl.css");
  const jsPath = join(webRoot, "vendor", "maplibre-gl.js");
  if (existsSync(cssPath) && existsSync(jsPath) && html.includes(MAPLIBRE_JS_TAG)) {
    // 内联 script 的安全转义：内容里出现 "</script" 会提前终止脚本块
    const css = readFileSync(cssPath, "utf8").replaceAll("</style", "<\\/style");
    const js = readFileSync(jsPath, "utf8").replaceAll("</script", "<\\/script");
    html = html
      .replace(MAPLIBRE_CSS_TAG, `<style>\n${css}\n</style>`)
      .replace(MAPLIBRE_JS_TAG, `<script>\n${js}\n</script>`);
  }
  return html;
}

export function registerTravelMapRoutes(app: FastifyInstance): void {
  /** GET /travel-map — 行程规划页面（自包含 HTML，浏览器直接打开） */
  app.get("/travel-map", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.type("text/html; charset=utf-8");
    return buildTravelMapHtml();
  });

  /** POST /travel-plans — 桌面应用下发行程载荷，返回取数 id */
  app.post("/travel-plans", async (req: FastifyRequest, reply) => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "payload must be a JSON object" });
    }
    prunePlans();
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    plans.set(id, { payload: body, createdAt: Date.now() });
    return reply.send({ id, url: `/travel-map?id=${id}` });
  });

  /** GET /travel-plans/:id — 页面同源取回行程载荷 */
  app.get("/travel-plans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = plans.get(id);
    if (!item) {
      return reply.code(404).send({ error: "plan not found or expired" });
    }
    reply.header("Cache-Control", "no-store");
    return reply.send(item.payload);
  });
}

// ═══════════════════════════════════════════════════════════════════
// POI 实况补全：地点实拍照片 / 联系电话 / 官网 / 营业时间。
//
// 数据源（全部真实公开数据，无需 API Key；经本机网络连通性实测选择）：
// - 必应图片 async 接口 → 该地点的真实照片（国内可达）
// - Overpass API（OSM）→ 真实电话/官网/营业时间（maps.mail.ru 镜像优先，
//   overpass-api.de 兜底；主站对高频请求返回 429）
// 维基百科/Nominatim 在当前网络环境不可达，不使用。各源独立容错，
// 服务端内存缓存 24h。
// ═══════════════════════════════════════════════════════════════════

interface PoiLiveDetails {
  photos?: Array<{ thumb: string; full: string }>;
  contact?: { phone?: string; website?: string; hours?: string; address?: string };
  errors?: string[];
}

const poiCache = new Map<string, { at: number; data: PoiLiveDetails }>();
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 9000): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": BROWSER_UA, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 必应图片：抓取该地点名称的真实照片直链（murl 字段） */
async function fetchBingPhotos(name: string): Promise<PoiLiveDetails["photos"]> {
  const html = await fetchText(
    `https://cn.bing.com/images/async?q=${encodeURIComponent(name)}&first=0&count=8&mmasync=1`,
  );
  const decoded = html.replace(/&quot;/g, '"');
  const urls = [...decoded.matchAll(/"murl":"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(urls)].slice(0, 6);
  if (!unique.length) return undefined;
  return unique.map((full) => ({ thumb: full, full }));
}

interface OverpassElement {
  type: string;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

/** Overpass 多镜像容错（GET 方式；主站高频限流，mail.ru 镜像优先） */
async function fetchOverpass(query: string): Promise<OverpassElement[]> {
  const mirrors = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
  ];
  let lastErr: unknown = null;
  for (const mirror of mirrors) {
    try {
      const text = await fetchText(`${mirror}?data=${encodeURIComponent(query)}`, {}, 25000);
      const data = JSON.parse(text) as { elements?: OverpassElement[] };
      return data.elements ?? [];
    } catch (e: unknown) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("overpass failed");
}

/** OSM 实地标注 → 电话/官网/营业时间（宽查询拉取周边命名要素，代码侧名称匹配） */
async function fetchOsmContact(
  name: string,
  lat: number,
  lng: number,
): Promise<PoiLiveDetails["contact"]> {
  const query =
    `[out:json][timeout:25];(node(around:1200,${lat},${lng})["name"];way(around:1200,${lat},${lng})["name"];);` +
    `out tags center 1200;`;
  const elements = await fetchOverpass(query);
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = norm(name);

  let best: { tags: Record<string, string>; score: number } | null = null;
  for (const el of elements) {
    const tags = el.tags ?? {};
    const elName = norm(tags.name ?? "");
    if (!elName) continue;
    let score = 0;
    if (elName === target) score = 100;
    else if (elName.includes(target) || target.includes(elName)) score = 60;
    else continue;
    // 信息越全越优先
    if (tags.phone || tags["contact:phone"]) score += 10;
    if (tags.website || tags["contact:website"]) score += 8;
    if (tags.opening_hours) score += 5;
    if (!best || score > best.score) best = { tags, score };
  }
  if (!best) return undefined;
  const t = best.tags;
  const contact: PoiLiveDetails["contact"] = {};
  const phone = t.phone ?? t["contact:phone"];
  const website = t.website ?? t["contact:website"];
  if (phone) contact.phone = phone;
  if (website) contact.website = website;
  if (t.opening_hours) contact.hours = t.opening_hours;
  const addrParts = [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean);
  if (addrParts.length) contact.address = addrParts.join(" ");
  return Object.keys(contact).length ? contact : undefined;
}

export function registerPoiDetailsRoute(app: FastifyInstance): void {
  app.get("/travel-poi/details", async (req, reply) => {
    const q = req.query as { name?: string; lat?: string; lng?: string };
    const name = (q.name ?? "").trim();
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    if (!name) return reply.code(400).send({ error: "name is required" });

    const cacheKey = `${name}@${Number.isFinite(lat) ? lat.toFixed(4) : ""},${Number.isFinite(lng) ? lng.toFixed(4) : ""}`;
    const hit = poiCache.get(cacheKey);
    const now = Date.now();
    if (hit && now - hit.at < POI_CACHE_TTL_MS) {
      return reply.send(hit.data);
    }

    const result: PoiLiveDetails = {};
    const errors: string[] = [];
    const tasks = [
      fetchBingPhotos(name)
        .then((photos) => {
          result.photos = photos;
        })
        .catch((e: unknown) => {
          errors.push(`photos: ${e instanceof Error ? e.message : e}`);
        }),
      Number.isFinite(lat) && Number.isFinite(lng)
        ? fetchOsmContact(name, lat, lng)
            .then((contact) => {
              result.contact = contact;
            })
            .catch((e: unknown) => {
              errors.push(`osm: ${e instanceof Error ? e.message : e}`);
            })
        : Promise.resolve(),
    ];
    await Promise.all(tasks);
    if (errors.length) result.errors = errors;

    poiCache.set(cacheKey, { at: now, data: result });
    if (poiCache.size > 128) {
      const oldest = poiCache.keys().next().value;
      if (oldest != null) poiCache.delete(oldest);
    }
    return reply.send(result);
  });
}
