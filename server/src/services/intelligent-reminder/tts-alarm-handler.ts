import type { ReminderInstance, TTSAlarmConfig } from "./types.js";

export interface TTSAlarmHandlerDeps {
  synthesizeSpeech: (params: {
    text: string;
    voiceId?: string;
    speed?: number;
  }) => Promise<Buffer>;
  playAudio: (userId: string, audioBuffer: Buffer, volume: number) => Promise<void>;
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export class TTSAlarmHandler {
  private deps: TTSAlarmHandlerDeps;
  private activeAlarms = new Map<string, {
    rampUpTimer?: NodeJS.Timeout;
    repeatTimer?: NodeJS.Timeout;
    isStopped: boolean;
    currentVolume: number;
  }>();

  constructor(deps: TTSAlarmHandlerDeps) {
    this.deps = deps;
  }

  async handle(instance: ReminderInstance): Promise<void> {
    const config = instance.ttsConfig ?? {};
    const userId = instance.config.metadata?.userId as string | undefined;

    if (!userId) {
      this.deps.logger?.error("TTS alarm missing userId in metadata");
      return;
    }

    const volumeStart = config.volumeStart ?? 0.3;
    const volumeEnd = config.volumeEnd ?? 1.0;
    const rampUpDurationMs = config.rampUpDurationMs ?? 10_000;
    const repeatIntervalMs = config.repeatIntervalMs ?? 15_000;

    const state = {
      isStopped: false,
      currentVolume: volumeStart,
      rampUpTimer: undefined as NodeJS.Timeout | undefined,
      repeatTimer: undefined as NodeJS.Timeout | undefined,
    };

    this.activeAlarms.set(instance.config.id, state);

    try {
      await this.sendAlarmStartNotification(userId, instance);
      await this.playTTSWithRampUp(instance, userId, config, volumeStart, volumeEnd, rampUpDurationMs);

      if (!state.isStopped) {
        state.repeatTimer = setInterval(async () => {
          if (state.isStopped) {
            return;
          }
          try {
            await this.playTTSAtVolume(instance, userId, config, volumeEnd);
          } catch (error) {
            this.deps.logger?.error(`Error in TTS repeat: ${error}`);
          }
        }, repeatIntervalMs);

        this.activeAlarms.set(instance.config.id, { ...state, repeatTimer: state.repeatTimer });
      }

      this.deps.logger?.info(`TTS alarm started: ${instance.config.id}`);
    } catch (error) {
      this.deps.logger?.error(`Failed to start TTS alarm: ${error}`);
      this.stopAlarm(instance.config.id);
      throw error;
    }
  }

  private async sendAlarmStartNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "tts_alarm_start",
      reminderId: instance.config.id,
      title: instance.config.title,
      message: instance.config.message,
      priority: instance.config.priority,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  private async playTTSWithRampUp(
    instance: ReminderInstance,
    userId: string,
    config: TTSAlarmConfig,
    volumeStart: number,
    volumeEnd: number,
    rampUpDurationMs: number,
  ): Promise<void> {
    const state = this.activeAlarms.get(instance.config.id);
    if (!state || state.isStopped) return;

    const steps = 20;
    const stepDurationMs = rampUpDurationMs / steps;
    const volumeIncrement = (volumeEnd - volumeStart) / steps;

    for (let i = 0; i <= steps; i++) {
      if (state.isStopped) break;

      const currentVolume = Math.min(volumeStart + volumeIncrement * i, volumeEnd);
      state.currentVolume = currentVolume;

      try {
        await this.playTTSAtVolume(instance, userId, config, currentVolume);
      } catch (error) {
        this.deps.logger?.error(`Error playing TTS at volume ${currentVolume}: ${error}`);
      }

      if (i < steps && !state.isStopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, stepDurationMs);
          state.rampUpTimer = timer;
        });
      }
    }
  }

  private async playTTSAtVolume(
    instance: ReminderInstance,
    userId: string,
    config: TTSAlarmConfig,
    volume: number,
  ): Promise<void> {
    const audioBuffer = await this.deps.synthesizeSpeech({
      text: instance.config.message,
      voiceId: config.voiceId,
      speed: config.speed,
    });

    await this.deps.playAudio(userId, audioBuffer, volume);
  }

  stopAlarm(reminderId: string): boolean {
    const state = this.activeAlarms.get(reminderId);
    if (!state) {
      return false;
    }

    state.isStopped = true;

    if (state.rampUpTimer) {
      clearTimeout(state.rampUpTimer);
    }

    if (state.repeatTimer) {
      clearInterval(state.repeatTimer);
    }

    this.activeAlarms.delete(reminderId);
    this.deps.logger?.info(`TTS alarm stopped: ${reminderId}`);
    return true;
  }

  getActiveAlarmCount(): number {
    return this.activeAlarms.size;
  }

  cleanup(): void {
    for (const [id] of this.activeAlarms) {
      this.stopAlarm(id);
    }
  }
}
