/**
 * 地图瓦片/底图资源本地缓存与预热
 *
 * 解决「每次打开行程地图都慢慢加载」：底图资源（Carto 矢量瓦片/样式/字形、
 * Esri 卫星瓦片）原先每次都从境外 CDN 现拉，国内网络下动辄数十秒。
 * 本模块把资源代理到本机 server：
 *   - 首次拉取后落盘（data/tile-cache，TRAVEL_TILE_CACHE_DIR 可覆盖）
 *   - 后续请求毫秒级本地命中；过期条目先回旧数据再后台刷新（SWR）
 *   - 规划完成后预取目的地城市级 + POI 周边瓦片，用户打开地图前已热
 *
 * 安全：只代理白名单域名（cartocdn.com / arcgisonline.com），不是开放代理。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 上游域名白名单（后缀匹配） */
const ALLOWED_HOST_SUFFIXES = ["cartocdn.com", "arcgisonline.com"];

/** 改写规则版本（改写 URL 形态变化时 +1，让浏览器旧缓存自然失效） */
const REWRITE_VERSION = 2;

/** 缓存条目新鲜期：瓦片基本不可变，30 天足够长 */
const FRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 内存 LRU 上限（条目数；瓦片均 ~10-50KB，500 条 ≤ ~25MB） */
const MEMORY_MAX_ENTRIES = 500;
/** 预热单次瓦片预算（防城市过大打爆磁盘/上游） */
const WARM_TILE_BUDGET = 800;
/** 预热并发 */
const WARM_CONCURRENCY = 6;
/** 单资源拉取超时 */
const FETCH_TIMEOUT_MS = 10_000;

interface MemoryEntry {
  body: Buffer;
  contentType: string;
  createdAt: number;
}

interface ProxyFetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  body: Buffer;
  fromCache: boolean;
}

class TravelTileCache {
  private readonly dir: string;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inFlight = new Map<string, Promise<ProxyFetchResult>>();
  /** 测试/内网扩展白名单（TRAVEL_TILE_ALLOW_HOSTS，逗号分隔；localhost/127.0.0.1 允许 http） */
  private readonly extraHosts: string[];

  constructor() {
    this.dir = path.resolve(
      process.env.TRAVEL_TILE_CACHE_DIR || path.join(process.cwd(), "data", "tile-cache"),
    );
    fs.mkdirSync(this.dir, { recursive: true });
    this.extraHosts = (process.env.TRAVEL_TILE_ALLOW_HOSTS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  get cacheDir(): string {
    return this.dir;
  }

  /** 上游 URL 是否在白名单内 */
  isAllowedUpstream(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && !this.isLoopbackHost(u.hostname)) return false;
      if (ALLOWED_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith("." + s))) {
        return true;
      }
      return this.extraHosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
    } catch {
      return false;
    }
  }

  private isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  }

  private keyOf(url: string): string {
    return createHash("sha1").update(url).digest("hex");
  }

  private filePathOf(key: string): string {
    // 二级目录防单目录文件过多
    return path.join(this.dir, key.slice(0, 2), `${key.slice(2)}.body`);
  }

  private metaPathOf(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key.slice(2)}.meta.json`);
  }

  /**
   * 经缓存取资源：内存 → 磁盘 → 上游。
   * 过期条目先回旧数据，同时触发后台刷新（不阻塞响应）。
   */
  async fetch(url: string): Promise<ProxyFetchResult> {
    if (!this.isAllowedUpstream(url)) {
      return { ok: false, status: 403, contentType: "text/plain", body: Buffer.from("upstream not allowed"), fromCache: false };
    }
    const key = this.keyOf(url);

    const mem = this.memory.get(key);
    if (mem && Date.now() - mem.createdAt < FRESH_TTL_MS) {
      this.touch(key, mem);
      return { ok: true, status: 200, contentType: mem.contentType, body: mem.body, fromCache: true };
    }

    const disk = this.readDisk(key);
    if (disk && Date.now() - disk.createdAt < FRESH_TTL_MS) {
      this.remember(key, disk);
      return { ok: true, status: 200, contentType: disk.contentType, body: disk.body, fromCache: true };
    }

    // 无缓存或已过期：并发去重后拉上游
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.fetchUpstream(url, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);

    const fresh = await task;
    // 拉取失败但有旧数据 → 先用旧的（SWR，后台已顺带刷新）
    if (!fresh.ok && disk) {
      return { ok: true, status: 200, contentType: disk.contentType, body: disk.body, fromCache: true };
    }
    return fresh;
  }

  private async fetchUpstream(url: string, key: string): Promise<ProxyFetchResult> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "PrivateAgentTravelTileCache/1.0" },
      });
      if (!res.ok) {
        return { ok: false, status: res.status, contentType: "text/plain", body: Buffer.from(`upstream ${res.status}`), fromCache: false };
      }
      const body = Buffer.from(await res.arrayBuffer());
      const entry: MemoryEntry = {
        body,
        contentType: res.headers.get("content-type") || "application/octet-stream",
        createdAt: Date.now(),
      };
      this.remember(key, entry);
      this.writeDisk(key, url, entry);
      return { ok: true, status: 200, contentType: entry.contentType, body: entry.body, fromCache: false };
    } catch {
      return { ok: false, status: 502, contentType: "text/plain", body: Buffer.from("upstream fetch failed"), fromCache: false };
    }
  }

  private remember(key: string, entry: MemoryEntry): void {
    this.evictIfNeeded();
    this.memory.set(key, entry);
  }

  private touch(key: string, entry: MemoryEntry): void {
    // Map 迭代按插入序：delete+set 即 LRU touch
    this.memory.delete(key);
    this.memory.set(key, entry);
  }

  private evictIfNeeded(): void {
    if (this.memory.size < MEMORY_MAX_ENTRIES) return;
    const oldest = this.memory.keys().next().value;
    if (oldest !== undefined) this.memory.delete(oldest);
  }

  private readDisk(key: string): MemoryEntry | null {
    try {
      const bodyPath = this.filePathOf(key);
      const metaPath = this.metaPathOf(key);
      if (!fs.existsSync(bodyPath) || !fs.existsSync(metaPath)) return null;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { contentType?: string; createdAt?: number };
      if (!meta.createdAt) return null;
      return { body: fs.readFileSync(bodyPath), contentType: meta.contentType || "application/octet-stream", createdAt: meta.createdAt };
    } catch {
      return null;
    }
  }

  private writeDisk(key: string, url: string, entry: MemoryEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePathOf(key)), { recursive: true });
      fs.writeFileSync(this.filePathOf(key), entry.body);
      fs.writeFileSync(
        this.metaPathOf(key),
        JSON.stringify({ url, contentType: entry.contentType, createdAt: entry.createdAt }),
      );
    } catch {
      // 磁盘写失败不影响响应（内存仍有）
    }
  }

  /**
   * 把 JSON 文本中所有白名单域名的绝对 URL 改写为本地代理路径。
   * 用于 TileJSON（tiles.json 内容里的 tiles[] 是上游绝对地址，不改写的话
   * MapLibre worker 会绕过代理直连 CDN——国内网络下挂起，地图永远渲染不出来）。
   * origin 传入时生成绝对地址：MapLibre 的 blob worker 内无法解析相对路径。
   * URL query 不编码，保留 {z}/{x}/{y}、{fontstack}/{range} 令牌原样。
   */
  rewriteWhitelistedUrls(json: string, origin?: string): string {
    const base = origin && origin.startsWith("http") ? origin.replace(/\/+$/, "") : "";
    // v 参数 = 改写规则版本：URL 变化使浏览器旧缓存（曾以 max-age 存过未改写
    // 内容）整体失效，是改写链路升级后的自愈手段
    return json.replace(/https:\/\/[^"'\\\s]+/g, (m) =>
      this.isAllowedUpstream(m) ? `${base}/travel-basemap/fetch?u=${m}&v=${REWRITE_VERSION}` : m,
    );
  }

  /**
   * 拉取 Carto 暗色矢量样式 JSON，把其中所有白名单域名的绝对 URL 改写为本地
   * 代理路径，并把 TileJSON 引用（sources[*].url=tiles.json）服务端展开为
   * 内联 tiles[] 模板——worker 不再需要运行时二次请求 TileJSON，
   * 也杜绝 worker 侧对 TileJSON 内容缓存的依赖。
   */
  async darkStyleProxied(origin?: string): Promise<{ ok: boolean; body: string; contentType: string }> {
    const styleUrl = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
    const res = await this.fetch(styleUrl);
    if (!res.ok) return { ok: false, body: "", contentType: "application/json" };
    const json = this.rewriteWhitelistedUrls(res.body.toString("utf-8"), origin);
    try {
      const style = JSON.parse(json) as {
        sources?: Record<string, { url?: string; tiles?: string[] }>;
      };
      for (const source of Object.values(style.sources ?? {})) {
        const tileJsonUrl = source?.url;
        if (!tileJsonUrl || !tileJsonUrl.includes("tiles.json")) continue;
        // 样式里的 url 已被改写为本机代理地址，取回原始上游地址直查缓存
        const upstreamMatch = tileJsonUrl.match(/[?&]u=(https:\/\/[^&]+)/);
        const upstream = upstreamMatch ? upstreamMatch[1]! : tileJsonUrl;
        const tj = await this.fetch(upstream);
        if (!tj.ok) continue;
        const parsed = JSON.parse(tj.body.toString("utf-8")) as { tiles?: string[] };
        const tiles = (parsed.tiles ?? [])
          .filter((t) => t.includes("{z}"))
          .map((t) => this.rewriteWhitelistedUrls(t, origin));
        if (tiles.length > 0) {
          source.tiles = tiles;
          delete source.url;
        }
      }
      return { ok: true, body: JSON.stringify(style), contentType: "application/json" };
    } catch {
      // 样式结构异常时退回纯 URL 改写版本
      return { ok: true, body: json, contentType: "application/json" };
    }
  }

  /**
   * 目的地瓦片预热：城市级缩放围绕中心、POI 周边高缩放逐点预热。
   * 矢量（Carto）+ 卫星（Esri）双底图都热；预算封顶，fire-and-forget 调用。
   */
  async warmDestination(
    center: { latitude: number; longitude: number },
    pois: Array<{ latitude: number; longitude: number }> = [],
  ): Promise<{ fetched: number; hitCache: number; failed: number }> {
    const urls = new Set<string>();

    // 1. 样式内资源（sprite 等）+ 矢量瓦片模板。
    //    dark-matter 样式经 TileJSON（tiles.json）间接引用瓦片模板，需跟进去取。
    const vectorTemplates: string[] = [];
    const style = await this.darkStyleProxied();
    if (style.ok) {
      for (const m of style.body.matchAll(/\/travel-basemap\/fetch\?u=(https:[^"\\\s]+)/g)) {
        const u = m[1]!;
        if (u.includes("{fontstack}") || u.includes("{range}")) continue; // 字形按需请求
        if (/\.json(\?|$)/.test(u)) {
          // TileJSON：取回并提取 tiles[] 模板
          const tj = await this.fetch(u);
          if (tj.ok) {
            try {
              const parsed = JSON.parse(tj.body.toString("utf-8")) as { tiles?: string[] };
              for (const t of parsed.tiles ?? []) {
                if (t.includes("{z}")) vectorTemplates.push(t);
              }
            } catch { /* 非法 TileJSON 忽略 */ }
          }
          continue;
        }
        urls.add(u); // sprite 等静态资源直接预热
      }
    }
    if (vectorTemplates.length === 0) vectorTemplates.push(...CARTO_VECTOR_TEMPLATES);

    // 2. 城市级缩放（中心点 3×3）：中低缩放覆盖整城概览
    for (const z of [3, 5, 7, 9, 11, 12]) {
      collectTileUrls(vectorTemplates, center.latitude, center.longitude, z, 1, urls);
    }
    // 3. POI 周边高缩放：行程实际浏览的细节层（矢量 + 卫星双底图）
    const points = [center, ...pois].slice(0, 40);
    for (const p of points) {
      for (const z of [13, 14, 15]) {
        collectTileUrls(vectorTemplates, p.latitude, p.longitude, z, 1, urls);
        collectTileUrls(ESRI_RASTER_TEMPLATES, p.latitude, p.longitude, z, 1, urls);
      }
    }

    const list = [...urls].slice(0, WARM_TILE_BUDGET);
    let fetched = 0;
    let hitCache = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const url = list[cursor++]!;
        const r = await this.fetch(url).catch(() => ({ ok: false, fromCache: false }) as ProxyFetchResult);
        if (r.ok) (r.fromCache ? hitCache++ : fetched++);
        else failed++;
      }
    };
    await Promise.all(Array.from({ length: WARM_CONCURRENCY }, () => worker()));
    return { fetched, hitCache, failed };
  }

  /** 诊断统计（/travel-basemap/stats 用） */
  stats(): { cacheDir: string; memoryEntries: number; diskFiles: number; diskBytes: number } {
    let diskFiles = 0;
    let diskBytes = 0;
    try {
      for (const d of fs.readdirSync(this.dir)) {
        const sub = path.join(this.dir, d);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const f of fs.readdirSync(sub)) {
          if (!f.endsWith(".body")) continue;
          diskFiles++;
          diskBytes += fs.statSync(path.join(sub, f)).size;
        }
      }
    } catch { /* ignore */ }
    return { cacheDir: this.dir, memoryEntries: this.memory.size, diskFiles, diskBytes };
  }
}

/** Carto 矢量瓦片模板（TileJSON 提取失败时的兜底，与线上 carto.streets 实际地址一致） */
const CARTO_VECTOR_TEMPLATES = [
  "https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt",
];
/** Esri 卫星瓦片模板（与 panel.html satelliteStyle 一致） */
const ESRI_RASTER_TEMPLATES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];

/** 经纬度 + 缩放 → 周边半径 radius 格瓦片的绝对 URL 集合 */
function collectTileUrls(
  templates: string[],
  lat: number,
  lon: number,
  z: number,
  radius: number,
  out: Set<string>,
): void {
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const xTile = Math.floor(((lon + 180) / 360) * n);
  const yTile = Math.floor(
    ((1 - Math.log(Math.tan((clampedLat * Math.PI) / 180) + 1 / Math.cos((clampedLat * Math.PI) / 180)) / Math.PI) / 2) * n,
  );
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const x = xTile + dx;
      const y = yTile + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      for (const t of templates) {
        out.add(t.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
      }
    }
  }
}

/** 全局单例 */
export const travelTileCache = new TravelTileCache();

/** 类导出（测试用：注入临时缓存目录 / 扩展白名单后单独实例化） */
export { TravelTileCache };
