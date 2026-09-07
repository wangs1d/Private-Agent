import type {
  HabitCandidate,
  HabitLocationSample,
  HabitToolObservation,
} from "./habit-types.js";

/**
 * 习惯挖掘器（纯算法，零 LLM）。
 *
 * 位置观察：把近 N 天的位置样本按「地点（label 或粗化坐标）× 到访时刻
 * 桶」聚类，同一地点同一时刻桶出现 ≥ minPlaceVisits 次 → 候选习惯
 * 「到访 {place}」（location_enter 触发）。
 *
 * 工具观察：同一工具在同一「星期 × 小时」出现 ≥ minToolCount 次 → 候选
 * 「定期 {tool}」（tool_pattern 触发，agent 可配动作后执行）。
 *
 * 挖掘出的候选一律先以 confirm_each 授权落库（由调用方创建规则），
 * 执行结果反馈回灌 confidence 后才有资格升 auto。
 */

const PLACE_COORD_PRECISION = 3; // ~110m 粗化，无 label 时兜底聚类

export interface HabitMinerOptions {
  windowDays?: number;
  minPlaceVisits?: number;
  minToolCount?: number;
}

export class HabitMiner {
  private readonly windowDays: number;
  private readonly minPlaceVisits: number;
  private readonly minToolCount: number;

  constructor(options: HabitMinerOptions = {}) {
    this.windowDays = options.windowDays ?? 21;
    this.minPlaceVisits = options.minPlaceVisits ?? 3;
    this.minToolCount = options.minToolCount ?? 3;
  }

  /** 位置观察 → 到访类候选习惯。 */
  mineFromLocation(samples: HabitLocationSample[], now = new Date()): HabitCandidate[] {
    const since = now.getTime() - this.windowDays * 86_400_000;
    const recent = samples.filter((s) => s.at >= since);
    if (recent.length === 0) return [];

    // 聚类 key：label 优先，否则粗化坐标
    const clusters = new Map<string, { label: string; lat?: number; lng?: number; visits: number[] }>();
    for (const s of recent) {
      const label = s.label?.trim();
      const key = label
        ? `label:${label}`
        : `coord:${s.latitude.toFixed(PLACE_COORD_PRECISION)},${s.longitude.toFixed(PLACE_COORD_PRECISION)}`;
      const cluster = clusters.get(key) ?? { label: label ?? "常去地点", lat: label ? undefined : s.latitude, lng: label ? undefined : s.longitude, visits: [] };
      cluster.visits.push(s.at);
      clusters.set(key, cluster);
    }

    const candidates: HabitCandidate[] = [];
    for (const cluster of clusters.values()) {
      if (cluster.visits.length < this.minPlaceVisits) continue;
      // 时刻桶：同一「星期 × ±1.5 小时」或「每日同时刻」出现次数
      const buckets = new Map<string, number[]>();
      for (const at of cluster.visits) {
        const d = new Date(at);
        const hour = d.getHours();
        const weekday = d.getDay();
        for (const bucket of [
          `wd${weekday}h${hour}`,
          `daily h${hour}`,
        ]) {
          const arr = buckets.get(bucket) ?? [];
          arr.push(at);
          buckets.set(bucket, arr);
        }
      }
      const best = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (!best || best[1].length < this.minPlaceVisits) continue;

      const bucketKey = best[0];
      const isWeekdayBucket = bucketKey.startsWith("wd");
      const hour = Number(bucketKey.split("h")[1]);
      const weekday = isWeekdayBucket ? Number(bucketKey.slice(2).split("h")[0]) : null;
      const times = best[1].length;
      candidates.push({
        name: isWeekdayBucket
          ? `每周${"日一二三四五六"[weekday ?? 0]} ${hour}:00 前后去 ${cluster.label}`
          : `每天 ${hour}:00 前后去 ${cluster.label}`,
        description: `近 ${this.windowDays} 天内在该时段到访 ${times} 次（${cluster.label}）`,
        trigger: {
          kind: "location_enter",
          placeLabel: cluster.label,
          latitude: cluster.lat,
          longitude: cluster.lng,
          radiusMeters: 200,
        },
        confidence: Math.min(0.65, 0.35 + times * 0.06),
        evidence: [
          `cluster=${cluster.label}`,
          `bucket=${bucketKey}`,
          `visits=${times}/${cluster.visits.length}`,
        ],
      });
    }
    return candidates;
  }

  /** 工具调用观察 → 定期操作类候选习惯。 */
  mineFromTools(observations: HabitToolObservation[], actorId: string, now = new Date()): HabitCandidate[] {
    const since = now.getTime() - this.windowDays * 86_400_000;
    const relevant = observations.filter((o) => o.actorId === actorId && o.at >= since);
    if (relevant.length === 0) return [];

    // 按「工具 × 星期 × 小时」与「工具 × 每日小时」统计
    type Key = { tool: string; bucket: string; weekday: number | null; hour: number };
    const stats = new Map<string, { key: Key; count: number }>();
    for (const o of relevant) {
      const d = new Date(o.at);
      const hour = d.getHours();
      const weekday = d.getDay();
      for (const bucket of [`wd${weekday}h${hour}`, `daily h${hour}`]) {
        const statKey = `${o.tool}|${bucket}`;
        const existing = stats.get(statKey);
        if (existing) existing.count += 1;
        else stats.set(statKey, { key: { tool: o.tool, bucket, weekday: bucket.startsWith("wd") ? weekday : null, hour }, count: 1 });
      }
    }

    const candidates: HabitCandidate[] = [];
    const seenTools = new Set<string>();
    // 按次数降序：同一工具只在最优时间桶出一条候选（周桶比日桶更具体时优先）
    const sorted = [...stats.values()].sort((a, b) => b.count - a.count);
    for (const { key, count } of sorted) {
      if (count < this.minToolCount) continue;
      if (seenTools.has(key.tool)) continue;
      seenTools.add(key.tool);
      const skipLowRisk = /weather|search|clock|media|hot_rankings/i.test(key.tool);
      if (skipLowRisk) continue; // 只读/低价值工具不建自动化规则
      candidates.push({
        name: key.weekday == null
          ? `每天 ${key.hour}:00 前后固定使用 ${key.tool}`
          : `每周${"日一二三四五六"[key.weekday]} ${key.hour}:00 前后固定使用 ${key.tool}`,
        description: `近 ${this.windowDays} 天内该时段调用 ${key.tool} 共 ${count} 次；可为它配置自动动作（如下单/提醒/查询）`,
        trigger: {
          kind: "tool_pattern",
          toolName: key.tool,
          hour: key.hour,
          weekday: key.weekday ?? undefined,
          windowDays: this.windowDays,
          minCount: this.minToolCount,
        },
        confidence: Math.min(0.6, 0.3 + count * 0.06),
        evidence: [`tool=${key.tool}`, `bucket=${key.bucket}`, `count=${count}`],
      });
    }
    return candidates;
  }
}
