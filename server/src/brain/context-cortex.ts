// Agent Brain Center — ContextCortex（情境皮层 / 颞顶联合区）
//
// 职责：多源情境融合——AwarenessCortex + 时间 + 桌面 + 设备状态 + 日程。
//   像颞顶联合区（TPJ）整合多通道感知形成"当前情境"。
//
// 核心机制：
//   1. gatherContext(actorId)：并行收集多源，融合为 SituatedContext
//   2. 时间感知：时辰、星期、是否工作时段、是否深夜
//   3. 活动感知：复用 AwarenessCortex.observe（不重复实现）
//   4. 情境预测：基于时间和活动预测下一情境（如 17:30 → 即将下班）
//   5. 情境标签：active/drowsy/focused/interruptible 等
//
// 深度链接：
//   - cognize 阶段 1 并行调用 gatherContext
//   - 产出统一 SituatedContext 注入 context.situation
//   - DecisionHub 用它做路由决策（如 in_meeting 时降低主动说话频率）
//
// 设计要点：
//   - 不替代 AwarenessCortex，而是包装+扩展
//   - 不依赖外部日程服务（可选注入，未注入时跳过日程维度）
//   - 不调 LLM，纯规则融合

import type { UserActivityState } from "./types.js";

/** 桌面活动状态（可选注入） */
export interface DesktopActivityLike {
  getActiveWindow?(): { title?: string; app?: string } | null;
  getLastUserInputAt?(): string | null;
}

/** 日程服务（可选注入） */
export interface ScheduleLike {
  getUpcomingEvents?(actorId: string, limit?: number): Array<{
    title: string;
    startAt: string;
    endAt?: string;
  }>;
}

/** 设备状态（可选注入） */
export interface DeviceStateLike {
  getOnlineDevices?(actorId: string): Array<{ id: string; type: string; status: string }>;
}

/** 融合后的情境 */
export interface SituatedContext {
  actorId: string;
  /** 当前活动（来自 AwarenessCortex） */
  activity: UserActivityState | null;
  /** 时辰（0-23） */
  hour: number;
  /** 星期几（0-6，0=周日） */
  dayOfWeek: number;
  /** 是否工作时段（周一到周五 9-18） */
  isWorkHours: boolean;
  /** 是否深夜（22-次日6） */
  isLateNight: boolean;
  /** 是否清晨（5-8） */
  isEarlyMorning: boolean;
  /** 桌面活动（可选） */
  desktopActivity?: { app?: string; title?: string; idleMs?: number };
  /** 即将到来的事件（可选，最多 3 条） */
  upcomingEvents?: Array<{ title: string; startAt: string }>;
  /** 在线设备（可选） */
  onlineDevices?: Array<{ id: string; type: string; status: string }>;
  /** 情境标签 */
  tags: string[];
  /** 情境预测 */
  prediction?: string;
  /** 是否可打扰 */
  interruptible: boolean;
  /** 收集时间 */
  collectedAt: string;
}

/** AwarenessCortex 最小接口 */
export interface ContextAwarenessLike {
  observe(actorId: string): UserActivityState | null;
}

/**
 * 情境皮层。
 *
 * 多源融合形成"当前情境"——比 AwarenessCortex 更丰富的上下文。
 * 时间、活动、桌面、日程、设备全部融合为一个 SituatedContext。
 */
export class ContextCortex {
  private awareness: ContextAwarenessLike | null = null;
  private desktop: DesktopActivityLike | null = null;
  private schedule: ScheduleLike | null = null;
  private device: DeviceStateLike | null = null;

  /** 统计 */
  private gatherCount = 0;
  private readonly tagStats = new Map<string, number>();

  registerAwareness(a: ContextAwarenessLike): void {
    this.awareness = a;
  }
  registerDesktop(d: DesktopActivityLike): void {
    this.desktop = d;
  }
  registerSchedule(s: ScheduleLike): void {
    this.schedule = s;
  }
  registerDevice(d: DeviceStateLike): void {
    this.device = d;
  }

  /**
   * 收集并融合多源情境。
   *
   * 性能优化（方案 A）：接受外部已收集的 activity，避免重复调用 awareness.observe。
   */
  async gatherContext(
    actorId: string,
    alreadyCollected?: { activity?: UserActivityState | null },
  ): Promise<SituatedContext> {
    this.gatherCount++;

    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    const isWorkHours = dayOfWeek >= 1 && dayOfWeek <= 5 && hour >= 9 && hour < 18;
    const isLateNight = hour >= 22 || hour < 6;
    const isEarlyMorning = hour >= 5 && hour < 8;

    const activity =
      alreadyCollected?.activity !== undefined
        ? alreadyCollected.activity
        : this.awareness?.observe(actorId) ?? null;

    // 桌面活动（可选）
    let desktopActivity: SituatedContext["desktopActivity"];
    try {
      const win = this.desktop?.getActiveWindow?.();
      const lastInput = this.desktop?.getLastUserInputAt?.();
      const idleMs = lastInput ? Date.now() - new Date(lastInput).getTime() : undefined;
      if (win || idleMs !== undefined) {
        desktopActivity = { app: win?.app, title: win?.title, idleMs };
      }
    } catch {
      /* ignore */
    }

    // 即将事件（可选）
    let upcomingEvents: SituatedContext["upcomingEvents"];
    try {
      const events = this.schedule?.getUpcomingEvents?.(actorId, 3);
      if (events && events.length > 0) {
        upcomingEvents = events.map((e) => ({ title: e.title, startAt: e.startAt }));
      }
    } catch {
      /* ignore */
    }

    // 在线设备（可选）
    let onlineDevices: SituatedContext["onlineDevices"];
    try {
      const devices = this.device?.getOnlineDevices?.(actorId);
      if (devices && devices.length > 0) {
        onlineDevices = devices;
      }
    } catch {
      /* ignore */
    }

    // 情境标签
    const tags = this.deriveTags({
      activity: activity?.activity,
      hour,
      isWorkHours,
      isLateNight,
      isEarlyMorning,
      hasUpcomingEvents: (upcomingEvents?.length ?? 0) > 0,
      idleMs: desktopActivity?.idleMs,
    });

    // 情境预测
    const prediction = this.predict({
      hour,
      isWorkHours,
      isLateNight,
      activity: activity?.activity,
      hasUpcomingEvents: (upcomingEvents?.length ?? 0) > 0,
      nextEventStartAt: upcomingEvents?.[0]?.startAt,
    });

    // 是否可打扰
    const interruptible = this.deriveInterruptible({
      activity: activity?.activity,
      isLateNight,
      isWorkHours,
      tags,
    });

    // 更新标签统计
    for (const tag of tags) {
      this.tagStats.set(tag, (this.tagStats.get(tag) ?? 0) + 1);
    }

    return {
      actorId,
      activity,
      hour,
      dayOfWeek,
      isWorkHours,
      isLateNight,
      isEarlyMorning,
      desktopActivity,
      upcomingEvents,
      onlineDevices,
      tags,
      prediction,
      interruptible,
      collectedAt: now.toISOString(),
    };
  }

  /** 派生情境标签 */
  private deriveTags(input: {
    activity?: string;
    hour: number;
    isWorkHours: boolean;
    isLateNight: boolean;
    isEarlyMorning: boolean;
    hasUpcomingEvents: boolean;
    idleMs?: number;
  }): string[] {
    const tags: string[] = [];
    if (input.isLateNight) tags.push("late_night");
    if (input.isEarlyMorning) tags.push("early_morning");
    if (input.isWorkHours) tags.push("work_hours");
    if (input.activity === "idle") tags.push("idle");
    if (input.activity === "busy") tags.push("busy");
    if (input.activity === "sleeping") tags.push("sleeping");
    if (input.idleMs !== undefined && input.idleMs > 5 * 60_000) tags.push("away");
    if (input.hasUpcomingEvents) tags.push("has_schedule");
    if (input.hour >= 11 && input.hour < 14) tags.push("lunch_time");
    if (input.hour >= 17 && input.hour < 19) tags.push("off_work_soon");
    return tags;
  }

  /** 预测下一情境 */
  private predict(input: {
    hour: number;
    isWorkHours: boolean;
    isLateNight: boolean;
    activity?: string;
    hasUpcomingEvents: boolean;
    nextEventStartAt?: string;
  }): string | undefined {
    if (input.isLateNight && input.hour < 6) return "用户即将睡眠/已睡眠";
    if (input.hour >= 6 && input.hour < 9) return "用户即将起床/早间准备";
    if (input.hour >= 9 && input.hour < 12 && !input.isWorkHours === false) return "工作时段";
    if (input.hour >= 11 && input.hour < 13) return "即将午休";
    if (input.hour >= 17 && input.hour < 19) return "即将下班";
    if (input.hour >= 20 && input.hour < 22) return "晚间放松时段";
    if (input.hasUpcomingEvents && input.nextEventStartAt) {
      return `即将有事件：${input.nextEventStartAt}`;
    }
    return undefined;
  }

  /** 推导是否可打扰 */
  private deriveInterruptible(input: {
    activity?: string;
    isLateNight: boolean;
    isWorkHours: boolean;
    tags: string[];
  }): boolean {
    if (input.activity === "sleeping") return false;
    if (input.activity === "busy") return false;
    if (input.isLateNight) return false; // 深夜不打扰
    if (input.tags.includes("away")) return false; // 长时间不在不主动打扰
    return true;
  }

  /** 获取当前情境（同步版本，无外部调用） */
  getCurrentSituation(actorId: string): {
    hour: number;
    dayOfWeek: number;
    isWorkHours: boolean;
    isLateNight: boolean;
  } {
    const now = new Date();
    const hour = now.getHours();
    return {
      hour,
      dayOfWeek: now.getDay(),
      isWorkHours: now.getDay() >= 1 && now.getDay() <= 5 && hour >= 9 && hour < 18,
      isLateNight: hour >= 22 || hour < 6,
    };
  }

  getStats(): {
    gatherCount: number;
    topTags: Array<{ tag: string; count: number }>;
  } {
    const topTags = Array.from(this.tagStats.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return { gatherCount: this.gatherCount, topTags };
  }

  async start(): Promise<void> {
    console.log("[ContextCortex] 启动完成");
  }
  async stop(): Promise<void> {
    this.tagStats.clear();
    console.log("[ContextCortex] 已停止");
  }
}
