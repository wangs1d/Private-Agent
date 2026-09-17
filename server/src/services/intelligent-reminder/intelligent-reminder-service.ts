import { randomUUID } from "crypto";
import { readJson, writeJson } from "../../proactivity/persist-file.js";
import type {
  ReminderConfig,
  ReminderInstance,
  ReminderLevel,
  ReminderStatus,
  ReminderEscalationRule,
  UserResponseHistory,
  PopupReminderConfig,
  TTSAlarmConfig,
  PhoneCallConfig,
} from "./types.js";

const LEVEL_ORDER: Record<ReminderLevel, number> = {
  popup: 1,
  tts_alarm: 2,
  phone_call: 3,
};

const DEFAULT_ESCALATION_RULES: ReminderEscalationRule[] = [
  {
    fromLevel: "popup",
    toLevel: "tts_alarm",
    triggerCondition: "timeout",
    timeoutMs: 10 * 60_000, // 默认 10 分钟后升级到 TTS
  },
  {
    fromLevel: "tts_alarm",
    toLevel: "phone_call",
    triggerCondition: "timeout",
    timeoutMs: 12 * 60_000, // 默认 12 分钟后升级到电话（仅用户偏好电话时生效）
  },
];

export interface IntelligentReminderDeps {
  onPopupReminder: (instance: ReminderInstance) => Promise<void>;
  onTTSAlarmReminder: (instance: ReminderInstance) => Promise<void>;
  onPhoneCallReminder: (instance: ReminderInstance) => Promise<void>;
  getUserResponseHistory?: (userId: string) => Promise<UserResponseHistory | null>;
  updateUserResponseHistory?: (
    userId: string,
    level: ReminderLevel,
    responseTimeMs: number,
    responded: boolean,
  ) => Promise<void>;
  /**
   * 提醒实例 + 升级计时器持久化文件路径。缺省 = 纯内存（单测保持轻量）。
   * 背景：此前 activeReminders/escalationTimers 全在内存，服务重启整条升级链
   * 静默蒸发——用户以为会升级的电话提醒，重启后无人再管。
   */
  persistPath?: string;
}

const ACTIVE_STATUSES: ReminderStatus[] = ["pending", "active", "escalated", "delivered"];

export class IntelligentReminderService {
  private activeReminders = new Map<string, ReminderInstance>();
  private escalationTimers = new Map<string, NodeJS.Timeout>();
  private deps: IntelligentReminderDeps;
  private customEscalationRules: ReminderEscalationRule[];

  constructor(
    deps: IntelligentReminderDeps,
    escalationRules?: ReminderEscalationRule[],
  ) {
    this.deps = deps;
    this.customEscalationRules = escalationRules ?? DEFAULT_ESCALATION_RULES;
  }

  getEscalationRules(): ReminderEscalationRule[] {
    return this.customEscalationRules;
  }

  setEscalationRules(rules: ReminderEscalationRule[]): void {
    this.customEscalationRules = rules;
  }

  async createReminder(
    config: ReminderConfig & {
      popupConfig?: PopupReminderConfig;
      ttsConfig?: TTSAlarmConfig;
      phoneConfig?: PhoneCallConfig;
    },
  ): Promise<ReminderInstance> {
    const userId = typeof config.metadata?.userId === "string" ? config.metadata.userId : null;
    const history =
      userId && this.deps.getUserResponseHistory
        ? await this.deps.getUserResponseHistory(userId)
        : null;
    const initialLevel =
      config.autoSelectInitialLevel && userId
        ? await this.getRecommendedLevel(userId, config.priority)
        : config.initialLevel;
    const escalationRules =
      config.escalationRules && config.escalationRules.length > 0
        ? config.escalationRules
        : this.buildAdaptiveEscalationRules(config.priority, history);

    const instance: ReminderInstance = {
      config: {
        ...config,
        initialLevel,
        escalationRules,
      },
      currentLevel: initialLevel,
      status: "pending",
      createdAt: new Date(),
      escalationCount: 0,
      escalationHistory: [],
      popupConfig: config.popupConfig,
      ttsConfig: config.ttsConfig,
      phoneConfig: config.phoneConfig,
    };

    this.activeReminders.set(config.id, instance);
    this.persist();
    return instance;
  }

  async triggerReminder(reminderId: string): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || instance.status !== "pending") {
      return null;
    }

    instance.status = "active";
    instance.startedAt = new Date();

    await this.executeCurrentLevel(instance);

    this.scheduleEscalation(instance);
    this.persist();

    return instance;
  }

  private async executeCurrentLevel(instance: ReminderInstance): Promise<void> {
    switch (instance.currentLevel) {
      case "popup":
        await this.deps.onPopupReminder(instance);
        break;
      case "tts_alarm":
        await this.deps.onTTSAlarmReminder(instance);
        break;
      case "phone_call":
        await this.deps.onPhoneCallReminder(instance);
        break;
    }
  }

  private scheduleEscalation(instance: ReminderInstance): void {
    const rule = this.findNextEscalationRule(
      instance.currentLevel,
      instance.config.escalationRules,
    );
    if (!rule) {
      return;
    }

    const timer = setTimeout(async () => {
      if (instance.status !== "active") {
        return;
      }

      await this.escalateReminder(instance.config.id, `Timeout after ${rule.timeoutMs}ms`);
    }, rule.timeoutMs);
    // 不持有事件循环：升级链不该阻止进程自然退出（单测/停机都不被残留计时器挂住）
    timer.unref?.();

    this.escalationTimers.set(instance.config.id, timer);
  }

  private findNextEscalationRule(
    currentLevel: ReminderLevel,
    rules?: ReminderEscalationRule[],
  ): ReminderEscalationRule | null {
    return (rules ?? this.customEscalationRules).find((r) => r.fromLevel === currentLevel) ?? null;
  }

  async escalateReminder(reminderId: string, reason: string): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || instance.status !== "active") {
      return null;
    }

    const rule = this.findNextEscalationRule(instance.currentLevel, instance.config.escalationRules);
    if (!rule) {
      return null;
    }

    if (instance.config.maxLevel && LEVEL_ORDER[rule.toLevel] > LEVEL_ORDER[instance.config.maxLevel]) {
      return null;
    }

    if (rule.maxEscalations && instance.escalationCount >= rule.maxEscalations) {
      return instance;
    }

    this.clearEscalationTimer(reminderId);

    const previousLevel = instance.currentLevel;
    instance.currentLevel = rule.toLevel;
    instance.status = "escalated";
    instance.escalationCount += 1;
    instance.escalationHistory.push({
      fromLevel: previousLevel,
      toLevel: rule.toLevel,
      triggeredAt: new Date(),
      reason,
    });

    instance.status = "active";
    await this.executeCurrentLevel(instance);
    this.scheduleEscalation(instance);
    this.persist();

    return instance;
  }

  async acknowledgeReminder(
    reminderId: string,
    userId: string,
  ): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || !["active", "escalated", "delivered"].includes(instance.status)) {
      return null;
    }

    this.clearEscalationTimer(reminderId);

    const responseTimeMs =
      instance.startedAt?.getTime()
        ? Date.now() - instance.startedAt.getTime()
        : 0;

    instance.status = "acknowledged";
    instance.acknowledgedAt = new Date();
    this.persist();

    if (this.deps.updateUserResponseHistory) {
      await this.deps.updateUserResponseHistory(
        userId,
        instance.currentLevel,
        responseTimeMs,
        true,
      );
    }

    return instance;
  }

  async markDelivered(reminderId: string): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance) {
      return null;
    }

    instance.status = "delivered";
    instance.deliveredAt = new Date();
    this.persist();
    return instance;
  }

  cancelReminder(reminderId: string): boolean {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || !["pending", "active", "escalated"].includes(instance.status)) {
      return false;
    }

    this.clearEscalationTimer(reminderId);
    instance.status = "cancelled";
    this.persist();
    return true;
  }

  getReminder(reminderId: string): ReminderInstance | undefined {
    return this.activeReminders.get(reminderId);
  }

  getActiveReminders(): ReminderInstance[] {
    return Array.from(this.activeReminders.values()).filter((r) =>
      ["pending", "active", "escalated", "delivered"].includes(r.status),
    );
  }

  private clearEscalationTimer(reminderId: string): void {
    const timer = this.escalationTimers.get(reminderId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(reminderId);
    }
  }

  async getRecommendedLevel(
    userId: string,
    priority: ReminderConfig["priority"],
  ): Promise<ReminderLevel> {
    if (!this.deps.getUserResponseHistory) {
      return "popup";
    }

    const history = await this.deps.getUserResponseHistory(userId);
    if (!history) {
      return "popup";
    }

    // 仅当用户明确偏好电话且优先级为 urgent 时，才推荐 phone_call
    const prefersPhone = history.preferredLevel === "phone_call";
    if (prefersPhone && priority === "urgent") {
      return "phone_call";
    }
    // 用户明确偏好 TTS 且优先级较高时，才推荐 tts_alarm
    const prefersTts = history.preferredLevel === "tts_alarm";
    if (prefersTts && (priority === "urgent" || priority === "high")) {
      return "tts_alarm";
    }

    // 默认始终使用弹窗方式
    return "popup";
  }

  private getDefaultLevelForPriority(_priority: ReminderConfig["priority"]): ReminderLevel {
    // 所有优先级默认都使用弹窗，不再根据优先级直接跳到 TTS 或电话
    return "popup";
  }

  private buildAdaptiveEscalationRules(
    priority: ReminderConfig["priority"],
    history: UserResponseHistory | null,
  ): ReminderEscalationRule[] {
    const hour = new Date().getHours();
    const quietHours = hour >= 23 || hour < 8;

    // popup → tts_alarm 的超时：给用户足够时间响应（分钟级而非秒级）
    const popupTimeoutMs =
      priority === "urgent"
        ? 2 * 60_000       // urgent: 2 分钟
        : priority === "high"
          ? 5 * 60_000     // high: 5 分钟
          : priority === "medium"
            ? 10 * 60_000   // medium: 10 分钟
            : 15 * 60_000;  // low: 15 分钟

    // tts_alarm → phone_call 的超时
    const ttsTimeoutMs =
      priority === "urgent"
        ? 3 * 60_000       // urgent: 3 分钟
        : priority === "high"
          ? 6 * 60_000     // high: 6 分钟
          : 12 * 60_000;   // medium/low: 12 分钟

    const prefersPhone = history?.preferredLevel === "phone_call";
    const prefersTts = history?.preferredLevel === "tts_alarm";

    const rules: ReminderEscalationRule[] = [];

    // popup → tts_alarm：始终允许升级（用户长时间不响应时）
    rules.push({
      fromLevel: "popup",
      toLevel: "tts_alarm",
      triggerCondition: "timeout",
      timeoutMs: prefersTts ? Math.round(popupTimeoutMs * 0.75) : popupTimeoutMs,
    });

    // tts_alarm → phone_call：仅以下情况才升级
    // 1. 用户明确偏好电话方式
    // 2. 且优先级为 urgent 或（非安静时段 + high）
    // 不再根据忽略率等统计自动升级到电话
    const shouldCall =
      prefersPhone &&
      (priority === "urgent" || (!quietHours && priority === "high"));
    if (shouldCall) {
      rules.push({
        fromLevel: "tts_alarm",
        toLevel: "phone_call",
        triggerCondition: "timeout",
        timeoutMs: prefersPhone ? Math.round(ttsTimeoutMs * 0.75) : ttsTimeoutMs,
      });
    }

    return rules;
  }

  cleanup(): void {
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
    this.activeReminders.clear();
    this.persist();
  }

  /** 把活跃实例（含升级状态）落盘。写失败静默（内存态仍可用，与 persist-file 约定一致）。 */
  private persist(): void {
    if (!this.deps.persistPath) return;
    const instances = [...this.activeReminders.values()].filter((r) =>
      ACTIVE_STATUSES.includes(r.status),
    );
    writeJson(this.deps.persistPath, {
      version: 1,
      savedAt: new Date().toISOString(),
      instances: instances.map(serializeInstance),
    });
  }

  /**
   * 重启恢复：回填活跃实例，并对 active/escalated 的实例重排升级计时。
   * 原定升级时刻已过的 → 立即补升级（错过语义：宁可迟到，不让 critical 链静默蒸发）。
   * 返回恢复的实例数。
   */
  async load(): Promise<number> {
    if (!this.deps.persistPath) return 0;
    const raw = readJson<{ version?: number; instances?: Array<Record<string, unknown>> }>(
      this.deps.persistPath,
      {},
    );
    const restored: ReminderInstance[] = [];
    for (const item of raw.instances ?? []) {
      try {
        const inst = reviveInstance(item);
        if (ACTIVE_STATUSES.includes(inst.status) && !this.activeReminders.has(inst.config.id)) {
          this.activeReminders.set(inst.config.id, inst);
          restored.push(inst);
        }
      } catch {
        /* 单条损坏跳过，不影响其余恢复 */
      }
    }

    for (const inst of restored.filter((r) => r.status === "active" || r.status === "escalated")) {
      const rule = this.findNextEscalationRule(inst.currentLevel, inst.config.escalationRules);
      if (!rule) continue;
      const anchor =
        inst.escalationHistory[inst.escalationHistory.length - 1]?.triggeredAt ??
        inst.startedAt ??
        inst.createdAt;
      const remaining = anchor.getTime() + rule.timeoutMs - Date.now();
      if (remaining <= 0) {
        await this.escalateReminder(inst.config.id, "服务重启后错过升级时刻，立即补升级");
      } else {
        const timer = setTimeout(() => {
          void this.escalateReminder(inst.config.id, "重启恢复的升级计时器到点");
        }, remaining);
        timer.unref?.();
        this.escalationTimers.set(inst.config.id, timer);
      }
    }

    this.persist();
    return restored.length;
  }
}

// ─── 持久化序列化：Date ↔ ISO 字符串（JSON.stringify 天然把 Date 变 ISO，恢复时定点复活）───

function serializeInstance(instance: ReminderInstance): Record<string, unknown> {
  return JSON.parse(JSON.stringify(instance)) as Record<string, unknown>;
}

function reviveInstance(raw: Record<string, unknown>): ReminderInstance {
  const toDate = (v: unknown): Date | undefined => {
    const d = typeof v === "string" ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  const config = raw.config as Record<string, unknown> | undefined;
  if (!config || typeof raw.status !== "string" || typeof config.id !== "string") {
    throw new Error("malformed reminder instance");
  }
  const history = Array.isArray(raw.escalationHistory) ? raw.escalationHistory : [];
  return {
    config: {
      ...(config as unknown as ReminderConfig),
      scheduledAt: toDate(config.scheduledAt) ?? new Date(),
    },
    currentLevel: raw.currentLevel as ReminderLevel,
    status: raw.status as ReminderStatus,
    createdAt: toDate(raw.createdAt) ?? new Date(),
    startedAt: toDate(raw.startedAt),
    deliveredAt: toDate(raw.deliveredAt),
    acknowledgedAt: toDate(raw.acknowledgedAt),
    escalationCount: typeof raw.escalationCount === "number" ? raw.escalationCount : 0,
    escalationHistory: history.map((h) => {
      const entry = h as { fromLevel: ReminderLevel; toLevel: ReminderLevel; triggeredAt: unknown; reason?: string };
      return {
        fromLevel: entry.fromLevel,
        toLevel: entry.toLevel,
        triggeredAt: toDate(entry.triggeredAt) ?? new Date(),
        reason: entry.reason ?? "",
      };
    }),
    popupConfig: raw.popupConfig as PopupReminderConfig | undefined,
    ttsConfig: raw.ttsConfig as TTSAlarmConfig | undefined,
    phoneConfig: raw.phoneConfig as PhoneCallConfig | undefined,
  };
}
