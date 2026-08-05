// Agent Body Center —— Ear 耳/听觉传感器
//
// 职责：对应人体的听觉器官，统一封装「听」通道：
//   1. ASR 转写：优先级 voiceDialogue > funasrAdapter
//   2. phone-bridge 入站音频流：标记入站音频到达事件
//   3. voice-message 入站音频：委托 voiceMessageService 接收音频
//
// 设计原则（与 reflex-arc.ts / sensory-cortex.ts 一致）：
//   1. 子系统缺失时优雅降级（返回 ok=false + errorMessage），不抛异常
//   2. 所有 *Like 接口仅声明本模块实际用到的方法，结构兼容真实服务即可
//   3. 转写完成后发布 body.ear.transcript 信号到 BodyBus
//   4. async/await 风格，无 callback
//
// 与 brain/sensory-cortex.ts 的差异：
//   - SensoryCortex 是脑侧感知皮层，跨模态融合（听/看/说）
//   - Ear 是身体侧器官模块，仅负责听觉通道，挂到 BodyGateway

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
 * 语音对话子系统（VoiceDialogueService）的最小化结构接口。
 * 仅声明听觉皮层实际用到的 transcribeAudio 方法。
 */
interface VoiceDialogueLike {
  transcribeAudio(
    audio: {
      data: Buffer | unknown;
      format: string;
      sampleRate?: number;
      channels?: number;
    },
    opts?: { language?: string },
  ): Promise<{
    text: string;
    confidence: number;
    language?: string;
    isFinal: boolean;
  }>;
}

/**
 * ASR Adapter（FunAsrAdapter）的最小化结构接口。
 * 仅声明 transcribe 方法，与 services/voice-dialogue/types.ts 的 ASRProvider 结构兼容。
 */
interface AsrAdapterLike {
  transcribe(
    audio: { data: Buffer | string; format?: string },
    opts?: { language?: string },
  ): Promise<{ text: string; confidence: number; language?: string }>;
}

/**
 * PhoneBridge 入站音频流外观接口。
 * 真实实现为 PhoneBridgeCoordinator，此处仅声明 onInboundAudio 钩子（可选）。
 */
interface PhoneBridgeInboundLike {
  onInboundAudio?(
    handler: (audio: { data: Buffer; format: string }) => void,
  ): void;
}

/**
 * VoiceMessage 入站音频外观接口。
 * 真实实现为 VoiceMessageService，此处仅声明 receiveAudio 方法（可选）。
 */
interface VoiceMessageInboundLike {
  receiveAudio?(
    messageId: string,
  ): Promise<{ audio: { data: Buffer; format: string }; from?: string }>;
}

// ---- EarDeps ------------------------------------------------

/**
 * Ear 构造参数。
 *
 * - bodyBus：必填，身体内部消息总线，用于发布 body.ear.transcript 信号
 * - voiceDialogue：优先级 1 的 ASR 通道（含 transcribeAudio）
 * - funasrAdapter：优先级 2 的 ASR 通道
 * - phoneBridge：入站音频流（可选）
 * - voiceMessageService：入站语音消息（可选）
 */
export interface EarDeps {
  bodyBus: BodyBus;
  voiceDialogue?: VoiceDialogueLike;
  funasrAdapter?: AsrAdapterLike;
  phoneBridge?: PhoneBridgeInboundLike;
  voiceMessageService?: VoiceMessageInboundLike;
}

// ---- 内部类型 -----------------------------------------------------------

/** 转写结果（含来源标记，便于审计与回溯） */
interface TranscriptRecord {
  text: string;
  confidence: number;
  language?: string;
  /** 来源标识：voiceDialogue / funasr / phone_bridge / voice_message */
  source: string;
  /** ISO timestamp */
  timestamp: string;
}

/** ASR adapter 选择结果 */
interface SelectedAsrAdapter {
  adapter: AsrAdapterLike | VoiceDialogueLike;
  /** 适配器名（用于 source 标记与 sense 返回） */
  name: string;
}

// ---- Ear 主类 -----------------------------------------------

/**
 * 耳/听觉传感器：身体侧的听觉器官模块。
 *
 * 实现 BodyModuleLike 接口，挂到 BodyGateway 后由其路由调用。
 *
 * 工具列表：
 *   - asr.transcribe：转写音频，返回 { text, confidence, language }
 *   - phone_bridge.inbound_audio：标记入站音频到达事件
 *   - voice_message.inbound_audio：委托 voiceMessageService 接收音频
 *
 * 信号发布：
 *   - body.ear.transcript：转写完成后发布，payload 含 transcript/confidence/language/source
 *
 * 子系统缺失时优雅降级：
 *   - ASR 全部不可用 → act 返回 ok=false + errorMessage="no ASR adapter available"
 *   - phoneBridge 缺失 → phone_bridge.inbound_audio 返回 ok=false + errorMessage
 *   - voiceMessageService 缺失 → voice_message.inbound_audio 返回 ok=false + errorMessage
 */
export class Ear implements BodyModuleLike {
  readonly name = "ear" as const;
  readonly label = "耳/听觉传感器";
  readonly tools = [
    "asr.transcribe",
    "phone_bridge.inbound_audio",
    "voice_message.inbound_audio",
  ];

  private readonly bodyBus: BodyBus;
  private readonly voiceDialogue: VoiceDialogueLike | null;
  private readonly funasrAdapter: AsrAdapterLike | null;
  
  private readonly phoneBridge: PhoneBridgeInboundLike | null;
  private readonly voiceMessageService: VoiceMessageInboundLike | null;

  private started = false;

  /** 最近一次转写结果（sense 查询用） */
  private lastTranscript: TranscriptRecord | null = null;
  /** 最近一次活动时间（ISO timestamp，无活动时为 null） */
  private lastActivityAt: string | null = null;

  constructor(deps: EarDeps) {
    this.bodyBus = deps.bodyBus;
    this.voiceDialogue = deps.voiceDialogue ?? null;
    this.funasrAdapter = deps.funasrAdapter ?? null;
    
    this.phoneBridge = deps.phoneBridge ?? null;
    this.voiceMessageService = deps.voiceMessageService ?? null;
  }

  // ---- 生命周期 ---------------------------------------------------------

  /** 启动听觉皮层：当前无后台任务，仅置位并记日志。 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[Ear] 已启动，跳过重复 start");
      return;
    }
    console.log("[Ear] 正在启动...");
    this.started = true;
    console.log("[Ear] 启动完成");
  }

  /** 停止听觉皮层：仅置位，不主动中断底层服务。 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[Ear] 未启动，跳过 stop");
      return;
    }
    console.log("[Ear] 正在停止...");
    this.started = false;
    console.log("[Ear] 已停止");
  }

  // ---- 核心方法：act ----------------------------------------------------

  /**
   * 执行听觉相关动作。
   *
   * 工具分发：
   *  - asr.transcribe → 调 selectBestAsrAdapter 选最优 ASR adapter 转写 args.audio
   *  - phone_bridge.inbound_audio → 标记入站音频到达事件
   *  - voice_message.inbound_audio → 委托 voiceMessageService 接收音频
   *
   * 任一分支异常均被捕获，返回 ok=false + errorMessage，不抛出。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    const startTime = Date.now();
    const tool = action.tool ?? "";
    const args = action.args ?? {};

    try {
      switch (tool) {
        case "asr.transcribe":
          return await this.actTranscribe(args, action, startTime);
        case "phone_bridge.inbound_audio":
          return await this.actPhoneBridgeInbound(args, action, startTime);
        case "voice_message.inbound_audio":
          return await this.actVoiceMessageInbound(args, action, startTime);
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
      console.log(`[Ear] act 异常 tool=${tool} err=${errMsg}`);
      return {
        ok: false,
        result: { error: errMsg },
        errorMessage: errMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * asr.transcribe：转写音频。
   *
   * 调 selectBestAsrAdapter 选最优 ASR adapter，转写 args.audio（结构同 transcribe 入参）。
   * 转写成功后发布 body.ear.transcript 信号到 BodyBus。
   * 全部 ASR adapter 不可用时返回 ok=false + errorMessage="no ASR adapter available"。
   */
  private async actTranscribe(
    args: Record<string, unknown>,
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    const audio = (args.audio ?? {}) as {
      data?: Buffer | string;
      format?: string;
      language?: string;
    };

    if (!audio.data) {
      return {
        ok: false,
        result: { error: "missing_audio_data" },
        errorMessage: "missing_audio_data",
        durationMs: Date.now() - startTime,
      };
    }

    const selected = this.selectBestAsrAdapter();
    if (!selected) {
      return {
        ok: false,
        result: { error: "no ASR adapter available" },
        errorMessage: "no ASR adapter available",
        durationMs: Date.now() - startTime,
      };
    }

    const result = await this.invokeAdapter(
      selected,
      { data: audio.data, format: audio.format },
      audio.language ? { language: audio.language } : undefined,
    );

    // 记录最近一次转写结果
    const record: TranscriptRecord = {
      text: result.text,
      confidence: result.confidence,
      language: result.language,
      source: selected.name,
      timestamp: new Date().toISOString(),
    };
    this.lastTranscript = record;
    this.touchActivity();

    // 发布 body.ear.transcript 信号
    try {
      this.bodyBus.publish({
        kind: "body.ear.transcript",
        payload: {
          transcript: record.text,
          confidence: record.confidence,
          language: record.language,
          source: record.source,
          timestamp: record.timestamp,
        },
        module: "ear",
        actorId: action.actorId,
        timestamp: record.timestamp,
      });
    } catch (err) {
      // 信号发布失败不影响主流程
      console.log(`[Ear] bodyBus.publish 异常: ${err}`);
    }

    return {
      ok: true,
      result: {
        text: result.text,
        confidence: result.confidence,
        language: result.language,
        source: record.source,
      },
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * phone_bridge.inbound_audio：标记入站音频到达事件。
   *
   * phoneBridge 缺失或未暴露 onInboundAudio 时返回 ok=false + errorMessage。
   * 入站音频的实质性处理（落盘/转写）由调用方在收到信号后自行编排。
   */
  private async actPhoneBridgeInbound(
    args: Record<string, unknown>,
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (!this.phoneBridge || typeof this.phoneBridge.onInboundAudio !== "function") {
      return {
        ok: false,
        result: { error: "phone_bridge_not_available" },
        errorMessage: "phone_bridge_not_available",
        durationMs: Date.now() - startTime,
      };
    }

    // 标记入站音频到达事件（发布到 BodyBus，让其他模块可订阅 body.ear.inbound_audio）
    const now = new Date().toISOString();
    this.touchActivity();
    try {
      this.bodyBus.publish({
        kind: "body.ear.inbound_audio",
        payload: {
          source: "phone_bridge",
          format: (args.format as string) ?? "unknown",
          actorId: action.actorId,
          timestamp: now,
        },
        module: "ear",
        actorId: action.actorId,
        timestamp: now,
      });
    } catch (err) {
      console.log(`[Ear] bodyBus.publish 异常: ${err}`);
    }

    return {
      ok: true,
      result: {
        source: "phone_bridge",
        marked: true,
        timestamp: now,
      },
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * voice_message.inbound_audio：委托 voiceMessageService 接收音频。
   *
   * voiceMessageService 缺失或未暴露 receiveAudio 时返回 ok=false + errorMessage。
   * 成功时返回音频数据与来源；后续可由调用方调 asr.transcribe 转写。
   */
  private async actVoiceMessageInbound(
    args: Record<string, unknown>,
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (
      !this.voiceMessageService ||
      typeof this.voiceMessageService.receiveAudio !== "function"
    ) {
      return {
        ok: false,
        result: { error: "voice_message_service_not_available" },
        errorMessage: "voice_message_service_not_available",
        durationMs: Date.now() - startTime,
      };
    }

    const messageId = (args.messageId as string) ?? "";
    if (!messageId) {
      return {
        ok: false,
        result: { error: "missing_message_id" },
        errorMessage: "missing_message_id",
        durationMs: Date.now() - startTime,
      };
    }

    const received = await this.voiceMessageService.receiveAudio(messageId);
    this.touchActivity();

    const now = new Date().toISOString();
    try {
      this.bodyBus.publish({
        kind: "body.ear.inbound_audio",
        payload: {
          source: "voice_message",
          messageId,
          format: received.audio.format,
          from: received.from,
          actorId: action.actorId,
          timestamp: now,
        },
        module: "ear",
        actorId: action.actorId,
        timestamp: now,
      });
    } catch (err) {
      console.log(`[Ear] bodyBus.publish 异常: ${err}`);
    }

    return {
      ok: true,
      result: {
        source: "voice_message",
        messageId,
        audio: {
          format: received.audio.format,
          size: received.audio.data.length,
        },
        from: received.from,
        timestamp: now,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // ---- 核心方法：sense --------------------------------------------------

  /**
   * 感官查询。
   *
   * 支持的 query.kind：
   *  - "ear.last_transcript"：返回最近一次转写结果
   *  - "ear.status"：返回 { availableAdapters, lastTranscriptAt }
   * 其他 kind 返回 ok=false + errorMessage="unknown_query_kind"。
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind ?? "";

    switch (kind) {
      case "ear.last_transcript": {
        if (!this.lastTranscript) {
          return {
            ok: true,
            data: { transcript: null, message: "no transcript yet" },
            module: "ear",
          };
        }
        return {
          ok: true,
          data: {
            transcript: this.lastTranscript.text,
            confidence: this.lastTranscript.confidence,
            language: this.lastTranscript.language,
            source: this.lastTranscript.source,
            timestamp: this.lastTranscript.timestamp,
          },
          module: "ear",
        };
      }

      case "ear.status": {
        return {
          ok: true,
          data: {
            availableAdapters: this.listAvailableAdapters(),
            lastTranscriptAt: this.lastTranscript?.timestamp ?? null,
          },
          module: "ear",
        };
      }

      default:
        return {
          ok: false,
          data: { error: "unknown_query_kind" },
          module: "ear",
          errorMessage: `unknown_query_kind:${kind}`,
        };
    }
  }

  // ---- 核心方法：snapshot ----------------------------------------------

  /** 模块快照：返回当前在线状态、子系统列表与最近活动时间。 */
  snapshot(): BodyModuleSnapshot {
    return {
      name: "ear",
      label: this.label,
      tools: [...this.tools],
      online: this.started,
      subsystems: this.listAvailableAdapters(),
      lastActivityAt: this.lastActivityAt,
      metadata: {
        lastTranscript: this.lastTranscript
          ? {
              text: this.lastTranscript.text.slice(0, 80),
              source: this.lastTranscript.source,
              timestamp: this.lastTranscript.timestamp,
            }
          : null,
      },
    };
  }

  // ---- 核心方法：registerTools -----------------------------------------

  /**
   * 把 asr.transcribe / phone_bridge.inbound_audio / voice_message.inbound_audio
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

  // ---- 公开方法：transcribe（供其他 BodyModule 调用） ------------------

  /**
   * 转写音频（公开方法，供其他 BodyModule 直接调用，绕过 act/sense 路由）。
   *
   * 优先级：voiceDialogue > funasrAdapter。
   * 全部不可用时返回 ok=false 形态的退化结果（text="", confidence=0）。
   *
   * @param audio 音频数据，data 为 Buffer 或 base64 字符串
   * @param opts.format 音频格式（mp3/wav/ogg/pcm），可选
   * @param opts.language 语言提示，可选
   * @returns 转写结果 { text, confidence, language? }
   */
  async transcribe(audio: {
    data: Buffer | string;
    format?: string;
    language?: string;
  }): Promise<{ text: string; confidence: number; language?: string }> {
    const selected = this.selectBestAsrAdapter();
    if (!selected) {
      console.log("[Ear] transcribe: no ASR adapter available");
      return { text: "", confidence: 0 };
    }

    try {
      const result = await this.invokeAdapter(
        selected,
        { data: audio.data, format: audio.format },
        audio.language ? { language: audio.language } : undefined,
      );

      // 记录最近一次转写结果（与 act 路径一致）
      const record: TranscriptRecord = {
        text: result.text,
        confidence: result.confidence,
        language: result.language,
        source: selected.name,
        timestamp: new Date().toISOString(),
      };
      this.lastTranscript = record;
      this.touchActivity();

      // 发布 body.ear.transcript 信号
      try {
        this.bodyBus.publish({
          kind: "body.ear.transcript",
          payload: {
            transcript: record.text,
            confidence: record.confidence,
            language: record.language,
            source: record.source,
            timestamp: record.timestamp,
          },
          module: "ear",
          timestamp: record.timestamp,
        });
      } catch (err) {
        console.log(`[Ear] bodyBus.publish 异常: ${err}`);
      }

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[Ear] transcribe 调用失败: ${errMsg}`);
      return { text: "", confidence: 0 };
    }
  }

  // ---- 内部工具 ---------------------------------------------------------

  /**
   * 选择最优 ASR adapter。
   *
   * 优先级：voiceDialogue > funasrAdapter。
   * 全部不可用时返回 null。
   */
  private selectBestAsrAdapter(): SelectedAsrAdapter | null {
    if (this.voiceDialogue) {
      return { adapter: this.voiceDialogue, name: "voiceDialogue" };
    }
    if (this.funasrAdapter) {
      return { adapter: this.funasrAdapter, name: "funasr" };
    }
    return null;
  }

  /**
   * 统一调用 ASR adapter（兼容 VoiceDialogueLike 与 AsrAdapterLike 两种签名）。
   *
   * - VoiceDialogueLike.transcribeAudio 要求 format 字段（非可选），且返回 isFinal
   * - AsrAdapterLike.transcribe format 可选，不返回 isFinal
   *
   * 此方法做签名归一化，对外返回统一结构。
   */
  private async invokeAdapter(
    selected: SelectedAsrAdapter,
    audio: { data: Buffer | string; format?: string },
    opts?: { language?: string },
  ): Promise<{ text: string; confidence: number; language?: string }> {
    const format = audio.format ?? "wav";

    // VoiceDialogueLike 路径
    if (selected.name === "voiceDialogue") {
      const vd = selected.adapter as VoiceDialogueLike;
      const r = await vd.transcribeAudio(
        {
          data: audio.data,
          format: format as
            | "mp3"
            | "wav"
            | "pcm"
            | "ogg"
            | string,
        },
        opts?.language ? { language: opts.language } : undefined,
      );
      return {
        text: r.text,
        confidence: r.confidence,
        language: r.language,
      };
    }

    // AsrAdapterLike 路径（FunAsr 等）
    const adapter = selected.adapter as AsrAdapterLike;
    return adapter.transcribe(
      { data: audio.data, format },
      opts?.language ? { language: opts.language } : undefined,
    );
  }

  /** 列出当前可用的 ASR adapter 名（按优先级降序）。 */
  private listAvailableAdapters(): string[] {
    const list: string[] = [];
    if (this.voiceDialogue) list.push("voiceDialogue");
    if (this.funasrAdapter) list.push("funasr");
    return list;
  }

  /** 更新最近一次活动时间为当前 ISO 时间戳。 */
  private touchActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }
}
