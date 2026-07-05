import type { ReminderInstance, TTSAlarmConfig } from "./types.js";
import type { VoiceCapabilityService } from "../voice-capability-service.js";
import type { VoiceDialogueService } from "../voice-dialogue/voice-dialogue-service.js";

export interface TTSAlarmHandlerDeps {
  voiceDialogueService: VoiceDialogueService;
  /** Agent 底层语音能力中枢（首选，用于合成 + 推送音频到客户端） */
  voiceCapabilityService?: VoiceCapabilityService;
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

/**
 * TTS 闹钟式提醒处理器。
 *
 * 重构说明（修复音频丢弃 bug）：
 *   原实现调 `voiceDialogueService.generateAndSpeak` 合成音频后立即丢弃，仅打 log，
 *   导致客户端只收到 `tts_alarm_start` 文字通知，无法播放语音。
 *
 *   现改为优先使用 `VoiceCapabilityService`：
 *     1. 推送 `tts_alarm_start` 事件（文字通知 + 元数据）
 *     2. 调 `voiceCapabilityService.synthesize` 合成 mp3 base64
 *     3. 推送 `tts_alarm_play` 事件含音频 base64 —— 客户端真正能播放
 *     4. 渐强循环：复用已合成音频重复推送（不重复消耗 TTS 配额）
 *
 *   若未注入 `voiceCapabilityService`，则回退到原 `voiceDialogueService` 路径
 *   （行为不变，仅用于过渡兼容）。
 */
export class TTSAlarmHandler {
  private deps: TTSAlarmHandlerDeps;
  private activeAlarms = new Map<string, {
    rampUpTimer?: NodeJS.Timeout;
    repeatTimer?: NodeJS.Timeout;
    isStopped: boolean;
    currentVolume: number;
    /** 预合成的音频（复用，避免渐强循环中重复消耗 TTS 配额） */
    cachedTts?: { format: "mp3"; base64: string };
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
      cachedTts: undefined as { format: "mp3"; base64: string } | undefined,
    };

    this.activeAlarms.set(instance.config.id, state);

    try {
      await this.sendAlarmStartNotification(userId, instance);

      // 预合成音频（一次合成，渐强 + 重复均复用）
      if (this.deps.voiceCapabilityService) {
        try {
          const ttsResult = await this.deps.voiceCapabilityService.synthesize(instance.config.message);
          if (ttsResult.ok) {
            state.cachedTts = { format: ttsResult.format, base64: ttsResult.base64 };
          } else {
            this.deps.logger?.error?.(`[TTSAlarm] 预合成失败：${ttsResult.reason}`);
          }
        } catch (e) {
          this.deps.logger?.error?.(`[TTSAlarm] 预合成异常：${e}`);
        }
      }

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

  /**
   * 在指定音量下"播放"一次 TTS。
   *
   * 修复点：现在会真正把音频 base64 推送到客户端（推 `tts_alarm_play` 事件），
   * 而非仅打 log 后丢弃。
   *
   * 渐强循环中复用 `state.cachedTts`，避免每个音量步都重新调 TTS API。
   */
  private async playTTSAtVolume(
    instance: ReminderInstance,
    userId: string,
    config: TTSAlarmConfig,
    volume: number,
  ): Promise<void> {
    const state = this.activeAlarms.get(instance.config.id);
    if (!state || state.isStopped) return;

    // 路径 1：通过 VoiceCapabilityService（修复后主路径）
    if (this.deps.voiceCapabilityService && state.cachedTts) {
      try {
        await this.deps.sendToClient(userId, {
          type: "tts_alarm_play",
          reminderId: instance.config.id,
          tts: { format: state.cachedTts.format, base64: state.cachedTts.base64 },
          text: instance.config.message,
          volume,
          timestamp: new Date().toISOString(),
        });
        this.deps.logger?.info?.(
          `[TTSAlarm] 推送音频播放事件: alarm=${instance.config.id} volume=${volume.toFixed(2)}`,
        );
        return;
      } catch (e) {
        this.deps.logger?.error?.(`[TTSAlarm] 推送音频失败，回退：${e}`);
      }
    }

    // 路径 2：回退到 VoiceDialogueService（过渡兼容，行为同原实现）
    try {
      const audioBuffer = await this.deps.voiceDialogueService.generateAndSpeak(
        instance.config.message,
        {
          voiceId: config.voiceId,
          speed: config.speed,
          volume,
        },
      );
      // 修复：把回退路径合成的音频也推送出去，不再丢弃
      if (audioBuffer?.data?.length) {
        await this.deps.sendToClient(userId, {
          type: "tts_alarm_play",
          reminderId: instance.config.id,
          tts: { format: audioBuffer.format, base64: audioBuffer.data.toString("base64") },
          text: instance.config.message,
          volume,
          timestamp: new Date().toISOString(),
        });
      }
      this.deps.logger?.info?.(
        `[TTSAlarm] 回退路径合成并推送: alarm=${instance.config.id} volume=${volume.toFixed(2)}`,
      );
    } catch (error) {
      this.deps.logger?.error(`Failed to generate TTS audio: ${error}`);
      throw error;
    }
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
