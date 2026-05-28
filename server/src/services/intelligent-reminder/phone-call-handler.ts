import type { ReminderInstance, PhoneCallConfig } from "./types.js";

export interface PhoneCallHandlerDeps {
  initiateCall: (params: {
    userId: string;
    transcript: string;
    waitForResponse: boolean;
  }) => Promise<{
    ok: boolean;
    callId?: string;
    error?: string;
  }>;
  synthesizeSpeech: (text: string) => Promise<Buffer>;
  playAudioInCall: (callId: string, audio: Buffer) => Promise<void>;
  recognizeSpeech: (callId: string, durationMs: number) => Promise<string>;
  hangupCall: (callId: string) => Promise<void>;
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
  }>();

  constructor(deps: PhoneCallHandlerDeps) {
    this.deps = deps;
  }

  async handle(instance: ReminderInstance): Promise<void> {
    const config = instance.phoneConfig ?? {};
    const userId = instance.config.metadata?.userId as string | undefined;

    if (!userId) {
      this.deps.logger?.error("Phone call reminder missing userId in metadata");
      return;
    }

    const disconnectCommands = config.disconnectCommand ?? ["退下", "知道了", "收到", "挂断"];
    const maxRetries = config.retryCount ?? 2;

    let retryCount = 0;
    let callSuccessful = false;

    while (retryCount <= maxRetries && !callSuccessful) {
      try {
        callSuccessful = await this.executePhoneCall(
          instance,
          userId,
          config,
          disconnectCommands,
        );
      } catch (error) {
        this.deps.logger?.error(`Phone call attempt ${retryCount + 1} failed: ${error}`);
      }

      if (!callSuccessful && retryCount < maxRetries) {
        retryCount++;
        this.deps.logger?.info(`Retrying phone call... Attempt ${retryCount + 1}/${maxReties}`);
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
    config: PhoneCallConfig,
    disconnectCommands: string[],
  ): Promise<boolean> {
    await this.sendIncomingCallNotification(userId, instance);

    const result = await this.deps.initiateCall({
      userId,
      transcript: instance.config.message,
      waitForResponse: config.waitForResponse ?? true,
    });

    if (!result.ok || !result.callId) {
      return false;
    }

    const callState = {
      callId: result.callId,
      isActive: true,
      retryCount: 0,
      disconnectCommands,
    };

    this.activeCalls.set(instance.config.id, callState);

    try {
      await this.runCallInteractionLoop(instance, result.callId, config, disconnectCommands);
      return true;
    } catch (error) {
      this.deps.logger?.error(`Error during call interaction: ${error}`);
      await this.safeHangup(result.callId);
      this.activeCalls.delete(instance.config.id);
      return false;
    }
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

  private async runCallInteractionLoop(
    instance: ReminderInstance,
    callId: string,
    config: PhoneCallConfig,
    disconnectCommands: string[],
  ): Promise<void> {
    const callState = this.activeCalls.get(instance.config.id);
    if (!callState || !callState.isActive) return;

    const initialMessage = `${instance.config.message}。请回复"退下"或挂断电话结束通话。`;
    const audioBuffer = await this.deps.synthesizeSpeech(initialMessage);
    await this.deps.playAudioInCall(callId, audioBuffer);

    const maxRingDurationSec = config.maxRingDurationSec ?? 300;
    const startTime = Date.now();
    let userAcknowledged = false;

    while (callState.isActive && !userAcknowledged) {
      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec >= maxRingDurationSec) {
        this.deps.logger?.info(`Call timeout after ${maxRingDurationSec}s`);
        break;
      }

      try {
        const userResponse = await this.deps.recognizeSpeech(callId, 3000);

        if (!userResponse || userResponse.trim() === "") {
          continue;
        }

        const normalizedResponse = userResponse.trim().toLowerCase();
        this.deps.logger?.info(`User response: "${userResponse}"`);

        const shouldDisconnect = disconnectCommands.some((cmd) =>
          normalizedResponse.includes(cmd.toLowerCase()),
        );

        if (shouldDisconnect) {
          userAcknowledged = true;
          this.deps.logger?.info(`User acknowledged with: "${userResponse}"`);

          const goodbyeAudio = await this.deps.synthesizeSpeech("好的，提醒已送达。再见！");
          await this.deps.playAudioInCall(callId, goodbyeAudio);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          const repeatAudio = await this.deps.synthesizeSpeech(
            `我听到了您说"${userResponse}"。请回复"退下"结束通话。`,
          );
          await this.deps.playAudioInCall(callId, repeatAudio);
        }
      } catch (error) {
        if ((error as Error).message?.includes("call_ended")) {
          this.deps.logger?.info("User hung up the call");
          break;
        }
        this.deps.logger?.error(`Error recognizing speech: ${error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await this.safeHangup(callId);
    callState.isActive = false;
    this.activeCalls.delete(instance.config.id);

    if (userAcknowledged) {
      await this.sendCallCompletedNotification(
        instance.config.metadata?.userId as string,
        instance,
      );
    }
  }

  private async safeHangup(callId: string): Promise<void> {
    try {
      await this.deps.hangupCall(callId);
    } catch (error) {
      this.deps.logger?.error(`Error hanging up call ${callId}: ${error}`);
    }
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
    this.safeHangup(callState.callId);
    this.activeCalls.delete(reminderId);
    this.deps.logger?.info(`Force ended call: ${reminderId}`);
    return true;
  }

  getActiveCallCount(): number {
    return Array.from(this.activeCalls.values()).filter((c) => c.isActive).length;
  }

  cleanup(): void {
    for (const [id, state] of this.activeCalls) {
      if (state.isActive) {
        this.safeHangup(state.callId);
      }
    }
    this.activeCalls.clear();
  }
}
