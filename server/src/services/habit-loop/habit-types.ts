/**
 * 习惯学习 → 自动执行闭环 —— 类型定义。
 *
 * 闭环链路：
 *   行为观察（位置历史 / 工具调用事件）→ HabitMiner 挖掘候选习惯
 *   → 规则落库（默认 auto 授权）→ 触发器命中 → 直接执行
 *   → 执行结果反馈回灌 confidence（成功升 / 失败降，连续失败自动降权
 *   回 confirm_each）→ 用户确认成功 N 次后建议升级 auto 授权
 *
 * 安全边界：
 *   - auto 授权直接执行、不做置信度门槛（产品口径：习惯无需用户确认）
 *   - 金融类工具由 AgentTaskSafety / 预订层两阶段确认兜底，本层不绕过
 *   - quietHours 内静默跳过（不打扰、不提案）
 */

/** 授权级别：auto = 直接执行（默认）；confirm_each = 每次先确认（失败降权 / 显式指定）。 */
export type HabitAuthorization = "confirm_each" | "auto";

/** 触发器（kind 决定字段）。 */
export type HabitTrigger =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] }
  | { kind: "once"; atIso: string }
  | {
      kind: "location_enter";
      placeLabel: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
    }
  | {
      kind: "tool_pattern";
      toolName: string;
      /** 可选时间约束：仅统计该小时（0-23）/ 星期（0=周日）发生的使用 */
      hour?: number;
      weekday?: number;
      windowDays?: number;
      minCount?: number;
    };

/** 动作（kind 决定字段）。 */
export type HabitAction =
  | { kind: "tool"; tool: string; input: Record<string, unknown> }
  | { kind: "agent_task"; instruction: string }
  | { kind: "message"; text: string };

export interface HabitStats {
  runCount: number;
  successCount: number;
  failCount: number;
  consecutiveFails: number;
  confirmedCount: number;
  lastRunAt?: string;
  lastStatus?: "success" | "failed" | "proposed" | "confirmed";
}

export interface HabitRule {
  id: string;
  actorId: string;
  name: string;
  description?: string;
  source: "manual" | "mined";
  trigger: HabitTrigger;
  action: HabitAction;
  authorization: HabitAuthorization;
  /** 0..1：执行结果反馈回灌；auto 授权的门槛 */
  confidence: number;
  enabled: boolean;
  /** 同一规则两次触发之间的最小间隔（分钟） */
  cooldownMinutes: number;
  /** 安静时段（HH:mm-HH:mm，跨零点支持）：命中时只提案不自动执行 */
  quietHours?: { start: string; end: string };
  createdAt: string;
  updatedAt: string;
  stats: HabitStats;
  /** 已向用户建议过升级 auto（一次性建议标记） */
  autoSuggested?: boolean;
}

/** 挖掘用位置观察（与 location-history 的 LocationSample 解耦的最小面）。 */
export interface HabitLocationSample {
  at: number;
  latitude: number;
  longitude: number;
  label?: string;
}

/** 工具调用观察（HookBus tool.executed 订阅写入）。 */
export interface HabitToolObservation {
  actorId: string;
  tool: string;
  at: number;
}

/** 挖掘出的候选习惯（工具面展示 + 一键建规则）。 */
export interface HabitCandidate {
  name: string;
  description: string;
  trigger: HabitTrigger;
  action?: HabitAction;
  confidence: number;
  evidence: string[];
}
