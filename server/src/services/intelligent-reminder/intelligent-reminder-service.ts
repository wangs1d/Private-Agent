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
    timeoutMs: 30_000,
  },
  {
    fromLevel: "tts_alarm",
    toLevel: "phone_call",
    triggerCondition: "timeout",
    timeoutMs: 60_000,
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
      return this.getDefaultLevelForPriority(priority);
    }

    const history = await this.deps.getUserResponseHistory(userId);
    if (!history) {
      return this.getDefaultLevelForPriority(priority);
    }

    const ignoreRate = history.totalReminders > 0 ? history.ignoredCount / history.totalReminders : 0;
    const avgResponseTimeMin = history.averageResponseTimeMs / 1000 / 60;
    const phoneStats = history.levelStats.phone_call;
    const ttsStats = history.levelStats.tts_alarm;
    const popupStats = history.levelStats.popup;
    const phoneResponseRate = phoneStats.shown > 0 ? phoneStats.responded / phoneStats.shown : 0;
    const ttsResponseRate = ttsStats.shown > 0 ? ttsStats.responded / ttsStats.shown : 0;
    const popupResponseRate = popupStats.shown > 0 ? popupStats.responded / popupStats.shown : 0;

    if (
      priority === "urgent" ||
      (ignoreRate > 0.5 && phoneResponseRate >= 0.35) ||
      (avgResponseTimeMin > 10 && phoneResponseRate > ttsResponseRate)
    ) {
      return "phone_call";
    }

    if (
      priority === "high" ||
      ignoreRate > 0.3 ||
      avgResponseTimeMin > 5 ||
      (ttsResponseRate >= popupResponseRate + 0.12 && ttsStats.shown >= 3)
    ) {
      return "tts_alarm";
    }

    return history.preferredLevel || "popup";
  }

  private getDefaultLevelForPriority(priority: ReminderConfig["priority"]): ReminderLevel {
    switch (priority) {
      case "urgent":
        return "phone_call";
      case "high":
        return "tts_alarm";
      default:
        return "popup";
    }
  }

  private buildAdaptiveEscalationRules(
    priority: ReminderConfig["priority"],
    history: UserResponseHistory | null,
  ): ReminderEscalationRule[] {
    const hour = new Date().getHours();
    const quietHours = hour >= 23 || hour < 8;
    const popupTimeoutMs =
      priority === "urgent"
        ? 20_000
        : priority === "high"
          ? 90_000
          : priority === "medium"
            ? 4 * 60_000
            : 8 * 60_000;
    const ttsTimeoutMs =
      priority === "urgent"
        ? 60_000
        : priority === "high"
          ? 4 * 60_000
          : priority === "medium"
            ? 8 * 60_000
            : 12 * 60_000;

    const prefersPhone = history?.preferredLevel === "phone_call";
    const prefersTts = history?.preferredLevel === "tts_alarm";
    const ignoreRate =
      history && history.totalReminders > 0 ? history.ignoredCount / history.totalReminders : 0;

    const rules: ReminderEscalationRule[] = [];
    rules.push({
      fromLevel: "popup",
      toLevel: "tts_alarm",
      triggerCondition: "timeout",
      timeoutMs: prefersTts ? Math.round(popupTimeoutMs * 0.75) : popupTimeoutMs,
    });

    const shouldCall =
      priority === "urgent" ||
      (!quietHours && priority === "high") ||
      prefersPhone ||
      ignoreRate >= 0.45;
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
