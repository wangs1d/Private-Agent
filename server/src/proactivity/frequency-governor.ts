// ProactivityHub —— 全局频控器（FrequencyGovernor）
//
// 职责：主动性多元化后防止"频繁打扰"。三层规则：
//  1. 每 actor 每日总预算（默认 6 次，env 可调）
//  2. 分 kind 冷却（greeting/分享每天最多 1 次，关怀 8h 一次……）
//  3. 静默时段（23-7 点）：仅 importance=high 放行
//
// 与 ProactionCortex 的 disturb/repeat_suppress 是双层防线：本模块前置粗筛
// （触发源层），ProactionCortex 保留细筛（决策层），二者不冲突。
import type { FrequencyVerdict } from "./proactivity-types.js";

/** 分 kind 冷却毫秒表（env PROACTIVITY_COOLDOWN_<KIND> 可覆盖单值） */
const DEFAULT_KIND_COOLDOWN_MS: Record<string, number> = {
  greeting: 24 * 60 * 60 * 1000,        // 问候：每天最多 1 次
  interest_share: 24 * 60 * 60 * 1000,  // 分享：每天最多 1 次
  interest_alert: 4 * 60 * 60 * 1000,   // 兴趣热议推送：4h 冷却（同兴趣级去重由 InterestWatcher 指纹+间隔承担）
  care: 8 * 60 * 60 * 1000,             // 对话关怀：8h 冷却
  followup: 4 * 60 * 60 * 1000,         // 待办跟进：4h 冷却
  task_celebration: 30 * 60 * 1000,     // 恭喜：每任务一次（30min 防连发）
  overwork_care: 8 * 60 * 60 * 1000,    // 过劳干预：8h 冷却
  // ── C 端生活管家场景（Task 20 统一频控注册）──
  weather_alert: 30 * 60 * 1000,        // 恶劣天气预警：预警类需即时触达，30min 冷却防同一场雨连发
  life_reminder: 4 * 60 * 60 * 1000,    // 生活提醒（重要日子/预算超支/节律提醒等）：4h 冷却
  monthly_report: 24 * 60 * 60 * 1000,  // 月度报告（消费月报等）：每日最多 1 次
};

/**
 * 未知 kind（InitiativeEngine LLM 自定义标签，如 schedule_care）的默认冷却。
 * 每日总预算仍是最终兜底——即使 LLM 每次发明新标签也不会超预算打扰。
 */
const DEFAULT_UNKNOWN_KIND_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/** 静默时段（对齐 ProactiveContactPolicy quietHours 语义）：23:00-7:00 */
const QUIET_HOUR_START = 23;
const QUIET_HOUR_END = 7;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 当前日期的本地 YYYY-MM-DD（按 actor 逐日计数用） */
function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isQuietHour(hour: number): boolean {
  // 23 < 7（跨午夜区间）：恒走下半分支
  return hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END;
}

type ActorFrequencyState = {
  dateKey: string;
  dailyCount: number;
  /** kind → 最近一次触发时间戳 */
  kindLastAt: Map<string, number>;
};

export class FrequencyGovernor {
  private readonly actors = new Map<string, ActorFrequencyState>();

  private readonly dailyBudget: number;
  private readonly kindCooldownMs: Record<string, number>;
  private readonly disableQuietHours: boolean;

  constructor(opts?: {
    dailyBudget?: number;
    kindCooldownMs?: Record<string, number>;
    /** 测试用：不读 env */
    ignoreEnv?: boolean;
    /** 测试用：禁用静默时段（避免深夜跑测试随机失败） */
    disableQuietHours?: boolean;
  }) {
    this.disableQuietHours = opts?.disableQuietHours === true;
    this.dailyBudget = opts?.dailyBudget ?? readEnvInt("PROACTIVITY_DAILY_BUDGET", 6);
    this.kindCooldownMs = { ...DEFAULT_KIND_COOLDOWN_MS };
    for (const [kind, ms] of Object.entries(opts?.kindCooldownMs ?? {})) {
      if (typeof ms === "number" && Number.isFinite(ms)) {
        this.kindCooldownMs[kind] = ms;
      }
    }
    if (!opts?.ignoreEnv) {
      // env 覆盖单 kind 冷却：PROACTIVITY_COOLDOWN_CARE=3600000
      for (const kind of Object.keys(this.kindCooldownMs)) {
        const envName = `PROACTIVITY_COOLDOWN_${kind.toUpperCase()}`;
        this.kindCooldownMs[kind] = readEnvInt(envName, this.kindCooldownMs[kind]);
      }
    }
  }

  private stateOf(actorId: string, now: Date): ActorFrequencyState {
    const dateKey = localDateKey(now);
    let state = this.actors.get(actorId);
    if (!state || state.dateKey !== dateKey) {
      // 新的一天：重置每日计数（kind 冷却跨天保留，避免跨零点连发）
      state = {
        dateKey,
        dailyCount: 0,
        kindLastAt: state?.kindLastAt ?? new Map(),
      };
      this.actors.set(actorId, state);
    }
    return state;
  }

  /**
   * 判定一次主动意图是否允许触发。
   * @param kind 已知 kind 用专属冷却；LLM 自定义标签用默认冷却（预算兜底）
   * @param importance 静默时段仅 high 放行
   */
  canTrigger(
    actorId: string,
    kind: string,
    importance: "high" | "medium" | "low",
    now: Date = new Date(),
  ): FrequencyVerdict {
    const state = this.stateOf(actorId, now);

    // 规则 3：静默时段仅 high 放行
    if (!this.disableQuietHours && isQuietHour(now.getHours()) && importance !== "high") {
      return { allowed: false, reason: `quiet_hours(${now.getHours()}h,importance=${importance})` };
    }

    // 规则 1：每日总预算
    if (state.dailyCount >= this.dailyBudget) {
      return { allowed: false, reason: `daily_budget_exhausted(${state.dailyCount}/${this.dailyBudget})` };
    }

    // 规则 2：分 kind 冷却（未知 kind 用默认冷却，防新标签绕过）
    const lastAt = state.kindLastAt.get(kind);
    if (lastAt !== undefined) {
      const elapsed = now.getTime() - lastAt;
      const cooldown = this.kindCooldownMs[kind] ?? DEFAULT_UNKNOWN_KIND_COOLDOWN_MS;
      if (elapsed < cooldown) {
        return {
          allowed: false,
          reason: `kind_cooldown(${kind},${Math.round(elapsed / 60000)}m<${Math.round(cooldown / 60000)}m)`,
        };
      }
    }

    return { allowed: true, reason: "ok" };
  }

  /** 记录一次已放行的触发（进入计数与冷却） */
  record(actorId: string, kind: string, now: Date = new Date()): void {
    const state = this.stateOf(actorId, now);
    state.dailyCount += 1;
    state.kindLastAt.set(kind, now.getTime());
  }

  /** 测试/诊断：当日已用预算 */
  dailyCountOf(actorId: string, now: Date = new Date()): number {
    return this.stateOf(actorId, now).dailyCount;
  }

  /** 每日总预算（诊断/日志用） */
  getBudget(): number {
    return this.dailyBudget;
  }
}
