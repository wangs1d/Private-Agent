/**
 * 旅游 POI 专属库种子脚本（普遍覆盖首批热门目的地）
 *
 * 用法（cwd = server/）：
 *   npx tsx scripts/seed-travel-poi-db.ts                 # 全量（国内20+国外14）
 *   npx tsx scripts/seed-travel-poi-db.ts --only=成都,巴厘岛
 *   npx tsx scripts/seed-travel-poi-db.ts --media=0       # 只建 POI 不抓图
 *   npx tsx scripts/seed-travel-poi-db.ts --media=6       # 每类回填图上限（默认 6/2/2）
 *
 * 行为：
 *   1. 逐个目的地 searchDestination → 抓过一次自动入 SQLite（库内新鲜数据直接跳过网络）
 *   2. 对景点/酒店/餐厅各取 TopN 调 backfillMediaForPoi：Wikimedia 抓图 → 下载落盘 → 入库
 *   3. 结束输出库统计（目的地数/POI 数/媒体数/库体积）
 */
import '../src/config/load-server-env.js';
import { PlanningService } from '../src/skills/travel-planning/travel-planning-service.js';
import { poiCache } from '../src/skills/travel-planning/poi-cache-manager.js';
import { travelMediaStore } from '../src/skills/travel-planning/travel-media-store.js';
import { travelPoiDb } from '../src/skills/travel-planning/travel-poi-db.js';
import { UpstreamSearchService } from '../src/services/upstream-search-service.js';
import { InfoHubService } from '../src/services/info-hub-service.js';

/** 首批普遍覆盖名单：国内热门 20 + 国外热门 14 */
const SEED_DESTINATIONS: string[] = [
  // 国内
  '北京', '上海', '成都', '杭州', '西安', '重庆', '广州', '深圳',
  '南京', '苏州', '厦门', '三亚', '昆明', '大理', '丽江', '青岛',
  '长沙', '武汉', '桂林', '哈尔滨',
  // 国外
  '巴厘岛', '马尔代夫', '东京', '大阪', '京都', '曼谷', '普吉岛', '清迈',
  '新加坡', '首尔', '巴黎', '瑞士', '罗马', '悉尼',
];

// ---------- CLI 参数 ----------
const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='))?.slice(7);
const mediaArg = Number(args.find((a) => a.startsWith('--media='))?.slice(7));
const videoArg = Number(args.find((a) => a.startsWith('--videos='))?.slice(8));
/** 每类 POI 回填图片数量上限：景点 6 / 酒店 2 / 餐厅 2（--media=0 关闭抓图） */
const MEDIA_LIMITS: Record<'attraction' | 'hotel' | 'restaurant', number> = {
  attraction: Number.isFinite(mediaArg) ? mediaArg : 6,
  hotel: Number.isFinite(mediaArg) ? Math.min(2, mediaArg) : 2,
  restaurant: Number.isFinite(mediaArg) ? Math.min(2, mediaArg) : 2,
};
/** 每目的地视频回填景点数（--videos=0 关闭；真实播放页链接，必应视频搜索） */
const VIDEO_LIMIT = Number.isFinite(videoArg) ? videoArg : 4;

const targets = onlyArg
  ? SEED_DESTINATIONS.filter((d) => onlyArg.split(',').some((k) => d.includes(k.trim()) || k.trim().includes(d)))
  : SEED_DESTINATIONS;
if (targets.length === 0) {
  console.error(`[Seed] --only=${onlyArg} 未匹配到任何目的地`);
  process.exit(1);
}

const service = new PlanningService(undefined, new UpstreamSearchService(new InfoHubService()));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms)),
  ]);
}

/** 单目的地：POI 入库 + 媒体回填 */
async function seedDestination(dest: string): Promise<void> {
  const t0 = Date.now();
  // 1. POI 搜索（库内新鲜命中则零网络；过期触发后台刷新，本次仍用旧数据）
  const result = await withTimeout(service.searchDestination(dest), 120_000, `${dest} POI搜索`);
  const poiTotal = result.attractions.length + result.hotels.length + result.restaurants.length;
  if (poiTotal === 0) {
    console.log(`○ ${dest}: 无 POI 结果，跳过媒体回填`);
    return;
  }

  // 2. 媒体回填（外链图下载落盘 → 入库；抓一次永久复用）
  let filled = 0;
  let attempted = 0;
  let videoCount = 0;
  if (MEDIA_LIMITS.attraction > 0) {
    const plan: Array<{ type: 'attraction' | 'hotel' | 'restaurant'; list: typeof result.attractions; limit: number }> = [
      { type: 'attraction', list: result.attractions, limit: MEDIA_LIMITS.attraction },
      { type: 'hotel', list: result.hotels, limit: MEDIA_LIMITS.hotel },
      { type: 'restaurant', list: result.restaurants, limit: MEDIA_LIMITS.restaurant },
    ];
    for (const { type, list, limit } of plan) {
      if (limit <= 0) continue;
      // 评分优先，无评分按原顺序；已有图的跳过（库内复用）
      const picks = list
        .slice()
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .filter((p) => travelMediaStore.imageUrls(type, p.name).length === 0)
        .slice(0, limit);
      for (const poi of picks) {
        attempted++;
        try {
          const urls = await withTimeout(
            service.backfillMediaForPoi(poi.name, type, poi.latitude, poi.longitude),
            30_000,
            `${poi.name} 回填`,
          );
          filled += urls.length;
        } catch (err) {
          console.warn(`  ⚠ ${dest}/${poi.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // 3. 实拍视频回填（真实播放页链接，只收视频平台域名；已有视频的景点跳过）
  if (VIDEO_LIMIT > 0) {
    const videoPicks = result.attractions
      .slice()
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .filter((p) => (travelMediaStore.get('attraction', p.name)?.videos.length ?? 0) === 0)
      .slice(0, VIDEO_LIMIT);
    for (const poi of videoPicks) {
      try {
        videoCount += await withTimeout(
          service.backfillVideosForPoi(poi.name, 'attraction', poi.latitude, poi.longitude),
          30_000,
          `${poi.name} 视频回填`,
        );
      } catch (err) {
        console.warn(`  ⚠ ${dest}/${poi.name} 视频: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  console.log(
    `✓ ${dest}: 景点${result.attractions.length} 酒店${result.hotels.length} 餐厅${result.restaurants.length}` +
    `${result.fromCache ? ' (缓存)' : ' (实时)'} | 回填图 ${filled} 张 | 视频 ${videoCount} 条 | ${Date.now() - t0}ms`,
  );
}

async function main(): Promise<void> {
  console.log(`[Seed] 开始预建 ${targets.length} 个目的地（media: 景点${MEDIA_LIMITS.attraction} 酒店${MEDIA_LIMITS.hotel} 餐厅${MEDIA_LIMITS.restaurant} | 视频: 景点${VIDEO_LIMIT}）`);
  const t0 = Date.now();
  let ok = 0;
  let fail = 0;
  for (const dest of targets) {
    try {
      await seedDestination(dest);
      ok++;
    } catch (err) {
      fail++;
      console.warn(`✗ ${dest}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 汇总
  const cities = poiCache.listCachedDestinations();
  const poiRows = cities.reduce((s, c) => s + c.poiCount, 0);
  const stats = poiCache.getStats();
  console.log(
    `\n[Seed] 完成: 成功${ok} 失败${fail} | 库内目的地 ${cities.length} 个 / POI ${poiRows} 个` +
    ` / 库体积 ${(stats.totalSizeBytes / 1024).toFixed(0)}KB / 耗时 ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  void travelPoiDb;
  void travelMediaStore;
}

void main();
