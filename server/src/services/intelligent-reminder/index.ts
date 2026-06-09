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
  /**
   * 可选：微信主动推送回调。
   * 当用户无 WebSocket 连接时（仅使用微信），提醒将通过此通道推送。
   *
   * @param userId - 目标用户 ID
   * @param level - 提醒级别
   * @param title - 提醒标题
   * @param message - 提醒正文
   * @param options.ttsAudio - 可选的 TTS 音频数据（用于语音推送）
   */
  sendWechatProactive?: (
    userId: string,
    level: ReminderLevel,
    title: string,
    message: string,
    options?: { ttsAudio?: { format: string; base64: string } | null },
  ) => Promise<boolean>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  onContactOutcome?: (params: {
    userId: string;
    channel: ReminderLevel;
    responded: boolean;
    responseTimeMs?: number;
    feedback?: "positive" | "negative" | "neutral";
    quietHours?: boolean;
  }) => void;
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
        const userId = instance.config.metadata?.userId as string ?? "unknown";
        try {
          await popupHandler.handle(instance);
        } catch (wsErr) {
          // WS 推送失败时，尝试微信主动推送
          if (deps.sendWechatProactive) {
            const sent = await deps.sendWechatProactive(userId, "popup", instance.config.title, instance.config.message);
            if (sent) {
              deps.logger?.info?.(`[reminder] popup 已通过微信主动推送: ${instance.config.title}`);
            } else {
              deps.logger?.error?.(`[reminder] popup WS 和微信推送均失败: ${instance.config.title}`);
            }
          }
        }
        await userResponsePersistence.recordResponse({
          userId,
          instance,
          responded: false,
          responseTimeMs: 0,
        });
        deps.onContactOutcome?.({
          userId,
          channel: "popup",
          responded: false,
          quietHours: isQuietHours(),
        });
      },
      onTTSAlarmReminder: async (instance) => {
        const userId = instance.config.metadata?.userId as string ?? "unknown";
        try {
          await ttsHandler.handle(instance);
        } catch (wsErr) {
          // WS 推送失败时，尝试微信语音推送
          if (deps.sendWechatProactive && deps.virtualPhoneService) {
            // 通过 TtsService 生成音频（复用 VirtualPhoneService 内部的 TTS）
            let ttsAudio = null;
            try {
              const ttsResult = await (deps.virtualPhoneService as any).tts?.synthesizeMp3Base64?.(instance.config.message);
              if (ttsResult?.ok) {
                ttsAudio = { format: ttsResult.format, base64: ttsResult.base64 };
              }
            } catch (_) { /* TTS 生成失败则纯文本推送 */ }

            const sent = await deps.sendWechatProactive(userId, "tts_alarm", instance.config.title, instance.config.message, { ttsAudio });
            if (sent) {
              deps.logger?.info?.(`[reminder] tts_alarm 已通过微信主动推送(含${ttsAudio ? '语音' : '文本'}): ${instance.config.title}`);
            } else {
              deps.logger?.error?.(`[reminder] tts_alarm WS 和微信推送均失败: ${instance.config.title}`);
            }
          }
        }
        await userResponsePersistence.recordResponse({
          userId,
          instance,
          responded: false,
          responseTimeMs: 0,
        });
        deps.onContactOutcome?.({
          userId,
          channel: "tts_alarm",
          responded: false,
          quietHours: isQuietHours(),
        });
      },
      onPhoneCallReminder: async (instance) => {
        const userId = instance.config.metadata?.userId as string ?? "unknown";
        try {
          await phoneHandler.handle(instance);
        } catch (wsErr) {
          // WS 推送失败时，尝试微信语音来电模拟
          if (deps.sendWechatProactive && deps.virtualPhoneService) {
            // 生成前摇引导语 + 正文 的 TTS 音频
            let ttsAudio = null;
            try {
              const preGreeting = buildPreGreetingForWechat(instance);
              const fullText = `${preGreeting}\n\n${instance.config.message}`;
              const ttsResult = await (deps.virtualPhoneService as any).tts?.synthesizeMp3Base64?.(fullText);
              if (ttsResult?.ok) {
                ttsAudio = { format: ttsResult.format, base64: ttsResult.base64 };
              }
            } catch (_) { /* TTS 生成失败 */ }

            const sent = await deps.sendWechatProactive(userId, "phone_call", instance.config.title, instance.config.message, { ttsAudio });
            if (sent) {
              deps.logger?.info?.(`[reminder] phone_call 已通过微信语音推送模拟来电: ${instance.config.title}`);
            } else {
              deps.logger?.error?.(`[reminder] phone_call WS 和微信推送均失败: ${instance.config.title}`);
            }
          }
        }
        await userResponsePersistence.recordResponse({
          userId,
          instance,
          responded: false,
          responseTimeMs: 0,
        });
        deps.onContactOutcome?.({
          userId,
          channel: "phone_call",
          responded: false,
          quietHours: isQuietHours(),
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

  registerIntelligentReminderTools(deps, reminderService, userResponsePersistence);

  return {
    reminderService,
    popupHandler,
    ttsHandler,
    phoneHandler,
    userResponsePersistence,
  };
}

function registerIntelligentReminderTools(
  deps: IntelligentReminderSystemDeps,
  service: IntelligentReminderService,
  persistence: UserResponsePersistenceService,
): void {
  const registry = deps.toolRegistry;
  registry.register("reminder.create", async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);

    const title = String(input.title ?? "").trim();
    const message = String(input.message ?? "").trim();
    const priority = (String(input.priority ?? "medium").trim() as ReminderConfig["priority"]);
    const requestedInitialLevel =
      input.initialLevel == null ? null : (String(input.initialLevel).trim() as ReminderLevel);
    const maxLevel = input.maxLevel ? (String(input.maxLevel).trim() as ReminderLevel) : undefined;

    if (!title || !message) {
      return { ok: false, error: "请提供标题（title）和内容（message）" };
    }

    if (!["low", "medium", "high", "urgent"].includes(priority)) {
      return { ok: false, error: "优先级必须是 low、medium、high 或 urgent" };
    }

    if (requestedInitialLevel && !["popup", "tts_alarm", "phone_call"].includes(requestedInitialLevel)) {
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
      initialLevel: requestedInitialLevel ?? recommendedLevel,
      maxLevel,
      autoSelectInitialLevel: requestedInitialLevel == null,
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
      deps.onContactOutcome?.({
        userId: actorId,
        channel: instanceBeforeAck.currentLevel,
        responded: true,
        responseTimeMs,
        feedback: input.feedback as "positive" | "negative" | "neutral" | undefined,
        quietHours: isQuietHours(new Date()),
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

function isQuietHours(now = new Date()): boolean {
  const hour = now.getHours();
  return hour >= 23 || hour < 8;
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

/**
 * 为微信端生成电话来电的前摇引导语（TTS 语音内容）。
 * 模拟真实电话的"接通感"，让用户知道这是 Agent 的语音提醒。
 */
function buildPreGreetingForWechat(instance: { config: { title?: string; priority?: string } }): string {
  const title = instance.config.title ?? "提醒";
  const priority = instance.config.priority ?? "normal";

  const hour = new Date().getHours();
  const timeLabel = hour < 6 ? "深夜" : hour < 9 ? "早上" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 22 ? "晚上" : "夜间";

  const priorityHint =
    priority === "urgent"
      ? "紧急"
      : priority === "high"
        ? "重要"
        : "";

  return `叮铃铃——您好，我是您的 Agent。${timeLabel}有一条${priorityHint}${title}提醒，请听好。`;
}
