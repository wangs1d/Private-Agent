import { randomUUID } from "crypto";
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
}

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
    return instance;
  }

  cancelReminder(reminderId: string): boolean {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || !["pending", "active", "escalated"].includes(instance.status)) {
      return false;
    }

    this.clearEscalationTimer(reminderId);
    instance.status = "cancelled";
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
  }
}
