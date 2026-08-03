// Agent Body Center —— Mouth 嘴/发声执行器
//
// 职责：对应人体的发声器官，统一封装「说」通道：
//   1. TTS 合成：tts.speak / voice.synthesize 经 selectBestTtsChannel 选最优通道合成
//   2. voice-message 出站：voice_message.send 委托 voiceMessageService 发可重播语音消息
//   3. phone-bridge 出站语音：phone_bridge.outbound_speak 委托 phoneBridge 直接对通话端说话
//
// TTS 通道选择优先级（selectBestTtsChannel）：
//   1. phoneBridge 处于通话中（inCall=true）→ 用 phoneBridge.outboundSpeak
//   2. 否则按 voiceDialogue > ttsService > voiceCapability 顺序选第一个可用
//   3. 全部不可用 → 返回 null，act 返回 ok=false + errorMessage="no tts channel available"
//
// 设计原则（与 reflex-arc.ts / ear.ts 一致）：
//   1. 子系统缺失时优雅降级（返回 ok=false + errorMessage），不抛异常
//   2. 所有 *Like 接口仅声明本模块实际用到的方法，结构兼容真实服务即可
//   3. 合成完成后发布 body.mouth.spoken 信号到 BodyBus，供 Ear / BrainCenter 订阅
//   4. async/await 风格，无 callback

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyToolRegistry,
} from "./types.js";

// ---- 子系统最小化外观接口（结构兼容真实服务即可）----------------------

/**
 * TtsService 的最小化结构接口。
 * 仅声明发声皮层实际用到的 synthesize 方法，与 services/tts-service.ts 结构兼容
 * （真实 TtsService 暴露 synthesizeMp3Base64/synthesizeMp3Buffer，调用方传入时
 * 需提供结构兼容的包装器或本接口约定的 synthesize 方法）。
 */
interface TtsServiceLike {
  synthesize(
    text: string,
    opts?: { voiceId?: string },
  ): Promise<{
    audioUrl?: string;
    base64?: string;
    format?: string;
    durationMs?: number;
  }>;
}

/**
 * VoiceDialogueService 的最小化结构接口。
 * 仅声明 synthesizeSpeech 方法，与 services/voice-dialogue/voice-dialogue-service.ts
 * 暴露的 synthesizeSpeech(text, options?) 结构兼容（返回 AudioBuffer）。
 */
interface VoiceDialogueLike {
  synthesizeSpeech(
    text: string,
    opts?: { voiceId?: string },
  ): Promise<{
    data: Buffer | unknown;
    format: string;
    sampleRate?: number;
    channels?: number;
  }>;
}

/**
 * VoiceCapabilityService 的最小化结构接口（兜底 TTS 通道）。
 * 仅声明 synthesize 方法，与 services/voice-capability-service.ts 的 synthesize(text)
 * 结构兼容（返回 ok=true 形态或 ok=false + reason）。
 */
interface VoiceCapabilityLike {
  synthesize(
    text: string,
  ): Promise<{
    ok: boolean;
    format?: "mp3";
    base64?: string;
    provider?: string;
    reason?: string;
  }>;
}

/**
 * VoiceMessageService 出站外观接口。
 * 真实实现为 VoiceMessageService，此处仅声明 send 方法（发送可重播语音消息）。
 * 真实服务暴露的是 composeAndStore/storeUploaded，调用方需提供结构兼容的适配器。
 */
interface VoiceMessageLike {
  send(opts: {
    to?: string;
    audioUrl?: string;
    text?: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

/**
 * PhoneBridge 出站语音外观接口。
 * 真实实现为 PhoneBridgeCoordinator，此处仅声明 outboundSpeak 方法
 * （对通话端直接说话，真实服务通过 invoke(actorId, "outbound_speak", params) 实现）。
 */
interface PhoneBridgeLike {
  outboundSpeak(opts: {
    text: string;
    voiceId?: string;
  }): Promise<{ ok: boolean; callId?: string; error?: string }>;
}

// ---- MouthDeps ---------------------------------------------------

/**
 * Mouth 构造参数。
 *
 * - bodyBus：必填，身体内部消息总线，用于发布 body.mouth.spoken 信号
 * - voiceDialogue：优先级 1 的 TTS 通道（含 synthesizeSpeech）
 * - ttsService：优先级 2 的 TTS 通道
 * - voiceCapability：优先级 3 的 TTS 通道（兜底）
 * - voiceMessageService：出站可重播语音消息（可选）
 * - phoneBridge：出站语音通道 / 通话中时优先使用的 TTS 通道（可选）
 */
export interface MouthDeps {
  bodyBus: BodyBus;
  voiceDialogue?: VoiceDialogueLike;
  ttsService?: TtsServiceLike;
  voiceCapability?: VoiceCapabilityLike;
  voiceMessageService?: VoiceMessageLike;
  phoneBridge?: PhoneBridgeLike;
}

// ---- 内部类型 -----------------------------------------------------------

/** TTS 通道标识。 */
type TtsChannel =
  | "phone_bridge"
  | "voice_dialogue"
  | "tts_service"
  | "voice_capability";

/** 统一三个通道的合成产物。 */
interface SynthesisResult {
  ok: boolean;
  channel: TtsChannel;
  audioUrl?: string;
  base64?: string;
  format?: string;
  durationMs?: number;
  voiceId?: string;
  provider?: string;
  /** 失败原因（ok=false 时填） */
  error?: string;
}

// ---- Mouth 主类 --------------------------------------------------

/**
 * 嘴/发声执行器：身体侧的发声器官模块。
 *
 * 实现 BodyModuleLike 接口，挂到 BodyGateway 后由其路由调用。
 *
 * 工具列表：
 *   - tts.speak                  → 经 selectBestTtsChannel 选最优 TTS 通道合成
 *   - voice.synthesize           → 同 tts.speak（别名）
 *   - voice_message.send         → 委托 voiceMessageService 发可重播语音消息
 *   - phone_bridge.outbound_speak → 委托 phoneBridge 对通话端说话
 *
 * 信号发布：
 *   - body.mouth.spoken：TTS 合成 / phone-bridge 出站成功后发布，
 *     payload 含 textPreview/channel/voiceId/durationMs
 *
 * 子系统缺失时优雅降级：
 *   - TTS 全部不可用 → act 返回 ok=false + errorMessage="no tts channel available"
 *   - voiceMessageService 缺失 → voice_message.send 返回 ok=false + errorMessage
 *   - phoneBridge 缺失 → phone_bridge.outbound_speak 返回 ok=false + errorMessage
 */
export class Mouth implements BodyModuleLike {
  readonly name = "mouth" as const;
  readonly label = "嘴/发声执行器";
  readonly tools = [
    "tts.speak",
    "voice.synthesize",
    "voice_message.send",
    "phone_bridge.outbound_speak",
  ];

  private readonly bodyBus: BodyBus;
  private readonly voiceDialogue: VoiceDialogueLike | null;
  private readonly ttsService: TtsServiceLike | null;
  private readonly voiceCapability: VoiceCapabilityLike | null;
  private readonly voiceMessageService: VoiceMessageLike | null;
  private readonly phoneBridge: PhoneBridgeLike | null;

  /** 通话中状态（由 phone-bridge 入口通过 setInCall 通知，初始 false）。 */
  private inCall = false;

  private started = false;
  /** 最近一次活动时间（ISO timestamp，无活动时为 null） */
  private lastActivityAt: string | null = null;

  constructor(deps: MouthDeps) {
    this.bodyBus = deps.bodyBus;
    this.voiceDialogue = deps.voiceDialogue ?? null;
    this.ttsService = deps.ttsService ?? null;
    this.voiceCapability = deps.voiceCapability ?? null;
    this.voiceMessageService = deps.voiceMessageService ?? null;
    this.phoneBridge = deps.phoneBridge ?? null;
  }

  // ---- 生命周期 ---------------------------------------------------------

  /** 启动发声皮层：当前无后台任务，仅置位并记日志。 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[Mouth] 已启动，跳过重复 start");
      return;
    }
    console.log("[Mouth] 正在启动...");
    this.started = true;
    const channels = this.listAvailableChannels();
    console.log(
      `[Mouth] 启动完成，可用通道: ${channels.length ? channels.join(", ") : "(无)"}`,
    );
  }

  /** 停止发声皮层：仅置位，不主动中断底层服务。 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[Mouth] 未启动，跳过 stop");
      return;
    }
    console.log("[Mouth] 正在停止...");
    this.started = false;
    console.log("[Mouth] 已停止");
  }

  // ---- 外部状态注入 -----------------------------------------------------

  /**
   * 通知通话状态（由 phone-bridge 入口在接通/挂断时调用）。
   *
   * 通话中状态影响 TTS 通道选择：inCall=true 时 selectBestTtsChannel 优先用
   * phoneBridge.outboundSpeak，让语音直接进入通话回路。
   */
  setInCall(inCall: boolean): void {
    const prev = this.inCall;
    this.inCall = inCall;
    if (prev !== inCall) {
      console.log(`[Mouth] 通话状态变更: ${prev} → ${inCall}`);
    }
  }

  // ---- 核心方法：act ----------------------------------------------------

  /**
   * 执行发声相关动作。
   *
   * 工具分发：
   *  - tts.speak / voice.synthesize → 调 selectBestTtsChannel 选最优 TTS 通道合成
   *  - voice_message.send           → 委托 voiceMessageService 发可重播语音消息
   *  - phone_bridge.outbound_speak  → 委托 phoneBridge 对通话端说话
   *
   * 任一分支异常均被捕获，返回 ok=false + errorMessage，不抛出。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    const startTime = Date.now();
    const tool = action.tool ?? "";

    try {
      switch (tool) {
        case "tts.speak":
        case "voice.synthesize":
          return await this.actSynthesize(action, startTime);
        case "voice_message.send":
          return await this.actVoiceMessageSend(action, startTime);
        case "phone_bridge.outbound_speak":
          return await this.actPhoneBridgeOutbound(action, startTime);
        default:
          return {
            ok: false,
            result: { error: `unknown_tool:${tool}` },
            errorMessage: `unknown_tool:${tool}`,
            durationMs: Date.now() - startTime,
          };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[Mouth] act 异常 tool=${tool} err=${errMsg}`);
      return {
        ok: false,
        result: { error: errMsg },
        errorMessage: errMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * tts.speak / voice.synthesize：经 selectBestTtsChannel 选最优 TTS 通道合成。
   *
   * 通道优先级：
   *   1. phoneBridge 处于通话中 → phone_bridge
   *   2. voiceDialogue > ttsService > voiceCapability（取第一个可用）
   *   3. 全部不可用 → ok=false + errorMessage="no tts channel available"
   *
   * 合成成功后发布 body.mouth.spoken 信号到 BodyBus。
   */
  private async actSynthesize(
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    const args = action.args ?? {};
    const text = String(args.text ?? args.message ?? "").trim();
    if (!text) {
      return {
        ok: false,
        result: { error: "missing_text" },
        errorMessage: "missing_text",
        durationMs: Date.now() - startTime,
      };
    }
    const voiceId =
      args.voiceId !== undefined && args.voiceId !== null
        ? String(args.voiceId)
        : undefined;

    const channel = this.selectBestTtsChannel();
    if (!channel) {
      return {
        ok: false,
        result: { error: "no tts channel available" },
        errorMessage: "no tts channel available",
        durationMs: Date.now() - startTime,
      };
    }

    const synth = await this.synthesizeVia(channel, text, voiceId);
    if (!synth.ok) {
      return {
        ok: false,
        result: { error: synth.error ?? "synthesis_failed", channel },
        errorMessage: synth.error ?? "synthesis_failed",
        durationMs: Date.now() - startTime,
      };
    }

    this.touchActivity();

    // 发布 body.mouth.spoken 信号
    this.publishSpoken({
      text,
      channel: synth.channel,
      voiceId: synth.voiceId ?? voiceId,
      durationMs: synth.durationMs,
      actorId: action.actorId,
    });

    return {
      ok: true,
      result: {
        channel: synth.channel,
        audioUrl: synth.audioUrl,
        base64: synth.base64 ? `<${synth.base64.length} chars>` : undefined,
        format: synth.format,
        durationMs: synth.durationMs,
        provider: synth.provider,
        textPreview: text.slice(0, 80),
      },
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * voice_message.send：委托 voiceMessageService 发可重播语音消息。
   *
   * voiceMessageService 缺失时返回 ok=false + errorMessage。
   * 成功时返回 messageId / to / textPreview。
   * 本路径不发布 body.mouth.spoken 信号（消息落地与即时播报语义不同）。
   */
  private async actVoiceMessageSend(
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (!this.voiceMessageService) {
      return {
        ok: false,
        result: { error: "voice_message_service_unavailable" },
        errorMessage: "voice_message_service_unavailable",
        durationMs: Date.now() - startTime,
      };
    }

    const args = action.args ?? {};
    const text = String(args.text ?? args.message ?? "").trim();
    const to =
      args.to !== undefined && args.to !== null
        ? String(args.to)
        : action.actorId;
    const audioUrl =
      args.audioUrl !== undefined && args.audioUrl !== null
        ? String(args.audioUrl)
        : undefined;

    const r = await this.voiceMessageService.send({ to, audioUrl, text });
    this.touchActivity();

    if (!r.ok) {
      return {
        ok: false,
        result: { error: r.error ?? "voice_message_send_failed" },
        errorMessage: r.error ?? "voice_message_send_failed",
        durationMs: Date.now() - startTime,
      };
    }

    return {
      ok: true,
      result: {
        messageId: r.messageId,
        to,
        textPreview: text.slice(0, 80),
      },
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * phone_bridge.outbound_speak：委托 phoneBridge 对通话端说话。
   *
   * phoneBridge 缺失时返回 ok=false + errorMessage。
   * 成功时发布 body.mouth.spoken 信号（channel="phone_bridge"）。
   */
  private async actPhoneBridgeOutbound(
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (!this.phoneBridge) {
      return {
        ok: false,
        result: { error: "phone_bridge_unavailable" },
        errorMessage: "phone_bridge_unavailable",
        durationMs: Date.now() - startTime,
      };
    }

    const args = action.args ?? {};
    const text = String(args.text ?? args.message ?? "").trim();
    if (!text) {
      return {
        ok: false,
        result: { error: "missing_text" },
        errorMessage: "missing_text",
        durationMs: Date.now() - startTime,
      };
    }
    const voiceId =
      args.voiceId !== undefined && args.voiceId !== null
        ? String(args.voiceId)
        : undefined;

    const r = await this.phoneBridge.outboundSpeak({ text, voiceId });
    this.touchActivity();

    if (!r.ok) {
      return {
        ok: false,
        result: { error: r.error ?? "phone_bridge_outbound_failed" },
        errorMessage: r.error ?? "phone_bridge_outbound_failed",
        durationMs: Date.now() - startTime,
      };
    }

    // 发布 body.mouth.spoken 信号（phone-bridge 出站也是「说」事件）
    this.publishSpoken({
      text,
      channel: "phone_bridge",
      voiceId,
      actorId: action.actorId,
    });

    return {
      ok: true,
      result: {
        callId: r.callId,
        channel: "phone_bridge",
        textPreview: text.slice(0, 80),
      },
      durationMs: Date.now() - startTime,
    };
  }

  // ---- 核心方法：sense --------------------------------------------------

  /**
   * 感官查询。
   *
   * 支持的 query.kind：
   *  - "mouth.status"：返回 { inCall, availableChannels, started }
   *
   * 其他 kind 返回 ok=false + errorMessage="unknown_query_kind"。
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind ?? "";

    switch (kind) {
      case "mouth.status": {
        return {
          ok: true,
          data: {
            inCall: this.inCall,
            availableChannels: this.listAvailableChannels(),
            started: this.started,
          },
          module: "mouth",
        };
      }

      default:
        return {
          ok: false,
          data: { error: "unknown_query_kind" },
          module: "mouth",
          errorMessage: `unknown_query_kind:${kind}`,
        };
    }
  }

  // ---- 核心方法：snapshot ----------------------------------------------

  /** 模块快照：返回当前在线状态、子系统列表与最近活动时间。 */
  snapshot(): BodyModuleSnapshot {
    return {
      name: "mouth",
      label: this.label,
      tools: [...this.tools],
      online: this.started,
      subsystems: this.listAvailableChannels(),
      lastActivityAt: this.lastActivityAt,
      metadata: {
        inCall: this.inCall,
        availableChannels: this.listAvailableChannels(),
      },
    };
  }

  // ---- 核心方法：registerTools -----------------------------------------

  /**
   * 把 tts.speak / voice.synthesize / voice_message.send / phone_bridge.outbound_speak
   * 工具挂到外部 ToolRegistry，handler 内部委托 this.act()。
   *
   * actorId 暂时无法获取（BodyToolRegistry 接口未传 context），保持 undefined。
   * 返回值：成功 { ok: true, ...result.result }；失败 { ok: false, error, ...result.result }。
   */
  registerTools(registry: BodyToolRegistry): void {
    for (const toolName of this.tools) {
      registry.register(toolName, async (input) => {
        const result = await this.act({
          tool: toolName,
          args: input,
          source: "body_module",
        });
        if (!result.ok) {
          return {
            ok: false,
            error:
              result.errorMessage ??
              result.reason ??
              "body module action failed",
            ...result.result,
          };
        }
        return { ok: true, ...result.result };
      });
    }
  }

  // ---- 内部工具：通道选择 ----------------------------------------------

  /**
   * 选择最优 TTS 通道。
   *
   * 优先级：
   *   1. phoneBridge 处于通话中（inCall=true 且 phoneBridge 存在）→ phone_bridge
   *   2. voiceDialogue > ttsService > voiceCapability（取第一个可用）
   *   3. 全部不可用 → null
   */
  private selectBestTtsChannel(): TtsChannel | null {
    if (this.inCall && this.phoneBridge) {
      return "phone_bridge";
    }
    if (this.voiceDialogue) {
      return "voice_dialogue";
    }
    if (this.ttsService) {
      return "tts_service";
    }
    if (this.voiceCapability) {
      return "voice_capability";
    }
    return null;
  }

  /** 列出当前已配置的 TTS 通道（不含 inCall 状态，仅反映子系统是否注入）。 */
  private listAvailableChannels(): TtsChannel[] {
    const list: TtsChannel[] = [];
    if (this.phoneBridge) list.push("phone_bridge");
    if (this.voiceDialogue) list.push("voice_dialogue");
    if (this.ttsService) list.push("tts_service");
    if (this.voiceCapability) list.push("voice_capability");
    return list;
  }

  // ---- 内部工具：通道合成 ----------------------------------------------

  /**
   * 按指定通道调用对应子系统的合成方法，归一化返回 SynthesisResult。
   *
   * - phone_bridge     → phoneBridge.outboundSpeak（通话回路播报）
   * - voice_dialogue   → voiceDialogue.synthesizeSpeech（返回 AudioBuffer）
   * - tts_service      → ttsService.synthesize（返回 base64/audioUrl）
   * - voice_capability → voiceCapability.synthesize（兜底，返回 base64）
   */
  private async synthesizeVia(
    channel: TtsChannel,
    text: string,
    voiceId?: string,
  ): Promise<SynthesisResult> {
    if (channel === "phone_bridge") {
      if (!this.phoneBridge) {
        return { ok: false, channel, error: "phone_bridge_unavailable" };
      }
      const r = await this.phoneBridge.outboundSpeak({ text, voiceId });
      if (!r.ok) {
        return { ok: false, channel, error: r.error ?? "phone_bridge_failed" };
      }
      return { ok: true, channel, voiceId };
    }

    if (channel === "voice_dialogue") {
      if (!this.voiceDialogue) {
        return { ok: false, channel, error: "voice_dialogue_unavailable" };
      }
      const r = await this.voiceDialogue.synthesizeSpeech(
        text,
        voiceId ? { voiceId } : undefined,
      );
      const data = r.data;
      const base64 = Buffer.isBuffer(data) ? data.toString("base64") : undefined;
      return {
        ok: true,
        channel,
        base64,
        format: r.format,
        voiceId,
      };
    }

    if (channel === "tts_service") {
      if (!this.ttsService) {
        return { ok: false, channel, error: "tts_service_unavailable" };
      }
      const r = await this.ttsService.synthesize(
        text,
        voiceId ? { voiceId } : undefined,
      );
      return {
        ok: true,
        channel,
        audioUrl: r.audioUrl,
        base64: r.base64,
        format: r.format,
        durationMs: r.durationMs,
        voiceId,
      };
    }

    // voice_capability（兜底通道）
    if (!this.voiceCapability) {
      return { ok: false, channel, error: "voice_capability_unavailable" };
    }
    const r = await this.voiceCapability.synthesize(text);
    if (!r.ok) {
      return { ok: false, channel, error: r.reason ?? "voice_capability_failed" };
    }
    return {
      ok: true,
      channel,
      base64: r.base64,
      format: r.format,
      provider: r.provider,
      voiceId,
    };
  }

  // ---- 内部工具：信号发布 ----------------------------------------------

  /**
   * 发布 body.mouth.spoken 信号到 BodyBus。
   *
   * payload 含 textPreview（前 80 字摘要）/ textLength / channel / voiceId / durationMs。
   * 信号发布失败不阻断主流程。
   */
  private publishSpoken(opts: {
    text: string;
    channel: TtsChannel;
    voiceId?: string;
    durationMs?: number;
    actorId?: string;
  }): void {
    const now = new Date().toISOString();
    try {
      this.bodyBus.publish({
        kind: "body.mouth.spoken",
        payload: {
          textPreview: opts.text.slice(0, 80),
          textLength: opts.text.length,
          channel: opts.channel,
          voiceId: opts.voiceId ?? null,
          durationMs: opts.durationMs ?? null,
        },
        module: "mouth",
        actorId: opts.actorId,
        timestamp: now,
      });
    } catch (err) {
      console.log(`[Mouth] bodyBus.publish 异常: ${err}`);
    }
  }

  /** 更新最近一次活动时间为当前 ISO 时间戳。 */
  private touchActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }
}
