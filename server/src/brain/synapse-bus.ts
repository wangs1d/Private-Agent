// Agent Brain Center — 突触总线（SynapseBus / 胼胝体）
//
// 统一的跨分区 / 跨 Agent / 到用户的通信枢纽。
// 所有方法都是事件驱动，不让 LLM 决定要不要通知。
// - 进程内通信：HookBus
// - 跨 Agent 通信：AIP 协议
// - 推送给用户：WebSocket
// - 离线存储：MessageHub
import { randomUUID } from "node:crypto";
import type { SynapseEnvelope, SynapseMessage } from "./types.js";

// ─── 子系统外观接口（最小化） ───────────────────────────────────

// HookBus 外观：进程内 Pub/Sub
interface HookBusLike {
  emit(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string; version?: string },
  ): unknown;
  // subscribeType 为指定类型的订阅，返回取消函数
  subscribeType(
    type: string,
    handler: (event: unknown) => void | Promise<void>,
  ): () => void;
  // 订阅者统计（可选，未暴露时 getSubscriberCount 返回 0）
  getStats?(): {
    globalListeners: number;
    typedListeners: number;
    historySize: number;
    typedBreakdown: Record<string, number>;
  };
}

// MessageHub 外观：离线存储（createOutbound 为可选方法，未实现时静默跳过）
interface MessageHubLike {
  createOutbound?(input: { actorId: string; conversationId?: string; text: string; platform?: string }): Promise<unknown>;
}

// AipService 外观：跨 Agent 投递（dispatch 同步返回结果对象）
interface AipServiceLike {
  dispatch(params: {
    fromSessionId: string;
    toSessionId: string;
    rawEnvelope: unknown;
    traceId?: string;
    chatUserMessageId?: string;
  }):
    | { ok: true; record: unknown; pushedToPeer: boolean }
    | { ok: false; message: string };
}

// WsConnectionRegistry 外观：WebSocket 推送
interface WsRegistryLike {
  trySend(sessionId: string, data: string): boolean;
}

// ─── SynapseBus ──────────────────────────────────────────────

/**
 * SynapseBus —— 突触总线（胼胝体）。
 *
 * 大脑各分区之间、以及大脑与外部 Agent / 用户之间的统一通信层。
 * 持有四个子系统的可选引用，任一缺失时方法优雅降级。
 */
export class SynapseBus {
  private hookBus: HookBusLike | null = null;
  private messageHub: MessageHubLike | null = null;
  private aipService: AipServiceLike | null = null;
  private wsRegistry: WsRegistryLike | null = null;

  private started = false;
  // 环形缓冲：最近 100 条突触消息
  private recentMessages: SynapseMessage[] = [];
  private readonly maxRecent = 100;

  // ─── 子系统注册 ──────────────────────────────────────────────

  registerHookBus(svc: HookBusLike): void {
    this.hookBus = svc;
    console.log("[SynapseBus] 已注册 HookBus");
  }

  registerMessageHub(svc: MessageHubLike): void {
    this.messageHub = svc;
    console.log("[SynapseBus] 已注册 MessageHub");
  }

  registerAipService(svc: AipServiceLike): void {
    this.aipService = svc;
    console.log("[SynapseBus] 已注册 AipService");
  }

  registerWsRegistry(svc: WsRegistryLike): void {
    this.wsRegistry = svc;
    console.log("[SynapseBus] 已注册 WsConnectionRegistry");
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) {
      console.log("[SynapseBus] 已启动，跳过重复 start");
      return;
    }
    console.log("[SynapseBus] 正在启动...");
    this.started = true;
    console.log("[SynapseBus] 启动完成");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[SynapseBus] 未启动，跳过 stop");
      return;
    }
    console.log("[SynapseBus] 正在停止...");
    this.started = false;
    console.log("[SynapseBus] 已停止");
  }

  // ─── 核心：进程内事件 ─────────────────────────────────────────

  /**
   * 发射一个进程内突触事件。
   * 委托 HookBus.emit 分发给所有订阅者，并记录到环形缓冲。
   * HookBus 未注册时返回 delivered:false。
   */
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): SynapseEnvelope {
    const now = new Date().toISOString();
    const msg: SynapseMessage = {
      id: randomUUID(),
      type,
      route: "internal",
      from: opts?.source ?? "brain",
      data,
      timestamp: now,
    };
    this.pushRecent(msg);

    if (!this.hookBus) {
      console.log("[SynapseBus] fire: HookBus 未注册，跳过分发");
      return { message: msg, delivered: false, error: "HookBus 未注册" };
    }

    try {
      this.hookBus.emit(type, data, {
        actorId: opts?.actorId,
        source: opts?.source,
      });
      return {
        message: msg,
        delivered: true,
        deliveredAt: new Date().toISOString(),
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[SynapseBus] fire: HookBus.emit 异常: ${errMsg}`);
      return { message: msg, delivered: false, error: errMsg };
    }
  }

  /**
   * 订阅指定类型的突触事件。
   * 委托 HookBus.subscribeType，把 HookEvent 转换为 SynapseMessage 后再回调。
   * 返回取消订阅函数；HookBus 未注册时返回空函数。
   */
  subscribe(
    type: string,
    handler: (msg: SynapseMessage) => void | Promise<void>,
  ): () => void {
    if (!this.hookBus) {
      console.log("[SynapseBus] subscribe: HookBus 未注册，返回空取消函数");
      return () => {};
    }

    // 包装：HookEvent → SynapseMessage
    const wrapped = (event: unknown): void | Promise<void> => {
      const e = event as {
        id?: string;
        type?: string;
        timestamp?: string;
        actorId?: string;
        source?: string;
        data?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
      const synapseMsg: SynapseMessage = {
        id: e.id ?? randomUUID(),
        type: e.type ?? type,
        route: "internal",
        from: e.source ?? e.actorId ?? "hook",
        to: e.actorId,
        data: e.data ?? {},
        metadata: e.metadata,
        timestamp: e.timestamp ?? new Date().toISOString(),
      };
      return handler(synapseMsg);
    };

    return this.hookBus.subscribeType(type, wrapped);
  }

  /**
   * 订阅指定类型的突触事件（直接转发 HookBus.subscribeType，不做 SynapseMessage 包装）。
   *
   * 与 subscribe() 的区别：handler 直接收到 HookEvent（含 data / actorId / source 字段），
   * 不做 SynapseMessage 转换；适合只需要 event.data 的内部订阅者（如皮层间联动）。
   * 返回取消订阅函数；HookBus 未注册时返回空函数。
   */
  subscribeType(
    type: string,
    handler: (event: {
      data: Record<string, unknown>;
      actorId?: string;
      source?: string;
    }) => void | Promise<void>,
  ): () => void {
    if (!this.hookBus) {
      console.log("[SynapseBus] subscribeType: HookBus 未注册，返回空取消函数");
      return () => {};
    }
    return this.hookBus.subscribeType(
      type,
      handler as (event: unknown) => void | Promise<void>,
    );
  }

  // ─── 核心：跨 Agent 通信 ──────────────────────────────────────

  /**
   * 向目标 Agent 投递消息（走 AIP 协议）。
   * 同时 fire 一个 synapse.agent_message 事件给进程内订阅者。
   * AipService 未注册或投递失败时优雅降级。
   */
  async sendToAgent(
    targetAgentId: string,
    message: { type: string; data: Record<string, unknown> },
    opts?: { from?: string },
  ): Promise<SynapseEnvelope> {
    const now = new Date().toISOString();
    const msg: SynapseMessage = {
      id: randomUUID(),
      type: message.type,
      route: "inter_agent",
      from: opts?.from ?? "brain",
      to: targetAgentId,
      data: message.data,
      timestamp: now,
    };
    this.pushRecent(msg);

    if (!this.aipService) {
      console.log("[SynapseBus] sendToAgent: AipService 未注册");
      return { message: msg, delivered: false, error: "AipService 未注册" };
    }

    let result:
      | { ok: true; record: unknown; pushedToPeer: boolean }
      | { ok: false; message: string };
    try {
      result = this.aipService.dispatch({
        fromSessionId: opts?.from ?? "brain",
        toSessionId: targetAgentId,
        rawEnvelope: message,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[SynapseBus] sendToAgent: AipService.dispatch 异常: ${errMsg}`);
      return { message: msg, delivered: false, error: errMsg };
    }

    if (!result.ok) {
      console.log(`[SynapseBus] sendToAgent: AIP 投递失败: ${result.message}`);
      return { message: msg, delivered: false, error: result.message };
    }

    // 通知进程内订阅者
    this.fire("synapse.agent_message", { ...message }, { source: opts?.from });

    return {
      message: msg,
      delivered: true,
      deliveredAt: new Date().toISOString(),
    };
  }

  // ─── 核心：推送给用户 ─────────────────────────────────────────

  /**
   * 向用户推送 WebSocket 消息。
   * WS 推送失败时降级到 MessageHub 离线存储（如已注册且暴露 createOutbound）。
   * 同时 fire 一个 synapse.user_message 事件给进程内订阅者。
   */
  async sendToUser(
    actorId: string,
    payload: unknown,
    opts?: { channel?: string },
  ): Promise<SynapseEnvelope> {
    const now = new Date().toISOString();
    const msg: SynapseMessage = {
      id: randomUUID(),
      type: "synapse.user_message",
      route: "to_user",
      from: "brain",
      to: actorId,
      data: { actorId, payload },
      metadata: opts?.channel ? { channel: opts.channel } : undefined,
      timestamp: now,
    };
    this.pushRecent(msg);

    let delivered = false;
    let error: string | undefined;

    // 1) 优先 WebSocket 推送
    if (this.wsRegistry) {
      try {
        delivered = this.wsRegistry.trySend(actorId, JSON.stringify(payload));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.log(`[SynapseBus] sendToUser: WS 推送异常: ${error}`);
      }
    } else {
      error = "WsRegistry 未注册";
    }

    // 2) 失败时降级到离线存储
    if (!delivered && this.messageHub && typeof this.messageHub.createOutbound === "function") {
      try {
        await this.messageHub.createOutbound({ actorId, text: typeof payload === "string" ? payload : JSON.stringify(payload) });
        delivered = true;
        error = undefined;
        console.log(`[SynapseBus] sendToUser: 已离线存储到 MessageHub (actorId=${actorId})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        error = error ? `${error}; 离线存储失败: ${errMsg}` : `离线存储失败: ${errMsg}`;
        console.log(`[SynapseBus] sendToUser: 离线存储异常: ${errMsg}`);
      }
    }

    // 3) 通知进程内订阅者
    this.fire("synapse.user_message", { actorId, payload }, {});

    const envelope: SynapseEnvelope = { message: msg, delivered };
    if (delivered) {
      envelope.deliveredAt = new Date().toISOString();
    } else if (error) {
      envelope.error = error;
    }
    return envelope;
  }

  // ─── 查询 ────────────────────────────────────────────────────

  /** 返回最近的 N 条突触消息（默认 20） */
  getRecentMessages(limit = 20): SynapseMessage[] {
    return this.recentMessages.slice(-limit);
  }

  /** 返回 HookBus 当前的订阅者数量；未注册或未暴露统计时返回 0 */
  getSubscriberCount(): number {
    if (!this.hookBus || typeof this.hookBus.getStats !== "function") {
      return 0;
    }
    const stats = this.hookBus.getStats();
    return stats.globalListeners + stats.typedListeners;
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  private pushRecent(msg: SynapseMessage): void {
    this.recentMessages.push(msg);
    if (this.recentMessages.length > this.maxRecent) {
      // 批量裁剪到 maxRecent，避免每次 shift 的 O(n)
      this.recentMessages.splice(0, this.recentMessages.length - this.maxRecent);
    }
  }
}

