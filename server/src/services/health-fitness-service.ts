import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 健康 / 运动数据能力域 service。
 *
 * 存储模型：每个 actor 一个独立 JSON 文件 `data/health/{actorId}.json`，
 * 形如 `{ metrics: [...], goals: [...] }`。
 *
 * 持久化模式参考 {@link LifeSignalHubService}：内存态 + 防抖落盘，
 * 启动时一次性 `load()` 全部文件，关停 / 1s 静默后 `flush()` 落盘。
 */

/** 单条健康指标记录。 */
export interface HealthMetric {
  /** 记录 ID（uuid） */
  id: string;
  /** 指标类型：weight / heart_rate / blood_pressure / sleep_duration / steps / exercise_duration / blood_glucose / spo2 / temperature / ... */
  type: string;
  /** 数值（血压等复合指标可记录收缩压，舒张压放 note） */
  value: number;
  /** 单位：kg / bpm / mmHg / h / steps / ... */
  unit: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 备注（可选） */
  note?: string;
}

/** 健康目标。 */
export interface HealthGoal {
  /** 目标 ID（uuid） */
  id: string;
  /** 与 metric.type 对齐，如 steps / weight */
  type: string;
  /** 目标值 */
  target: number;
  /** 周期：daily / weekly / monthly / yearly / total */
  period: "daily" | "weekly" | "monthly" | "yearly" | "total";
  /** 截止时间（ISO 8601，可选） */
  deadline?: string;
  /** 创建时间 */
  createdAt: string;
}

/** 单个 actor 的存储结构。 */
interface HealthStore {
  metrics: HealthMetric[];
  goals: HealthGoal[];
}

/** 周期汇总结果。 */
export interface HealthSummary {
  type: string;
  period: "week" | "month" | "year";
  from: string;
  to: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  /** 按天分组的均值 */
  daily: Array<{ date: string; mean: number; count: number; min: number; max: number }>;
  /** 趋势：rising / falling / stable / unknown */
  trend: "rising" | "falling" | "stable" | "unknown";
  /** 趋势变化率（首日均 vs 末日均，正为升） */
  trendDelta: number;
  /** 最近一条记录 */
  latest?: HealthMetric;
}

/** 目标 + 完成进度。 */
export interface HealthGoalWithProgress {
  goal: HealthGoal;
  /** 当前周期累计 / 最新值（按 goal.type 决定语义） */
  current: number;
  /** 完成率 0~1（可能 >1 表示超额） */
  progress: number;
  /** 是否达成 */
  achieved: boolean;
  /** 剩余值（target - current，可负） */
  remaining: number;
  /** 进度语义说明 */
  semantics: "sum" | "latest";
}

export class HealthFitnessService {
  /** 内存态：actorId → store */
  private readonly stores = new Map<string, HealthStore>();
  /** 脏标记：actorId 集合 */
  private readonly dirty = new Set<string>();
  /** 防抖定时器 */
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir: string) {}

  /**
   * 启动加载：扫描 `dataDir` 下所有 `*.json` 文件，加载到内存。
   *
   * 文件名规则：`{actorId}.json`（actorId 中若含路径分隔符会先做兜底替换）。
   */
  async load(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dataDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[HealthFitness] load readdir failed:", error);
      }
      return;
    }
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const actorId = f.slice(0, -5); // 去掉 .json
          try {
            const raw = await readFile(join(this.dataDir, f), "utf8");
            const parsed = JSON.parse(raw) as Partial<HealthStore>;
            this.stores.set(actorId, this.normalizeStore(parsed));
          } catch (error) {
            console.error(`[HealthFitness] load file ${f} failed:`, error);
          }
        }),
    );
  }

  /**
   * 全量落盘脏数据。关停 / 防抖触发时调用。
   */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty.size === 0) return;
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    await Promise.all(
      ids.map(async (actorId) => {
        const store = this.stores.get(actorId);
        if (!store) return;
        try {
          await mkdir(this.dataDir, { recursive: true });
          await writeFile(
            join(this.dataDir, `${actorId}.json`),
            JSON.stringify(store, null, 2),
            "utf8",
          );
        } catch (error) {
          console.error(`[HealthFitness] flush ${actorId} failed:`, error);
        }
      }),
    );
  }

  /**
   * 记录一条健康指标。
   *
   * @param actorId 用户标识
   * @param type 指标类型（weight / heart_rate / ...）
   * @param value 数值
   * @param unit 单位
   * @param note 备注（可选）
   * @param timestamp ISO 8601，未传则用当前时间
   */
  async logMetric(
    actorId: string,
    type: string,
    value: number,
    unit: string,
    note?: string,
    timestamp?: string,
  ): Promise<HealthMetric> {
    const metric: HealthMetric = {
      id: this.genId(),
      type,
      value,
      unit,
      timestamp: timestamp ?? new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    const store = this.getStore(actorId);
    store.metrics.push(metric);
    // 单文件上限 10000 条，防止无限增长
    if (store.metrics.length > 10_000) {
      store.metrics.splice(0, store.metrics.length - 10_000);
    }
    this.schedulePersist(actorId);
    return metric;
  }

  /**
   * 批量导入指标。用于客户端 Apple Health / 手环导出。
   *
   * @returns 成功条数
   */
  async importMetrics(actorId: string, metrics: HealthMetric[]): Promise<number> {
    const store = this.getStore(actorId);
    let added = 0;
    for (const m of metrics) {
      if (typeof m.type !== "string" || typeof m.value !== "number") continue;
      store.metrics.push({
        id: typeof m.id === "string" ? m.id : this.genId(),
        type: m.type,
        value: m.value,
        unit: typeof m.unit === "string" ? m.unit : "",
        timestamp: typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString(),
        ...(typeof m.note === "string" && m.note ? { note: m.note } : {}),
      });
      added += 1;
    }
    if (store.metrics.length > 10_000) {
      store.metrics.splice(0, store.metrics.length - 10_000);
    }
    if (added > 0) this.schedulePersist(actorId);
    return added;
  }

  /**
   * 查询历史指标。
   *
   * @param actorId 用户标识
   * @param type 指标类型（不传则返回所有类型）
   * @param from 起始时间 ISO 8601（含）
   * @param to 结束时间 ISO 8601（含）
   * @param limit 返回条数上限（默认 100，最新在前）
   */
  getMetrics(
    actorId: string,
    type?: string,
    from?: string,
    to?: string,
    limit = 100,
  ): HealthMetric[] {
    const store = this.stores.get(actorId);
    if (!store) return [];
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const filtered = store.metrics.filter((m) => {
      if (type && m.type !== type) return false;
      const t = Date.parse(m.timestamp);
      if (!Number.isFinite(t)) return false;
      return t >= fromMs && t <= toMs;
    });
    // 最新在前
    filtered.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return filtered.slice(0, Math.max(1, Math.min(1000, limit)));
  }

  /**
   * 周期汇总：按天分组统计均值 / 极值 / 趋势。
   *
   * @param period week / month / year
   */
  getSummary(
    actorId: string,
    type: string,
    period: "week" | "month" | "year",
  ): HealthSummary {
    const now = Date.now();
    const periodMs =
      period === "week" ? 7 * 86_400_000 : period === "month" ? 30 * 86_400_000 : 365 * 86_400_000;
    const fromMs = now - periodMs;
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(now).toISOString();

    const metrics = this.getMetrics(actorId, type, fromIso, toIso, 10_000);
    // getMetrics 返回最新在前，反转为升序便于按天聚合
    metrics.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    if (metrics.length === 0) {
      return {
        type,
        period,
        from: fromIso,
        to: toIso,
        count: 0,
        mean: 0,
        min: 0,
        max: 0,
        daily: [],
        trend: "unknown",
        trendDelta: 0,
      };
    }

    const sum = metrics.reduce((acc, m) => acc + m.value, 0);
    const mean = sum / metrics.length;
    const min = metrics.reduce((acc, m) => Math.min(acc, m.value), Number.POSITIVE_INFINITY);
    const max = metrics.reduce((acc, m) => Math.max(acc, m.value), Number.NEGATIVE_INFINITY);

    // 按天分组
    const dayBuckets = new Map<string, HealthMetric[]>();
    for (const m of metrics) {
      const day = m.timestamp.slice(0, 10); // YYYY-MM-DD
      const list = dayBuckets.get(day) ?? [];
      list.push(m);
      dayBuckets.set(day, list);
    }
    const daily = Array.from(dayBuckets.entries())
      .map(([date, list]) => {
        const s = list.reduce((acc, m) => acc + m.value, 0);
        return {
          date,
          mean: s / list.length,
          count: list.length,
          min: list.reduce((acc, m) => Math.min(acc, m.value), Number.POSITIVE_INFINITY),
          max: list.reduce((acc, m) => Math.max(acc, m.value), Number.NEGATIVE_INFINITY),
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // 趋势：对比前半段日均 vs 后半段日均
    let trend: HealthSummary["trend"] = "stable";
    let trendDelta = 0;
    if (daily.length >= 2) {
      const mid = Math.floor(daily.length / 2);
      const firstHalf = daily.slice(0, mid);
      const secondHalf = daily.slice(mid);
      const avg = (arr: typeof daily) =>
        arr.length === 0 ? 0 : arr.reduce((acc, d) => acc + d.mean, 0) / arr.length;
      const firstAvg = avg(firstHalf);
      const secondAvg = avg(secondHalf);
      trendDelta = secondAvg - firstAvg;
      const rel = firstAvg !== 0 ? Math.abs(trendDelta / firstAvg) : 0;
      if (rel < 0.02) trend = "stable";
      else if (trendDelta > 0) trend = "rising";
      else trend = "falling";
    }

    const latest = metrics[metrics.length - 1];

    return {
      type,
      period,
      from: fromIso,
      to: toIso,
      count: metrics.length,
      mean: Number(mean.toFixed(4)),
      min,
      max,
      daily: daily.map((d) => ({
        ...d,
        mean: Number(d.mean.toFixed(4)),
      })),
      trend,
      trendDelta: Number(trendDelta.toFixed(4)),
      latest,
    };
  }

  /**
   * 设置健康目标。
   */
  setGoal(
    actorId: string,
    type: string,
    target: number,
    period: HealthGoal["period"],
    deadline?: string,
  ): HealthGoal {
    const goal: HealthGoal = {
      id: this.genId(),
      type,
      target,
      period,
      createdAt: new Date().toISOString(),
      ...(deadline ? { deadline } : {}),
    };
    const store = this.getStore(actorId);
    store.goals.push(goal);
    this.schedulePersist(actorId);
    return goal;
  }

  /**
   * 返回所有目标 + 完成进度。
   *
   * 进度语义：
   *   - 「累计型」(steps / sleep_duration / exercise_duration / calories) → 当前周期累计 / target
   *   - 「最新型」(weight / blood_pressure / heart_rate baseline / blood_glucose) → 最新值 / target
   */
  getGoalsWithProgress(actorId: string): HealthGoalWithProgress[] {
    const store = this.stores.get(actorId);
    if (!store) return [];
    const now = Date.now();
    return store.goals.map((goal) => {
      const isLatestType = LATEST_SEMANTIC_TYPES.has(goal.type);
      const semantics: "sum" | "latest" = isLatestType ? "latest" : "sum";
      let current = 0;
      if (semantics === "latest") {
        const metrics = this.getMetrics(actorId, goal.type, undefined, undefined, 1);
        current = metrics.length > 0 ? metrics[0].value : 0;
      } else {
        const rangeMs = periodToMs(goal.period);
        const fromIso = new Date(now - rangeMs).toISOString();
        const metrics = this.getMetrics(actorId, goal.type, fromIso, undefined, 10_000);
        current = metrics.reduce((acc, m) => acc + m.value, 0);
      }
      const progress = goal.target !== 0 ? current / goal.target : 0;
      const achieved =
        semantics === "latest"
          ? // 最新型：是否「朝目标方向」达到（绝对值不强制收敛，简单按 current ≤ target 视为目标已达成？）
            // 这里用 abs(current - target) <= abs(target) * 0.02 近似达成
            Math.abs(current - goal.target) <= Math.abs(goal.target) * 0.02
          : current >= goal.target;
      const remaining = goal.target - current;
      return { goal, current, progress, achieved, remaining, semantics };
    });
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  private getStore(actorId: string): HealthStore {
    let store = this.stores.get(actorId);
    if (!store) {
      store = { metrics: [], goals: [] };
      this.stores.set(actorId, store);
    }
    return store;
  }

  private normalizeStore(input: Partial<HealthStore> | null | undefined): HealthStore {
    const metrics = Array.isArray(input?.metrics)
      ? (input!.metrics.filter((m) => m && typeof m === "object") as HealthMetric[])
          .map((m) => ({
            id: typeof m.id === "string" ? m.id : this.genId(),
            type: String(m.type ?? ""),
            value: Number(m.value) || 0,
            unit: String(m.unit ?? ""),
            timestamp: typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString(),
            ...(typeof m.note === "string" && m.note ? { note: m.note } : {}),
          }))
      : [];
    const goals = Array.isArray(input?.goals)
      ? (input!.goals.filter((g) => g && typeof g === "object") as HealthGoal[])
          .map((g) => ({
            id: typeof g.id === "string" ? g.id : this.genId(),
            type: String(g.type ?? ""),
            target: Number(g.target) || 0,
            period:
              g.period === "daily" ||
              g.period === "weekly" ||
              g.period === "monthly" ||
              g.period === "yearly" ||
              g.period === "total"
                ? g.period
                : "daily",
            createdAt:
              typeof g.createdAt === "string" ? g.createdAt : new Date().toISOString(),
            ...(typeof g.deadline === "string" && g.deadline ? { deadline: g.deadline } : {}),
          }))
      : [];
    return { metrics, goals };
  }

  private schedulePersist(actorId: string): void {
    this.dirty.add(actorId);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1000);
    this.persistTimer.unref?.();
  }

  private genId(): string {
    // 简单 uuid v4，避免引入额外依赖
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/** 「最新值型」指标 —— 目标达成判断看 current 是否贴近 target。 */
const LATEST_SEMANTIC_TYPES = new Set([
  "weight",
  "blood_pressure",
  "blood_glucose",
  "heart_rate_resting",
  "body_fat",
  "bmi",
]);

function periodToMs(period: HealthGoal["period"]): number {
  switch (period) {
    case "daily":
      return 86_400_000;
    case "weekly":
      return 7 * 86_400_000;
    case "monthly":
      return 30 * 86_400_000;
    case "yearly":
      return 365 * 86_400_000;
    case "total":
      return Number.POSITIVE_INFINITY;
    default:
      return 86_400_000;
  }
}
