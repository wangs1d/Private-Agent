/**
 * Webhook 事件发射器 — 内部 Pub/Sub 总线
 *
 * 职责：
 * 1. 接收事件 emit() 调用
 * 2. 维护内存中的事件历史（环形缓冲）
 * 3. 通知所有已注册的监听器（dispatcher 等）
 *
 * 设计对齐 LifeSignalHubService 的 Set<Subscriber> 模式。
 */
import { randomUUID } from "node:crypto";
import type {
  WebhookEvent,
  WebhookEventType,
} from "./webhook-event-types.js";

export type WebhookEventListener = (event: WebhookEvent) => Promise<void> | void;

export class WebhookEventEmitter {
  private readonly listeners = new Set<WebhookEventListener>();
  private readonly history: WebhookEvent[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory;
  }

  /** 发射事件：构建完整 event 对象 → 写入历史 → 通知所有监听器 */
  emit(
    type: WebhookEventType,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string; version?: string },
  ): WebhookEvent {
    const event: WebhookEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      actorId: opts?.actorId,
      data,
      metadata: {
        ...(opts?.source && { source: opts.source }),
        ...(opts?.version && { version: opts.version }),
      },
    };

    // 环形缓冲写入历史
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // 异步通知所有监听器，单个异常不阻断其他
    for (const listener of this.listeners) {
      void Promise.resolve(listener(event)).catch((err) => {
        console.error("[WebhookEmitter] listener error:", err);
      });
    }

    return event;
  }

  /** 注册事件监听器，返回取消订阅函数 */
  subscribe(listener: WebhookEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 查询最近的事件历史 */
  recentEvents(limit = 50, typeFilter?: WebhookEventType): WebhookEvent[] {
    let slice = [...this.history];
    if (typeFilter) {
      slice = slice.filter((e) => e.type === typeFilter);
    }
    return slice.slice(-limit);
  }

  /** 当前历史条目数 */
  get historySize(): number {
    return this.history.length;
  }
}
