import type { AudioBuffer } from "./types.js";

// ─── 电话通话抽象接口 ──────────────────────────────────────────────
// 定义 Agent ↔ 用户「打电话」能力的契约。
// 当前实现：TtsOnlyPhoneCallProvider（单向 TTS 播报 + 来电 UI）
// 未来实现：FullDuplexPhoneCallProvider（ASR → LLM → TTS 双向交互）

/** 来电振铃阶段配置 */
export interface RingPhaseConfig {
  /** 是否启用振铃前摇（false 则直接推接通事件） */
  enableRingingPhase?: boolean;
  /** 振铃持续毫秒数，默认 8000 */
  ringDurationMs?: number;
}

/** 呼叫用户参数 */
export interface CallUserParams {
  /** 主叫方 Actor ID */
  fromActorId: string;
  /** 被叫用户 ID */
  toUserId: string;
  /** 通话文稿（TTS 将把这段文字转为语音播放给用户） */
  transcript: string;
  /** 来电风格 */
  ringStyle: "reminder" | "peer";
  /** 振铃配置（可选） */
  ringPhase?: RingPhaseConfig;
}

/** 单次呼叫结果 */
export interface CallResult {
  /** 是否成功发起 */
  ok: boolean;
  /** 通话唯一 ID */
  callId?: string;
  /** 是否成功推送到客户端 WebSocket */
  pushed?: boolean;
  /** 错误信息 */
  error?: string;
}

/** 通话状态（未来全双工模式使用） */
export type CallState =
  | "ringing"       // 振铃中
  | "connecting"    // 连接中/等待接通
  | "connected";    // 已接通

/** 电话通话 Provider 抽象接口 */
export interface PhoneCallProvider {
  /** Provider 标识名 */
  readonly name: string;

  /** 是否支持双向交互（ASR 语音输入）—— 当前 TTS-only 返回 false */
  readonly supportsFullDuplex: boolean;

  /**
   * 发起一次对用户的呼叫。
   *
   * 实现细节由各子类决定：
   * - TTS-only：推送 WebSocket 来电事件 + base64 TTS 音频，客户端播报后结束
   * - 全双工：建立持久会话，支持用户语音回复 → ASR → LLM → TTS 循环
   */
  callUser(params: CallUserParams): Promise<CallResult>;

  /**
   * 强制结束指定通话（可选，TTS-only 可不实现）。
   */
  endCall?(callId: string): Promise<boolean>;

  /**
   * 查询当前活跃通话数量。
   */
  getActiveCallCount?(): number;
}

// ─── TTS-Only 实现（当前默认）──────────────────────────────────────
// 仅通过 TTS 合成语音 + WebSocket 推送来电事件，客户端模拟真实来电体验。

export interface TtsOnlyPhoneCallDeps {
  /** TTS 文本转语音服务 */
  synthesizeMp3Base64: (text: string) => Promise<
    | { ok: true; format: "mp3"; base64: string }
    | { ok: false; reason: string }
  >;
  /** 向用户 WebSocket 推送消息 */
  sendWsToUser: (userId: string, payload: string) => boolean;
  /** 获取主叫方的虚拟号码（可为 null） */
  getFromPhone?: (actorId: string) => string | undefined;
}

/**
 * TTS-Only 电话通话 Provider。
 *
 * 工作流程：
 *   1. （可选）推送振铃开始事件 → 客户端显示来电 UI + 播放铃声
 *   2. 等待振铃时长
 *   3. TTS 合成 transcript 为 mp3 base64
 *   4. 推送接通事件（含 TTS 音频 + 文稿）→ 客户端播放语音
 *
 * 特点：单向播报，用户无法语音回复。适合提醒、通知场景。
 */
export class TtsOnlyPhoneCallProvider implements PhoneCallProvider {
  readonly name = "tts-only";
  readonly supportsFullDuplex = false;

  private deps: TtsOnlyPhoneCallDeps;

  constructor(deps: TtsOnlyPhoneCallDeps) {
    this.deps = deps;
  }

  async callUser(params: CallUserParams): Promise<CallResult> {
    const { fromActorId, toUserId, transcript, ringStyle } = params;
    const ringCfg = params.ringPhase ?? {};
    const enableRinging = ringCfg.enableRingingPhase !== false;
    const ringDurationMs = ringCfg.ringDurationMs ?? 8_000;

    if (!fromActorId?.trim()) {
      return { ok: false, error: "主叫方 Actor ID 无效" };
    }
    if (!toUserId?.trim()) {
      return { ok: false, error: "被叫用户 ID 无效" };
    }

    const fromPhone = this.deps.getFromPhone?.(fromActorId);
    const callId = crypto.randomUUID();

    // ---- 阶段 1：振铃 ----
    if (enableRinging) {
      const ringingPayload = JSON.stringify({
        type: "virtual_phone.ringing_start",
        payload: {
          callId,
          fromActorId,
          fromPhone: fromPhone ?? null,
          toUserId,
          direction: "agent_to_user",
          status: "ringing",
          ringStyle,
          initiatedBy: "agent",
          ringDurationMs,
          estimatedConnectAt: new Date(Date.now() + ringDurationMs).toISOString(),
        },
      });
      this.deps.sendWsToUser(toUserId, ringingPayload);
    }

    // ---- TTS 合成（与振铃并行减少接通延迟） ----
    const ttsResult = await this.deps.synthesizeMp3Base64(transcript);

    // ---- 等待振铃结束 ----
    if (enableRinging) {
      await new Promise<void>((resolve) => setTimeout(resolve, ringDurationMs));
    }

    // ---- 阶段 2：接通（含 TTS 音频） ----
    const connectPayload = JSON.stringify({
      type: enableRinging ? "virtual_phone.call_connecting" : "virtual_phone.incoming",
      payload: {
        callId,
        fromActorId,
        fromPhone: fromPhone ?? null,
        toUserId,
        transcript: transcript.trim(),
        ringStyle,
        initiatedBy: "agent",
        direction: "agent_to_user",
        status: "connected",
        tts: ttsResult.ok
          ? { format: ttsResult.format, base64: ttsResult.base64 }
          : { format: null, skippedReason: ttsResult.reason },
        replyEnabled: false, // TTS-only 模式不支持用户语音回复
      },
    });

    const pushed = this.deps.sendWsToUser(toUserId, connectPayload);

    return { ok: true, callId, pushed, error: undefined };
  }
}
