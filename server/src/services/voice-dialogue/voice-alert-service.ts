import type { AudioBuffer } from "./types.js";

// ─── 语音提醒服务抽象（闹钟式 TTS 播报）────────────────────────────
// 定义「用语音通知用户」能力的契约。
// 场景：提醒、闹钟、定时播报 —— 单向 TTS 音频推送，无需来电 UI。

/** 语音提醒参数 */
export interface VoiceAlertParams {
  /** 目标用户 ID */
  toUserId: string;
  /** 要朗读的文字内容 */
  message: string;
  /** 提醒标题/分类 */
  title?: string;
  /** 优先级 */
  priority?: "low" | "medium" | "high" | "urgent";
  /** TTS 语音配置 */
  voiceConfig?: {
    voiceId?: string;
    speed?: number;
    volume?: number;
  };
  /** 是否启用渐强音量（默认 true，模拟闹钟渐响效果） */
  rampUpVolume?: boolean;
  /** 渐强起始音量 (0~1) */
  volumeStart?: number;
  /** 渐强目标音量 (0~1) */
  volumeEnd?: number;
  /** 渐强持续时间（毫秒） */
  rampUpDurationMs?: number;
  /** 重复播放间隔（毫秒），不设置则只播放一次 */
  repeatIntervalMs?: number;
}

/** 语音提醒结果 */
export interface VoiceAlertResult {
  ok: boolean;
  alertId?: string;
  error?: string;
}

/** 停止提醒结果 */
export interface StopAlertResult {
  stopped: boolean;
  alertId?: string;
}

/**
 * 语音提醒 Provider 抽象接口。
 *
 * 与 PhoneCallProvider 的区别：
 * - VoiceAlert = 闹钟/通知风格：直接播放 TTS 音频，无来电 UI，无振铃
 * - PhoneCall = 电话通话风格：振铃 → 接通 → 播放语音，有完整来电体验
 */
export interface VoiceAlertProvider {
  readonly name: string;

  /**
   * 发起一次语音提醒。
   *
   * 实现方式：
   * - 推送 WebSocket 事件通知客户端开始播放 TTS 音频
   * - 支持可选的渐强音量 + 重复播放（闹钟模式）
   */
  alert(params: VoiceAlertParams): Promise<VoiceAlertResult>;

  /**
   * 停止指定提醒的播放。
   */
  stopAlert(alertId: string): Promise<StopAlertResult>;

  /** 当前活跃提醒数量 */
  getActiveCount(): number;

  /** 清理所有活跃提醒 */
  cleanup(): void;
}

// ─── 默认实现：基于 TTS 合成 + WebSocket 推送 ──────────────────────

export interface DefaultVoiceAlertDeps {
  /** TTS 文本转语音（返回 mp3 base64） */
  synthesizeMp3Base64: (text: string) => Promise<
    | { ok: true; format: "mp3"; base64: string }
    | { ok: false; reason: string }
  >;
  /** 向用户 WebSocket 推送消息 */
  sendWsToUser: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

/**
 * 默认语音提醒实现。
 *
 * 工作流程：
 *   1. 推送 tts_alarm_start 事件 → 客户端显示提醒 UI
 *   2. TTS 合成文字为 mp3 base64
 *   3. （可选）渐强音量循环播放，模拟闹钟效果
 *   4. 支持 stopAlert 中断
 */
export class TtsVoiceAlertProvider implements VoiceAlertProvider {
  readonly name = "tts-default";

  private deps: DefaultVoiceAlertDeps;
  private activeAlerts = new Map<string, {
    isStopped: boolean;
    repeatTimer?: ReturnType<typeof setInterval>;
  }>();

  constructor(deps: DefaultVoiceAlertDeps) {
    this.deps = deps;
  }

  async alert(params: VoiceAlertParams): Promise<VoiceAlertResult> {
    const { toUserId, message } = params;
    if (!toUserId?.trim()) return { ok: false, error: "用户 ID 无效" };
    if (!message?.trim()) return { ok: false, error: "提醒内容为空" };

    const alertId = crypto.randomUUID();
    const state: { isStopped: boolean; repeatTimer?: ReturnType<typeof setInterval> } = { isStopped: false };
    this.activeAlerts.set(alertId, state);

    try {
      // 1. 推送提醒开始事件
      await this.deps.sendWsToUser(toUserId, {
        type: "tts_alarm_start",
        alertId,
        title: params.title ?? "语音提醒",
        message,
        priority: params.priority ?? "medium",
        timestamp: new Date().toISOString(),
      });

      // 2. TTS 合成
      const ttsResult = await this.deps.synthesizeMp3Base64(message);
      if (!ttsResult.ok) {
        this.deps.logger?.error(`[VoiceAlert] TTS 合成失败: ${ttsResult.reason}`);
        // 即使 TTS 失败也推送文本兜底
        await this.deps.sendWsToUser(toUserId, {
          type: "tts_alarm_play",
          alertId,
          tts: { format: null, skippedReason: ttsResult.reason },
          text: message,
        });
        return { ok: true, alertId };
      }

      // 3. 推送音频播放事件
      await this.deps.sendWsToUser(toUserId, {
        type: "tts_alarm_play",
        alertId,
        tts: { format: ttsResult.format, base64: ttsResult.base64 },
        text: message,
        volumeStart: params.rampUpVolume !== false ? (params.volumeStart ?? 0.3) : undefined,
        volumeEnd: params.volumeEnd ?? 1.0,
        rampUpDurationMs: params.rampUpDurationMs ?? 10_000,
      });

      // 4. 设置重复播放（闹钟模式）
      const repeatInterval = params.repeatIntervalMs;
      if (repeatInterval && repeatInterval > 0 && !state.isStopped) {
        state.repeatTimer = setInterval(async () => {
          if (state.isStopped) return;
          try {
            await this.deps.sendWsToUser(toUserId, {
              type: "tts_alarm_play",
              alertId,
              tts: { format: ttsResult.format, base64: ttsResult.base64 },
              text: message,
              volume: params.volumeEnd ?? 1.0,
            });
          } catch (e) {
            this.deps.logger?.error(`[VoiceAlert] 重复播放失败: ${e}`);
          }
        }, repeatInterval);
      }

      this.deps.logger?.info(`[VoiceAlert] 提醒已发起: ${alertId}`);
      return { ok: true, alertId };
    } catch (error) {
      this.activeAlerts.delete(alertId);
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  }

  async stopAlert(alertId: string): Promise<StopAlertResult> {
    const state = this.activeAlerts.get(alertId);
    if (!state) return { stopped: false };

    state.isStopped = true;
    if (state.repeatTimer) clearInterval(state.repeatTimer);
    this.activeAlerts.delete(alertId);
    this.deps.logger?.info(`[VoiceAlert] 提醒已停止: ${alertId}`);
    return { stopped: true, alertId };
  }

  getActiveCount(): number {
    return this.activeAlerts.size;
  }

  cleanup(): void {
    for (const [id, state] of this.activeAlerts) {
      state.isStopped = true;
      if (state.repeatTimer) clearInterval(state.repeatTimer);
    }
    this.activeAlerts.clear();
  }
}
