import { randomUUID } from "crypto";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { resolveActorId } from "../../agent/actor-id.js";
import { IntelligentReminderService } from "./intelligent-reminder-service.js";
import { PopupReminderHandler } from "./popup-reminder-handler.js";
import { TTSAlarmHandler } from "./tts-alarm-handler.js";
import { PhoneCallHandler } from "./phone-call-handler.js";
import { UserResponsePersistenceService } from "./user-response-persistence.js";
import type {
  ReminderConfig,
  ReminderLevel,
  PopupReminderConfig,
  TTSAlarmConfig,
  PhoneCallConfig,
} from "./types.js";
import type { VirtualPhoneService } from "../virtual-phone-service.js";
import type { VoiceDialogueService } from "../voice-dialogue/voice-dialogue-service.js";
import type { ToolContext } from "../../tools/tool-registry.js";

export interface IntelligentReminderSystemDeps {
  toolRegistry: ToolRegistry;
  virtualPhoneService: VirtualPhoneService;
  voiceDialogueService: VoiceDialogueService;
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export function createIntelligentReminderSystem(deps: IntelligentReminderSystemDeps) {
  const userResponsePersistence = new UserResponsePersistenceService();

  const popupHandler = new PopupReminderHandler({
    sendToClient: deps.sendToClient,
    logger: deps.logger,
  });

  const ttsHandler = new TTSAlarmHandler({
    voiceDialogueService: deps.voiceDialogueService,
    sendToClient: deps.sendToClient,
    logger: deps.logger,
  });

  const phoneHandler = new PhoneCallHandler({
    virtualPhoneService: deps.virtualPhoneService,
    voiceDialogueService: deps.voiceDialogueService,
    sendToClient: deps.sendToClient,
    logger: deps.logger,
  });

  const reminderService = new IntelligentReminderService(
    {
      onPopupReminder: async (instance) => {
        await popupHandler.handle(instance);
        await userResponsePersistence.recordResponse({
          userId: instance.config.metadata?.userId as string ?? "unknown",
          instance,
          responded: false,
          responseTimeMs: 0,
        });
      },
      onTTSAlarmReminder: async (instance) => {
        await ttsHandler.handle(instance);
        await userResponsePersistence.recordResponse({
          userId: instance.config.metadata?.userId as string ?? "unknown",
          instance,
          responded: false,
          responseTimeMs: 0,
        });
      },
      onPhoneCallReminder: async (instance) => {
        await phoneHandler.handle(instance);
        await userResponsePersistence.recordResponse({
          userId: instance.config.metadata?.userId as string ?? "unknown",
          instance,
          responded: false,
          responseTimeMs: 0,
        });
      },
      getUserResponseHistory: async (userId) => {
        return userResponsePersistence.getUserHistory(userId);
      },
      updateUserResponseHistory: async (
        userId: string,
        level: ReminderLevel,
        responseTimeMs: number,
        responded: boolean,
      ) => {
        const record = await userResponsePersistence.recordResponse({
          userId,
          instance: {} as any,
          responded,
          responseTimeMs,
        });
        return;
      },
    },
  );

  registerIntelligentReminderTools(deps.toolRegistry, reminderService, userResponsePersistence);

  return {
    reminderService,
    popupHandler,
    ttsHandler,
    phoneHandler,
    userResponsePersistence,
  };
}

function registerIntelligentReminderTools(
  registry: ToolRegistry,
  service: IntelligentReminderService,
  persistence: UserResponsePersistenceService,
): void {
  registry.register("reminder.create", async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);

    const title = String(input.title ?? "").trim();
    const message = String(input.message ?? "").trim();
    const priority = (String(input.priority ?? "medium").trim() as ReminderConfig["priority"]);
    const initialLevel = (String(input.initialLevel ?? "popup").trim() as ReminderLevel);
    const maxLevel = input.maxLevel ? (String(input.maxLevel).trim() as ReminderLevel) : undefined;

    if (!title || !message) {
      return { ok: false, error: "请提供标题（title）和内容（message）" };
    }

    if (!["low", "medium", "high", "urgent"].includes(priority)) {
      return { ok: false, error: "优先级必须是 low、medium、high 或 urgent" };
    }

    if (!["popup", "tts_alarm", "phone_call"].includes(initialLevel)) {
      return { ok: false, error: "初始级别必须是 popup、tts_alarm 或 phone_call" };
    }

    const recommendedLevel = await service.getRecommendedLevel(actorId, priority);

    let config: ReminderConfig & {
      popupConfig?: PopupReminderConfig;
      ttsConfig?: TTSAlarmConfig;
      phoneConfig?: PhoneCallConfig;
    } = {
      id: randomUUID(),
      title,
      message,
      priority,
      initialLevel: initialLevel,
      maxLevel,
      scheduledAt:
        typeof input.scheduledAt === "string" || typeof input.scheduledAt === "number"
          ? new Date(input.scheduledAt)
          : new Date(),
      metadata: {
        userId: actorId,
        actorId,
        ...(input.metadata ?? {}),
      },
    };

    if (input.popupConfig) {
      config.popupConfig = input.popupConfig as PopupReminderConfig;
    }

    if (input.ttsConfig) {
      config.ttsConfig = input.ttsConfig as TTSAlarmConfig;
    }

    if (input.phoneConfig) {
      config.phoneConfig = input.phoneConfig as PhoneCallConfig;
    }

    const instance = await service.createReminder(config);

    if (new Date(config.scheduledAt) <= new Date()) {
      await service.triggerReminder(instance.config.id);
    }

    return {
      ok: true,
      reminderId: instance.config.id,
      currentLevel: instance.currentLevel,
      status: instance.status,
      message: `已创建提醒"${title}"，当前使用${getLevelLabel(instance.currentLevel)}方式`,
    };
  });

  registry.register("reminder.trigger", async (input: Record<string, unknown>, _context: ToolContext) => {
    const reminderId = String(input.reminderId ?? "").trim();
    if (!reminderId) {
      return { ok: false, error: "请提供提醒 ID（reminderId）" };
    }

    const instance = await service.triggerReminder(reminderId);
    if (!instance) {
      return { ok: false, error: "未找到该提醒或提醒状态不允许触发" };
    }

    return {
      ok: true,
      reminderId: instance.config.id,
      currentLevel: instance.currentLevel,
      status: instance.status,
      message: `已触发提醒，使用${getLevelLabel(instance.currentLevel)}方式`,
    };
  });

  registry.register("reminder.acknowledge", async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const reminderId = String(input.reminderId ?? "").trim();

    if (!reminderId) {
      return { ok: false, error: "请提供提醒 ID（reminderId）" };
    }

    const instanceBeforeAck = service.getReminder(reminderId);
    const instance = await service.acknowledgeReminder(reminderId, actorId);
    if (!instance) {
      return { ok: false, error: "未找到该提醒或提醒状态不允许确认" };
    }

    if (instanceBeforeAck) {
      const responseTimeMs =
        instanceBeforeAck.startedAt?.getTime()
          ? Date.now() - instanceBeforeAck.startedAt.getTime()
          : 0;

      await persistence.recordResponse({
        userId: actorId,
        instance: instanceBeforeAck,
        responded: true,
        responseTimeMs,
        feedback: input.feedback as "positive" | "negative" | "neutral" | undefined,
      });
    }

    return {
      ok: true,
      reminderId: instance.config.id,
      status: instance.status,
      message: `已确认提醒"${instance.config.title}"`,
    };
  });

  registry.register("reminder.cancel", async (input: Record<string, unknown>, _context: ToolContext) => {
    const reminderId = String(input.reminderId ?? "").trim();
    if (!reminderId) {
      return { ok: false, error: "请提供提醒 ID（reminderId）" };
    }

    const success = service.cancelReminder(reminderId);
    if (!success) {
      return { ok: false, error: "无法取消该提醒（可能已完成或不存在）" };
    }

    return {
      ok: true,
      reminderId,
      message: "已取消提醒",
    };
  });

  registry.register("reminder.get_status", async (input: Record<string, unknown>, _context: ToolContext) => {
    const reminderId = String(input.reminderId ?? "").trim();
    if (!reminderId) {
      return { ok: false, error: "请提供提醒 ID（reminderId）" };
    }

    const instance = service.getReminder(reminderId);
    if (!instance) {
      return { ok: false, error: "未找到该提醒" };
    }

    return {
      ok: true,
      reminder: {
        id: instance.config.id,
        title: instance.config.title,
        status: instance.status,
        currentLevel: instance.currentLevel,
        escalationCount: instance.escalationCount,
        createdAt: instance.createdAt,
        startedAt: instance.startedAt,
        acknowledgedAt: instance.acknowledgedAt,
      },
    };
  });

  registry.register("reminder.list_active", async (_input: Record<string, unknown>, _context: ToolContext) => {
    const activeReminders = service.getActiveReminders();

    return {
      ok: true,
      count: activeReminders.length,
      reminders: activeReminders.map((r) => ({
        id: r.config.id,
        title: r.config.title,
        status: r.status,
        currentLevel: r.currentLevel,
        priority: r.config.priority,
      })),
    };
  });

  registry.register("reminder.escalate", async (input: Record<string, unknown>, _context: ToolContext) => {
    const reminderId = String(input.reminderId ?? "").trim();
    const reason = String(input.reason ?? "手动升级").trim();

    if (!reminderId) {
      return { ok: false, error: "请提供提醒 ID（reminderId）" };
    }

    const instance = await service.escalateReminder(reminderId, reason);
    if (!instance) {
      return { ok: false, error: "无法升级该提醒" };
    }

    return {
      ok: true,
      reminderId: instance.config.id,
      previousLevel:
        instance.escalationHistory[instance.escalationHistory.length - 1]?.fromLevel,
      newLevel: instance.currentLevel,
      escalationCount: instance.escalationCount,
      message: `已从${getLevelLabel(instance.escalationHistory[instance.escalationHistory.length - 1]?.fromLevel ?? instance.currentLevel)}升级到${getLevelLabel(instance.currentLevel)}`,
    };
  });

  registry.register("reminder.get_user_stats", async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const analytics = await persistence.getUserAnalytics(actorId);

    if (!analytics) {
      return {
        ok: true,
        exists: false,
        message: "该用户暂无响应数据",
      };
    }

    return {
      ok: true,
      exists: true,
      analytics: {
        totalReminders: analytics.totalReminders,
        totalResponses: analytics.totalResponses,
        responseRate: Math.round(analytics.responseRate * 100) / 100,
        averageResponseTimeMs: Math.round(analytics.averageResponseTimeMs),
        ignoreRate: Math.round(analytics.ignoreRate * 100) / 100,
        preferredLevel: analytics.preferredLevel,
        lastResponseAt: analytics.lastResponseAt,
        levelDistribution: analytics.levelDistribution,
      },
    };
  });

  registry.register("reminder.get_response_history", async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const limit = Number(input.limit ?? 20);

    const recentResponses = persistence.getRecentResponses(actorId, limit);

    return {
      ok: true,
      count: recentResponses.length,
      responses: recentResponses.map((r) => ({
        id: r.id,
        reminderTitle: r.reminderTitle,
        level: r.level,
        priority: r.priority,
        triggeredAt: r.triggeredAt,
        respondedAt: r.respondedAt,
        responseTimeMs: r.responseTimeMs,
        responded: r.responded,
        escalationCount: r.escalationCount,
        finalLevel: r.finalLevel,
        userFeedback: r.userFeedback,
      })),
    };
  });
}

function getLevelLabel(level: ReminderLevel): string {
  switch (level) {
    case "popup":
      return "弹窗文字";
    case "tts_alarm":
      return "闹钟TTS语音";
    case "phone_call":
      return "电话呼叫";
    default:
      return level;
  }
}
