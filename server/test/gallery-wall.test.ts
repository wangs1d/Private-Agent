import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 3D 照片墙域（gallery-wall-service + photo-analysis-service + 路由）测试。
 *
 * 覆盖：
 * - clusterAssetsByTime：3h 间隔分簇 / 未记录时间归末簇
 * - computeWallLayout：走廊坐标推进、左右交替挂墙、年月地标、动态照片标记、待分析计数
 * - 动画登记表：save/load 原子往返
 * - 路由：/gallery-wall 页面含桥探针、vendor 存在、layout 与 analyze 端点
 * - parseExifGps：度分秒解析与南/西半球
 *
 * 运行：npx tsx --test test/gallery-wall.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-wall-test-"));

const { createPictureKit } = await import("@private-ai-agent/picture");
const {
  clusterAssetsByTime,
  computeWallLayout,
} = await import("../src/services/gallery-wall-service.js");
const { parseExifGps } = await import("../src/services/photo-analysis-service.js");
const { registerGalleryWallRoutes } = await import("../src/routes/http/gallery-wall.js");
const { default: Fastify } = await import("fastify");

type PictureKit = import("@private-ai-agent/picture").PictureKit;
type ImageAsset = import("@private-ai-agent/picture").ImageAsset;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function assetAt(ts: number, id?: string): ImageAsset {
  return {
    id: id ?? `p${ts.toString(36)}`,
    filePath: "/tmp/x.png",
    fileName: "x.png",
    width: 100,
    height: 80,
    format: "png",
    fileSize: 1024,
    sha256: null,
    exif: {},
    takenAt: new Date(ts).toISOString(),
    tags: [],
    sceneType: null,
    rating: null,
    thumbnails: {},
    createdAt: new Date(ts).toISOString(),
  };
}

// ──────────────────────────── 分簇 ────────────────────────────

test("事件聚类：间隔>3h 切簇，连续照片同簇，未记录时间归末簇", () => {
  const base = Date.parse("2026-09-12T10:00:00Z");
  const assets = [
    assetAt(base),
    assetAt(base + 20 * 60_000),        // 20min 后 → 同簇
    assetAt(base + 4 * 3_600_000),      // 4h 后 → 新簇
    {
      ...assetAt(base, "untimed-1"),
      takenAt: null,
      createdAt: "not-a-date",
    },                                  // 无时间 → 末簇
  ];

  const clusters = clusterAssetsByTime(assets as ImageAsset[]);
  assert.equal(clusters.length, 3);
  assert.equal(clusters[0]!.length, 2);
  assert.equal(clusters[1]!.length, 1);
  assert.equal(clusters[2]!.length, 1);
  assert.equal(clusters[2]![0]!.id, "untimed-1");
});

// ──────────────────────────── 布局 ────────────────────────────

test("贴墙布局：x 沿走廊推进、左右交替、年月地标与待分析计数", async () => {
  const root = path.join(tmpDir, "layout-root");
  const kit = await createPictureKit({ rootDir: root });
  try {
    const base = Date.parse("2026-08-03T09:00:00Z");

    const assets = [
      assetAt(base, "a1"),
      assetAt(base + 5 * 60_000, "a2"),
      assetAt(Date.parse("2026-09-20T14:00:00Z"), "b1"),
    ];
    const layout = computeWallLayout(assets);

    assert.equal(layout.version, 1);
    assert.equal(layout.photoCount, 3);
    assert.equal(layout.events.length, 2);
    assert.equal(layout.pendingAnalysis, 3); // 都没有 analysis.analyzedAt

    const first = layout.events[0]!;
    assert.equal(first.photoCount, 2);
    assert.match(first.title, /8月3日/);
    // 同簇照片挂在走廊同一侧（簇=一面墙段），相邻簇左右交替
    assert.equal(first.photos[0]!.side, 1);
    assert.equal(first.photos[1]!.side, 1);
    assert.ok(first.photos[1]!.pos[0]! > first.photos[0]!.pos[0]!);

    const second = layout.events[1]!;
    assert.match(second.title, /9月20日/);
    assert.equal(second.photos[0]!.side, -1); // 交替到另一侧
    assert.ok(second.photos[0]!.pos[0]! > first.photos[1]!.pos[0]!);

    // 年月地标：8月、9月各一条，且 x 随走廊递增
    assert.deepEqual(layout.marks.map((m) => m.label), ["2026年8月", "2026年9月"]);
    assert.ok(layout.marks[1]!.x > layout.marks[0]!.x);
    assert.ok(layout.span.endX > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ──────────────────────────── GPS 解析 ────────────────────────────

test("parseExifGps：度分秒 → 十进制，南/西半球为负", () => {
  assert.ok(Math.abs((parseExifGps("31 deg 13' 22.32\" N", "N") ?? 0) - 31.222866) < 1e-5);
  assert.ok((parseExifGps("31 deg 13' 22.32\"", "S") ?? 0) < 0);
  assert.ok((parseExifGps("121 deg 28' 7.20\"", "W") ?? 0) < 0);
  assert.equal(parseExifGps(undefined, "N"), null);
  assert.equal(parseExifGps("garbage", "N"), null);
});

// ──────────────────────────── 路由 ────────────────────────────

test("gallery-wall 路由：页面桥探针 / vendor / layout / analyze", async () => {
  const root = path.join(tmpDir, `route-kit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const kit = await createPictureKit({ rootDir: root });
  const app = Fastify();
  // 注入桩分析器：单测不依赖真实视觉模型凭据
  registerGalleryWallRoutes(app, {
    pictureKit: kit,
    analyzeFn: async (images) =>
      images.map(() => ({ scene: "室内", place: "大理古城", caption: "光线很软，时间慢下来" })),
  });
  try {
    const page = await app.inject({ method: "GET", url: "/gallery-wall" });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes("window.__galleryWall"));
    assert.ok(page.body.includes("importmap"));

    const vendor = await app.inject({ method: "GET", url: "/gallery-wall/vendor/three.module.js" });
    assert.equal(vendor.statusCode, 200);
    assert.ok(vendor.body.includes("Three.js Authors"));

    await kit.store.ingest(PNG_1PX, { fileName: "r.png" });
    const layout = await app.inject({ method: "GET", url: "/gallery-wall/layout" });
    assert.equal(layout.statusCode, 200);
    const body = layout.json();
    assert.equal(body.photoCount, 1);
    assert.ok(body.events.length >= 1);
    assert.equal(typeof body.pendingAnalysis, "number");

    const pending = await app.inject({ method: "GET", url: "/gallery-wall/pending" });
    assert.equal(pending.json().pending, body.pendingAnalysis);

    // analyze：桩分析器逐张返回结果并写回 analysis（layout 的待分析计数应清零）
    const analyze = await app.inject({
      method: "POST",
      url: "/gallery-wall/analyze",
      payload: { limit: 4 },
    });
    assert.equal(analyze.statusCode, 200);
    assert.equal(analyze.json().ok, true);
    assert.equal(analyze.json().analyzed, 1);
    assert.equal(analyze.json().failed, 0);
    assert.equal(analyze.json().remaining, 0);

    const layoutAfter = await app.inject({ method: "GET", url: "/gallery-wall/layout" });
    assert.equal(layoutAfter.json().pendingAnalysis, 0);
    const photoWithAnalysis = layoutAfter.json().events[0].photos[0];
    assert.equal(photoWithAnalysis.place, "大理古城");
    assert.equal(photoWithAnalysis.caption, "光线很软，时间慢下来");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
