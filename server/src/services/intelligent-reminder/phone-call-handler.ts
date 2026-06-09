import type { ReminderInstance, PhoneCallConfig } from "./types.js";
import type { VirtualPhoneService } from "../virtual-phone-service.js";
import type { VoiceDialogueService } from "../voice-dialogue/voice-dialogue-service.js";
import type { DialogueContext } from "../voice-dialogue/types.js";

export interface PhoneCallHandlerDeps {
  virtualPhoneService: VirtualPhoneService;
  voiceDialogueService: VoiceDialogueService;
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export class PhoneCallHandler {
  private deps: PhoneCallHandlerDeps;
  private activeCalls = new Map<string, {
    callId: string;
    isActive: boolean;
    retryCount: number;
    disconnectCommands: string[];
    dialogueContext: DialogueContext;
  }>();

  constructor(deps: PhoneCallHandlerDeps) {
    this.deps = deps;
  }

  async handle(instance: ReminderInstance): Promise<void> {
    const config = instance.phoneConfig ?? {};
    const userId = instance.config.metadata?.userId as string | undefined;
    const actorId = instance.config.metadata?.actorId as string | undefined;

    if (!userId) {
      this.deps.logger?.error("Phone call reminder missing userId in metadata");
      return;
    }

    const disconnectCommands = config.disconnectCommand ?? ["退下", "知道了", "收到", "挂断"];
    // 不重试：定时提醒只打一次，失败就发通知让用户看消息
    const maxRetries = 0;

    let retryCount = 0;
    let callSuccessful = false;

    while (retryCount <= maxRetries && !callSuccessful) {
      try {
        callSuccessful = await this.executePhoneCall(
          instance,
          userId,
          actorId,
          config,
          disconnectCommands,
        );
      } catch (error) {
        this.deps.logger?.error(`Phone call attempt ${retryCount + 1} failed: ${error}`);
      }

      if (!callSuccessful && retryCount < maxRetries) {
        retryCount++;
        this.deps.logger?.info(`Retrying phone call... Attempt ${retryCount + 1}/${maxRetries}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    if (!callSuccessful) {
      this.deps.logger?.error(`All phone call attempts failed for reminder: ${instance.config.id}`);
      await this.sendCallFailedNotification(userId, instance);
    }
  }

  private async executePhoneCall(
    instance: ReminderInstance,
    userId: string,
    actorId: string | undefined,
    config: PhoneCallConfig,
    disconnectCommands: string[],
  ): Promise<boolean> {
    await this.sendIncomingCallNotification(userId, instance);

    let callResult;
    if (actorId) {
      /** 前摇引导语：振铃阶段让用户知道这是提醒来电 */
      const preGreeting = this.buildPreGreeting(instance);
      const fullTranscript = `${preGreeting}\n\n${instance.config.message}`;

      callResult = await this.deps.virtualPhoneService.callUserWithRinging({
        fromActorId: actorId,
        toUserId: userId,
        transcript: fullTranscript,
        ringStyle: "reminder",
        ringPhase: {
          enableRingingPhase: true,
          ringDurationMs: config.ringDurationMs ?? 8_000,
        },
      });
    } else {
      return false;
    }

    if (!callResult.ok || !callResult.callId) {
      return false;
    }

    const dialogueContext: DialogueContext = {
      sessionId: instance.config.id,
      userId,
      conversationHistory: [
        {
          role: "system",
          content: `你是一个提醒助手。当前任务：向用户传达提醒信息"${instance.config.message}"。用户可能会回应，你需要确认他们已理解。当用户说"退下"、"知道了"、"收到"等确认词语时，礼貌地结束对话。`,
        },
      ],
      metadata: {
        reminderId: instance.config.id,
        reminderTitle: instance.config.title,
      },
    };

    const callState = {
      callId: callResult.callId,
      isActive: true,
      retryCount: 0,
      disconnectCommands,
      dialogueContext,
    };

    this.activeCalls.set(instance.config.id, callState);

    try {
      await this.runInteractiveDialogueLoop(instance, userId, callResult.callId, config, disconnectCommands, dialogueContext);
      return true;
    } catch (error) {
      this.deps.logger?.error(`Error during interactive dialogue: ${error}`);
      this.activeCalls.delete(instance.config.id);
      return false;
    }
  }

  private async runInteractiveDialogueLoop(
    instance: ReminderInstance,
    userId: string,
    callId: string,
    config: PhoneCallConfig,
    disconnectCommands: string[],
    context: DialogueContext,
  ): Promise<void> {
    const callState = this.activeCalls.get(instance.config.id);
    if (!callState || !callState.isActive) return;

    const maxDurationSec = config.maxRingDurationSec ?? 300;
    const startTime = Date.now();
    let userAcknowledged = false;

    const initialMessage = `${instance.config.message}\n\n（请回复"退下"或"收到"结束通话）`;

    try {
      const audioBuffer = await this.deps.voiceDialogueService.generateAndSpeak(initialMessage, {
        voiceId: "alloy",
        speed: 1.0,
      });

      this.deps.logger?.info(`Playing initial TTS message for call ${callId}`);
    } catch (error) {
      this.deps.logger?.error(`Failed to generate initial TTS: ${error}`);
    }

    while (callState.isActive && !userAcknowledged) {
      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec >= maxDurationSec) {
        this.deps.logger?.info(`Call timeout after ${maxDurationSec}s`);
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const mockUserInput = await this.waitForUserInput(callId);

      if (!mockUserInput) {
        continue;
      }

      this.deps.logger?.info(`User input received: "${mockUserInput}"`);

      const shouldDisconnect = disconnectCommands.some((cmd) =>
        mockUserInput.toLowerCase().includes(cmd.toLowerCase()),
      );

      if (shouldDisconnect) {
        userAcknowledged = true;
        this.deps.logger?.info(`User acknowledged with: "${mockUserInput}"`);

        try {
          const goodbyeAudio = await this.deps.voiceDialogueService.generateAndSpeak(
            "好的，提醒已送达。再见！",
            { voiceId: "alloy", speed: 1.0 },
          );
          this.deps.logger?.info("Played goodbye message");
        } catch (error) {
          this.deps.logger?.error(`Failed to generate goodbye TTS: ${error}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        context.conversationHistory.push({
          role: "user",
          content: mockUserInput,
        });

        try {
          const llmResponse = await this.deps.voiceDialogueService.chatCompletion(
            context.conversationHistory,
            {
              temperature: 0.7,
              systemPrompt:
                "你是提醒助手，简短回应用户，并引导他们说'退下'或'收到'来结束通话。",
            },
          );

          context.conversationHistory.push({
            role: "assistant",
            content: llmResponse,
          });

          const responseAudio = await this.deps.voiceDialogueService.generateAndSpeak(llmResponse, {
            voiceId: "alloy",
            speed: 1.0,
          });

          this.deps.logger?.info(`LLM response: "${llmResponse}"`);
        } catch (error) {
          this.deps.logger?.error(`Error in LLM dialogue: ${error}`);

          const fallbackAudio = await this.deps.voiceDialogueService.generateAndSpeak(
            `我听到了您说"${mockUserInput}"。请回复"退下"结束通话。`,
            { voiceId: "alloy", speed: 1.0 },
          );
        }
      }
    }

    callState.isActive = false;
    this.activeCalls.delete(instance.config.id);

    if (userAcknowledged) {
      await this.sendCallCompletedNotification(userId, instance);
    }
  }

  private async waitForUserInput(callId: string): Promise<string | null> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 1000);
    });
  }

  /**
   * 构建前摇引导语（精简版）。
   */
  private buildPreGreeting(instance: ReminderInstance): string {
    return "";  // 不加额外引导语，直接播提醒正文
  }

  private formatTimeLabel(): string {
    const hour = new Date().getHours();
    if (hour < 6) return "深夜";
    if (hour < 9) return "早上";
    if (hour < 12) return "上午";
    if (hour < 14) return "中午";
    if (hour < 18) return "下午";
    if (hour < 22) return "晚上";
    return "夜间";
  }

  private async sendIncomingCallNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "incoming_reminder_call",
      reminderId: instance.config.id,
      title: instance.config.title,
      message: instance.config.message,
      priority: instance.config.priority,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  private async sendCallFailedNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "reminder_call_failed",
      reminderId: instance.config.id,
      title: instance.config.title,
      message: "无法接通电话，请查看消息内容",
      originalMessage: instance.config.message,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  private async sendCallCompletedNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "reminder_call_completed",
      reminderId: instance.config.id,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  forceEndCall(reminderId: string): boolean {
    const callState = this.activeCalls.get(reminderId);
    if (!callState || !callState.isActive) {
      return false;
    }

    callState.isActive = false;
    this.activeCalls.delete(reminderId);
    this.deps.logger?.info(`Force ended call: ${reminderId}`);
    return true;
  }

  getActiveCallCount(): number {
    return Array.from(this.activeCalls.values()).filter((c) => c.isActive).length;
  }

  cleanup(): void {
    for (const [id, state] of this.activeCalls) {
      state.isActive = false;
    }
    this.activeCalls.clear();
  }
}
