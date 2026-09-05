/**
 * 位置历史存储与查询（位置方案 B）。
 *
 * SQLite 本地存储（缺省 data/location/location.db，AGENT_LOCATION_DB 覆盖），
 * 表 location_samples：actor + 时间 + 经纬度 + 逆地理标签。
 *
 * 隐私约束（服务层保证）：
 *   - 保留期外的轨迹由 pruneExpired 惰性删除（缺省 7 天，可配置）；
 *   - clear(actorId) 一键清除该用户全部历史；
 *   - 只写本地磁盘，不经过任何网络出口。
 *
 * 常去地点挖掘：mineFrequentPlaces 用 DBSCAN（eps 米 / minPoints）把近 N 天
 * 样本聚簇，输出质心、到访次数、簇半径与最常见标签，供地理围栏与主动性消费。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  getLocationDbPath,
  getLocationDbscanEpsMeters,
  getLocationDbscanMinPoints,
  getLocationHistoryRetentionDays,
} from "../config/location-env.js";
import { dbscan, haversineMeters } from "./geo-utils.js";

export type LocationSampleSource = "continuous" | "ondemand" | "report";

export type LocationSample = {
  id: number;
  actorId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  label: string | null;
  city: string | null;
  district: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
  source: LocationSampleSource;
};

/** 常去地点（DBSCAN 簇的摘要形态） */
export type FrequentPlace = {
  /** 稳定 id：质心取整指纹（同地点跨天挖掘结果可对齐） */
  id: string;
  label: string | null;
  latitude: number;
  longitude: number;
  /** 簇内样本数（≈ 到访上报次数） */
  visitCount: number;
  /** 覆盖的天数（按本地日期去重） */
  distinctDays: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 簇内样本到质心的最大距离（米），供「到达判定」半径参考 */
  radiusMeters: number;
};

export type MovementStats = {
  sampleCount: number;
  /** 窗口内相邻样本的累计位移（米） */
  pathMeters: number;
  /** 首尾直线位移（米） */
  displacementMeters: number;
  /** 是否判定「在移动」：任一相邻跳变超过阈值 */
  moving: boolean;
  firstAt: string | null;
  lastAt: string | null;
};

export type LocationHistoryOptions = {
  dbPath?: string;
  retentionDays?: number;
  dbscanEpsMeters?: number;
  dbscanMinPoints?: number;
  now?: () => Date;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS location_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  label TEXT,
  city TEXT,
  district TEXT,
  region TEXT,
  country TEXT,
  timezone TEXT,
  source TEXT NOT NULL DEFAULT 'report'
);
CREATE INDEX IF NOT EXISTS idx_location_samples_actor_time
  ON location_samples(actor_id, recorded_at);
`;

function rowToSample(row: Record<string, unknown>): LocationSample {
  return {
    id: Number(row.id),
    actorId: String(row.actor_id),
    recordedAt: String(row.recorded_at),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    label: (row.label as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    source: (row.source as LocationSampleSource) ?? "report",
  };
}

/** 惰性清理的最小间隔：避免每条上报都全表 DELETE。 */
const PRUNE_THROTTLE_MS = 60 * 60 * 1000;

export class LocationHistoryService {
  private readonly db: SqliteDatabase;
  private readonly retentionDays: number;
  private readonly dbscanEpsMeters: number;
  private readonly dbscanMinPoints: number;
  private readonly now: () => Date;
  private lastPruneAt = 0;
  private onCleared: ((actorId: string) => void) | null = null;

  constructor(opts?: LocationHistoryOptions) {
    const file = opts?.dbPath ?? getLocationDbPath();
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.retentionDays = opts?.retentionDays ?? getLocationHistoryRetentionDays();
    this.dbscanEpsMeters = opts?.dbscanEpsMeters ?? getLocationDbscanEpsMeters();
    this.dbscanMinPoints = opts?.dbscanMinPoints ?? getLocationDbscanMinPoints();
    this.now = opts?.now ?? (() => new Date());
  }

  /** 写入一条位置样本（写入侧不区分模式；是否落历史由装配层的开关决定）。 */
  record(
    actorId: string,
    loc: { latitude: number; longitude: number; city?: string; district?: string; region?: string; country?: string; timezone?: string; label?: string },
    source: LocationSampleSource = "report",
    at: Date = this.now(),
  ): LocationSample {
    const stmt = this.db.prepare(
      `INSERT INTO location_samples
        (actor_id, recorded_at, latitude, longitude, label, city, district, region, country, timezone, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      actorId,
      at.toISOString(),
      loc.latitude,
      loc.longitude,
      loc.label?.trim() || null,
      loc.city?.trim() || null,
      loc.district?.trim() || null,
      loc.region?.trim() || null,
      loc.country?.trim() || null,
      loc.timezone?.trim() || null,
      source,
    );
    this.pruneExpired(true);
    return {
      id: Number(info.lastInsertRowid),
      actorId,
      recordedAt: at.toISOString(),
      latitude: loc.latitude,
      longitude: loc.longitude,
      label: loc.label?.trim() || null,
      city: loc.city?.trim() || null,
      district: loc.district?.trim() || null,
      region: loc.region?.trim() || null,
      country: loc.country?.trim() || null,
      timezone: loc.timezone?.trim() || null,
      source,
    };
  }

  /** 按时间范围查询（升序，最多 limit 条，缺省 2000）。 */
  query(actorId: string, from: Date, to: Date = this.now(), limit = 2000): LocationSample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM location_samples
          WHERE actor_id = ? AND recorded_at >= ? AND recorded_at <= ?
          ORDER BY recorded_at ASC LIMIT ?`,
      )
      .all(actorId, from.toISOString(), to.toISOString(), Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map(rowToSample);
  }

  /** 最新一条样本（无历史返回 null）。 */
  latest(actorId: string): LocationSample | null {
    const row = this.db
      .prepare(
        `SELECT * FROM location_samples WHERE actor_id = ? ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(actorId) as Record<string, unknown> | undefined;
    return row ? rowToSample(row) : null;
  }

  count(actorId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM location_samples WHERE actor_id = ?`)
      .get(actorId) as { c: number };
    return Number(row.c);
  }

  /**
   * 注册「用户清除历史」回调（如到达触发器缓存失效）：
   * 已删除的数据不应再驱动任何主动行为。
   */
  setOnCleared(fn: ((actorId: string) => void) | null): void {
    this.onCleared = fn;
  }

  /** 一键清除该用户全部位置历史（返回删除条数）。 */
  clear(actorId: string): number {
    const info = this.db.prepare(`DELETE FROM location_samples WHERE actor_id = ?`).run(actorId);
    const deleted = Number(info.changes);
    if (deleted > 0) {
      try {
        this.onCleared?.(actorId);
      } catch {
        /* 回调失败不影响清除本身 */
      }
    }
    return deleted;
  }

  /**
   * 删除保留期外的样本。record 路径带节流（每小时最多一次全表清理）；
   * throttled=false 时强制执行（用户手动/测试用）。
   */
  pruneExpired(throttled = false): number {
    const nowMs = this.now().getTime();
    if (throttled && nowMs - this.lastPruneAt < PRUNE_THROTTLE_MS) return 0;
    this.lastPruneAt = nowMs;
    const cutoff = new Date(nowMs - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const info = this.db
      .prepare(`DELETE FROM location_samples WHERE recorded_at < ?`)
      .run(cutoff);
    return Number(info.changes);
  }

  /**
   * 常去地点挖掘：近 days 天（缺省=保留期）样本 DBSCAN 聚簇，
   * 按到访次数降序输出前 maxPlaces 个。
   */
  mineFrequentPlaces(
    actorId: string,
    opts?: { days?: number; epsMeters?: number; minPoints?: number; maxPlaces?: number },
  ): FrequentPlace[] {
    const days = Math.min(opts?.days ?? this.retentionDays, this.retentionDays);
    const eps = opts?.epsMeters ?? this.dbscanEpsMeters;
    const minPts = opts?.minPoints ?? this.dbscanMinPoints;
    const maxPlaces = opts?.maxPlaces ?? 10;
    const from = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000);
    const samples = this.query(actorId, from, this.now(), 5000);
    if (samples.length < minPts) return [];

    const { clusters } = dbscan(samples, eps, minPts);
    const places = clusters.map((cluster) => {
      // 质心：算术平均（簇半径 ≤ eps，球面误差可忽略）
      const lat = cluster.reduce((s, p) => s + p.latitude, 0) / cluster.length;
      const lng = cluster.reduce((s, p) => s + p.longitude, 0) / cluster.length;
      const centroid = { latitude: lat, longitude: lng };
      const times = cluster.map((p) => p.recordedAt).sort();
      const daysSet = new Set(times.map((t) => t.slice(0, 10)));
      const labelCounts = new Map<string, number>();
      for (const p of cluster) {
        const l = p.label?.trim();
        if (l) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
      }
      const label =
        [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const radiusMeters = Math.max(
        ...cluster.map((p) => haversineMeters(centroid, p)),
      );
      return {
        id: `place_${(Math.round(lat * 1000)).toString(36)}_${(Math.round(lng * 1000)).toString(36)}`,
        label,
        latitude: Math.round(lat * 1e6) / 1e6,
        longitude: Math.round(lng * 1e6) / 1e6,
        visitCount: cluster.length,
        distinctDays: daysSet.size,
        firstSeenAt: times[0],
        lastSeenAt: times[times.length - 1],
        radiusMeters: Math.round(radiusMeters),
      } satisfies FrequentPlace;
    });
    return places
      .sort((a, b) => b.visitCount - a.visitCount || b.distinctDays - a.distinctDays)
      .slice(0, maxPlaces);
  }

  /**
   * 窗口内移动统计（节律 location-sensor / 到达判定消费）：
   * 相邻样本跳变超过 jumpMeters 视为移动中。
   */
  movementStats(actorId: string, windowMs: number, jumpMeters = 120): MovementStats {
    const from = new Date(this.now().getTime() - windowMs);
    const samples = this.query(actorId, from, this.now(), 2000);
    if (samples.length === 0) {
      return {
        sampleCount: 0,
        pathMeters: 0,
        displacementMeters: 0,
        moving: false,
        firstAt: null,
        lastAt: null,
      };
    }
    let pathMeters = 0;
    let moving = false;
    for (let i = 1; i < samples.length; i++) {
      const d = haversineMeters(samples[i - 1], samples[i]);
      pathMeters += d;
      if (d > jumpMeters) moving = true;
    }
    const displacementMeters = haversineMeters(samples[0], samples[samples.length - 1]);
    return {
      sampleCount: samples.length,
      pathMeters: Math.round(pathMeters),
      displacementMeters: Math.round(displacementMeters),
      moving,
      firstAt: samples[0].recordedAt,
      lastAt: samples[samples.length - 1].recordedAt,
    };
  }

  close(): void {
    this.db.close();
  }
}
