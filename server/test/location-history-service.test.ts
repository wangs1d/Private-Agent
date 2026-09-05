/**
 * 位置方案 B 单测：location-history-service（位置历史存储与查询）。
 *
 * 覆盖：
 *   1. record / query / latest / count 基础 CRUD（时间范围过滤）
 *   2. clear 一键清除（隐私原则：用户数据可随时销毁）
 *   3. pruneExpired 保留期清理（注入时钟）
 *   4. mineFrequentPlaces：DBSCAN 两簇分离 / 噪声不成簇 / 标签投票 / 按到访排序
 *   5. movementStats：移动判定（跳变阈值）
 *   6. LocationIngestPipeline：历史关闭时静默、开启时落库
 *
 * 测试封闭：临时 SQLite，无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocationHistoryService,
  type LocationSample,
} from "../src/services/location-history-service.js";
import { LocationIngestPipeline } from "../src/services/location-ingest-pipeline.js";

const BASE_AT = Date.parse("2026-09-04T10:00:00Z");

interface Ctx {
  svc: LocationHistoryService;
  dir: string;
  setNow: (iso: string) => void;
}

async function withHistory(fn: (ctx: Ctx) => Promise<void>, opts?: { retentionDays?: number }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "location-history-"));
  let nowMs = BASE_AT;
  const svc = new LocationHistoryService({
    dbPath: join(dir, "history.db"),
    ...(opts?.retentionDays ? { retentionDays: opts.retentionDays } : {}),
    now: () => new Date(nowMs),
  });
  const setNow = (iso: string) => {
    nowMs = Date.parse(iso);
  };
  try {
    await fn({ svc, dir, setNow });
  } finally {
    svc.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 生成围绕 (lat,lng) 的抖动样本（GPS 漂移 ≤ 30m 量级） */
function jitterSamples(lat: number, lng: number, count: number, startMs: number, stepMs = 5 * 60_000): Array<{ at: Date; lat: number; lng: number }> {
  const out: Array<{ at: Date; lat: number; lng: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({
      at: new Date(startMs + i * stepMs),
      lat: lat + (Math.sin(i * 1.7) * 0.0002), // ≈ ±22m
      lng: lng + (Math.cos(i * 2.3) * 0.0002),
    });
  }
  return out;
}

test("record/query/latest/count：写入与时间范围过滤", async () => {
  await withHistory(async ({ svc }) => {
    svc.record("u1", { latitude: 39.9, longitude: 116.4, label: "北京 · 东城区" }, "continuous", new Date(BASE_AT));
    svc.record("u1", { latitude: 39.91, longitude: 116.41 }, "continuous", new Date(BASE_AT + 60_000));
    svc.record("u2", { latitude: 31.2, longitude: 121.5 }, "continuous", new Date(BASE_AT + 60_000));

    assert.equal(svc.count("u1"), 2);
    assert.equal(svc.count("u2"), 1);

    const all = svc.query("u1", new Date(BASE_AT - 1000), new Date(BASE_AT + 120_000));
    assert.equal(all.length, 2);
    assert.equal(all[0].label, "北京 · 东城区");
    assert.equal(all[0].source, "continuous");

    // 时间范围只命中第二条
    const late = svc.query("u1", new Date(BASE_AT + 30_000), new Date(BASE_AT + 120_000));
    assert.equal(late.length, 1);
    assert.equal(late[0].latitude, 39.91);

    const latest = svc.latest("u1") as LocationSample;
    assert.equal(latest.latitude, 39.91);

    assert.equal(svc.latest("nobody"), null);
  });
});

test("clear：一键清除该用户全部历史，不影响他人", async () => {
  await withHistory(async ({ svc }) => {
    svc.record("u1", { latitude: 39.9, longitude: 116.4 }, "continuous");
    svc.record("u1", { latitude: 39.91, longitude: 116.41 }, "continuous");
    svc.record("u2", { latitude: 31.2, longitude: 121.5 }, "continuous");

    const deleted = svc.clear("u1");
    assert.equal(deleted, 2);
    assert.equal(svc.count("u1"), 0);
    assert.equal(svc.count("u2"), 1);
  });
});

test("pruneExpired：保留期外样本被清理（注入时钟推进 8 天）", async () => {
  await withHistory(
    async ({ svc, setNow }) => {
      svc.record("u1", { latitude: 39.9, longitude: 116.4 }, "continuous", new Date(BASE_AT));
      svc.record("u1", { latitude: 39.9, longitude: 116.4 }, "continuous", new Date(BASE_AT + 3600_000));
      // 推进到 8 天后：两条都超 7 天保留期
      setNow("2026-09-12T10:00:00Z");
      const pruned = svc.pruneExpired(false);
      assert.equal(pruned, 2);
      assert.equal(svc.count("u1"), 0);
    },
    { retentionDays: 7 },
  );
});

test("mineFrequentPlaces：两簇分离 + 噪声排除 + 标签投票 + 排序", async () => {
  await withHistory(async ({ svc, setNow }) => {
    // 家：30 个样本（20 个 label「家」，10 个 label「小区」）
    const home = jitterSamples(39.9001, 116.4001, 30, BASE_AT);
    home.forEach((s, i) =>
      svc.record("u1", { latitude: s.lat, longitude: s.lng, label: i < 20 ? "家" : "小区" }, "continuous", s.at),
    );
    // 公司：18 个样本（低于默认 minPoints=20 → 噪声，不成常去地点）
    const office = jitterSamples(39.9601, 116.4601, 18, BASE_AT + 3 * 3600_000);
    office.forEach((s) =>
      svc.record("u1", { latitude: s.lat, longitude: s.lng, label: "公司" }, "continuous", s.at),
    );
    // 时钟推进到全部样本之后，挖掘窗口才可见
    setNow("2026-09-04T14:00:00Z");

    const places = svc.mineFrequentPlaces("u1");
    assert.equal(places.length, 1, "公司样本不足 minPoints，应只有家一簇");
    const homePlace = places[0];
    assert.equal(homePlace.label, "家", "标签应取簇内多数");
    assert.equal(homePlace.visitCount, 30);
    // 质心应贴近真实中心（39.9001, 116.4001）
    assert.ok(Math.abs(homePlace.latitude - 39.9001) < 0.0005);
    assert.ok(Math.abs(homePlace.longitude - 116.4001) < 0.0005);
    assert.ok(homePlace.radiusMeters > 0 && homePlace.radiusMeters < 100);
    // 同一地点的稳定 id：再挖一次应一致
    const again = svc.mineFrequentPlaces("u1");
    assert.equal(again[0].id, homePlace.id);
  });
});

test("movementStats：跳变超过阈值判为移动", async () => {
  await withHistory(async ({ svc, setNow }) => {
    setNow("2026-09-04T10:30:00Z"); // 推进到全部样本之后
    // 静止：3 个漂移样本
    for (const s of jitterSamples(39.9, 116.4, 3, BASE_AT)) {
      svc.record("u1", { latitude: s.lat, longitude: s.lng }, "continuous", s.at);
    }
    const still = svc.movementStats("u1", 24 * 3600_000);
    assert.equal(still.moving, false);
    assert.equal(still.sampleCount, 3);

    // 通勤：一次 ~1.1km 跳变（约 0.01 度纬度）
    svc.record("u1", { latitude: 39.91, longitude: 116.4 }, "continuous", new Date(BASE_AT + 20 * 60_000));
    const moving = svc.movementStats("u1", 24 * 3600_000);
    assert.equal(moving.moving, true);
    assert.ok(moving.pathMeters > 800);
    assert.equal(moving.sampleCount, 4);
  });
});

test("LocationIngestPipeline：历史关闭时静默，开启时落库并回调", async () => {
  await withHistory(async ({ svc }) => {
    const reported: Array<{ actorId: string; source: string }> = [];
    const pipelineOn = new LocationIngestPipeline({
      history: svc,
      geofence: null,
      onLocationReported: (actorId, _loc, source) => reported.push({ actorId, source }),
    });
    pipelineOn.ingest("u1", { latitude: 39.9, longitude: 116.4, source: "continuous" }, "continuous");
    assert.equal(svc.count("u1"), 1);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].source, "continuous");

    // history=null：隐私默认（ondemand）整条历史链路静默
    const reported2: string[] = [];
    const pipelineOff = new LocationIngestPipeline({
      history: null,
      geofence: null,
      onLocationReported: (_a, _l, source) => reported2.push(source),
    });
    pipelineOff.ingest("u1", { latitude: 39.9, longitude: 116.4 }, "report");
    assert.equal(svc.count("u1"), 1, "不新增历史");
    assert.equal(reported2.length, 1);
  });
});

test("LocationIngestPipeline：同 actor 高频上报被频控丢弃，间隔可配", async () => {
  await withHistory(async ({ svc }) => {
    let nowMs = BASE_AT;
    const reported: string[] = [];
    const pipeline = new LocationIngestPipeline({
      history: svc,
      geofence: null,
      minIntervalMs: 10_000,
      now: () => nowMs,
      onLocationReported: (_a, _l, source) => reported.push(source),
    });
    assert.equal(pipeline.ingest("u1", { latitude: 39.9, longitude: 116.4 }, "continuous"), true);
    // 5s 后的同 actor 上报：丢弃（不落历史、不回调）
    nowMs = BASE_AT + 5_000;
    assert.equal(pipeline.ingest("u1", { latitude: 39.91, longitude: 116.41 }, "continuous"), false);
    assert.equal(svc.count("u1"), 1);
    assert.equal(reported.length, 1);
    // 超过间隔后恢复消费
    nowMs = BASE_AT + 10_001;
    assert.equal(pipeline.ingest("u1", { latitude: 39.92, longitude: 116.42 }, "continuous"), true);
    assert.equal(svc.count("u1"), 2);
    // 其他 actor 不受影响
    assert.equal(pipeline.ingest("u2", { latitude: 31.2, longitude: 121.5 }, "report"), true);
  });
});

test("clear 触发 onCleared 回调（供触发器缓存失效），无删除不回调", async () => {
  await withHistory(async ({ svc }) => {
    const cleared: string[] = [];
    svc.setOnCleared((actorId) => cleared.push(actorId));
    svc.record("u1", { latitude: 39.9, longitude: 116.4 }, "continuous");
    svc.record("u2", { latitude: 31.2, longitude: 121.5 }, "continuous");

    assert.equal(svc.clear("u1"), 1);
    assert.deepEqual(cleared, ["u1"]);
    // 再清一次（已无数据）：不回调
    assert.equal(svc.clear("u1"), 0);
    assert.deepEqual(cleared, ["u1"]);
  });
});
