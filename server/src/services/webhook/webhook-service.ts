/**
 * Webhook 服务 — 事件驱动推送的顶层入口
 *
 * 整合 WebhookEventEmitter + WebhookDispatcher，提供：
 * - emit() — 发射事件（业务代码调用入口）
 * - 端点 CRUD 管理
 * - 启动/关闭生命周期
 * - 从环境变量加载默认端点
 */
import { randomUUID } from "node:crypto";
import { WebhookEventEmitter } from "./webhook-event-emitter.js";
import { WebhookDispatcher } from "./webhook-dispatcher.js";
import type {
  WebhookEndpoint,
  WebhookEvent,
  WebhookEventType,
  WebhookServiceConfig,
  WebhookDispatchResult,
} from "./webhook-event-types.js";

/** 解析环境变量，构建 Webhook 服务配置 */
export function resolveWebhookConfig(): WebhookServiceConfig {
  const enabled = parseBoolean(process.env.WEBHOOK_ENABLED, false);
  const defaultUrls = (process.env.WEBHOOK_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const secret = process.env.WEBHOOK_SECRET ?? "";

  return {
    enabled,
    defaultUrls,
    secret,
    timeoutMs: parsePositiveInt(process.env.WEBHOOK_TIMEOUT_MS, 10_000),
    retryCount: parsePositiveInt(process.env.WEBHOOK_RETRY_COUNT, 2),
    retryBaseMs: parsePositiveInt(process.env.WEBHOOK_RETRY_BASE_MS, 1000),
    maxHistorySize: parsePositiveInt(process.env.WEBHOOK_MAX_HISTORY, 200),
    maxConcurrentDispatches: parsePositiveInt(
      process.env.WEBHOOK_MAX_CONCURRENT,
      5,
    ),
  };
}

export class WebhookService {
  private readonly emitter: WebhookEventEmitter;
  private readonly dispatcher: WebhookDispatcher;
  private readonly config: WebhookServiceConfig;
  private endpoints: Map<string, WebhookEndpoint> = new Map();
  private unsubscribe?: () => void;
  /** 最近一次调度结果（用于调试 / API 查询） */
  private recentDispatchResults: WebhookDispatchResult[] = [];
  private static readonly MAX_DISPATCH_RESULTS = 100;

  constructor(config?: WebhookServiceConfig) {
    this.config = config ?? resolveWebhookConfig();
    this.emitter = new WebhookEventEmitter(this.config.maxHistorySize);
    this.dispatcher = new WebhookDispatcher(this.config);
  }

  // ─── 生命周期 ───

  /** 启动服务：注册 emitter→dispatcher 桥接 + 加载默认端点 */
  start(): void {
    if (!this.config.enabled) {
      console.log("[Webhook] disabled (WEBHOOK_ENABLED != true)");
      return;
    }

    // emitter emit → 自动 dispatch 到所有匹配端点
    this.unsubscribe = this.emitter.subscribe((event) => {
      void this.onEvent(event);
    });

    // 从环境变量加载默认端点
    for (const url of this.config.defaultUrls) {
      this.addEndpoint({
        url,
        events: [], // 空数组 = 接收所有事件
        secret: this.config.secret || undefined,
        description: "default endpoint from WEBHOOK_URLS",
      });
    }

    console.log(
      `[Webhook] started | endpoints=${this.endpoints.size} | urls=[${[
        ...this.endpoints.values(),
      ]
        .map((e) => e.url)
        .join(", ")}]`,
    );
  }

  /** 关闭服务：取消订阅、清空端点引用 */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    console.log("[Webhook] stopped");
  }

  // ─── 事件发射（对外 API）─────────────────────────────

  /**
   * 发射一个 webhook 事件。
   * 这是业务代码调用的唯一入口。
   *
   * @example
   * ```ts
   * webhookService.emit("agent.online", { port: 3000, version: "1.0" });
   * webhookService.emit("agent.message_sent", { text: "你好！" }, { actorId: "user-001" });
   * ```
   */
  emit(
    type: WebhookEventType,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): WebhookEvent {
    if (!this.config.enabled) {
      // 即使未启用也返回 event 对象（便于测试和日志）
      return this.emitter.emit(type, data, opts);
    }
    return this.emitter.emit(type, data, opts);
  }

  // ─── 端点管理 ───

  addEndpoint(opts: {
    url: string;
    events?: WebhookEventType[];
    secret?: string;
    description?: string;
  }): WebhookEndpoint {
    const endpoint: WebhookEndpoint = {
      id: randomUUID(),
      url: opts.url,
      events: opts.events ?? [],
      secret: opts.secret,
      enabled: true,
      createdAt: new Date().toISOString(),
      description: opts.description,
    };
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  removeEndpoint(id: string): boolean {
    return this.endpoints.delete(id);
  }

  getEndpoint(id: string): WebhookEndpoint | undefined {
    return this.endpoints.get(id);
  }

  getAllEndpoints(): WebhookEndpoint[] {
    return [...this.endpoints.values()];
  }

  updateEndpoint(
    id: string,
    patch: Partial<Pick<WebhookEndpoint, "url" | "events" | "secret" | "enabled" | "description">>,
  ): WebhookEndpoint | null {
    const existing = this.endpoints.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.endpoints.set(id, updated);
    return updated;
  }

  // ─── 查询 ───

  getRecentEvents(limit = 50, typeFilter?: WebhookEventType): WebhookEvent[] {
    return this.emitter.recentEvents(limit, typeFilter);
  }

  getRecentDispatchResults(limit = 50): WebhookDispatchResult[] {
    return this.recentDispatchResults.slice(-limit);
  }

  getDispatcherStats(): { activeCount: number; endpointCount: number } {
    return {
      activeCount: this.dispatcher.activeCount,
      endpointCount: this.endpoints.size,
    };
  }

  getConfig(): Readonly<WebhookServiceConfig> {
    return this.config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ─── 内部：事件 → 调度桥接 ───

  private async onEvent(event: WebhookEvent): Promise<void> {
    const allEndpoints = [...this.endpoints.values()];
    if (allEndpoints.length === 0) return;

    const results = await this.dispatcher.dispatch(event, allEndpoints);

    // 记录调度结果
    this.recentDispatchResults.push(...results);
    if (this.recentDispatchResults.length > WebhookService.MAX_DISPATCH_RESULTS) {
      this.recentDispatchResults.splice(
        0,
        this.recentDispatchResults.length - WebhookService.MAX_DISPATCH_RESULTS,
      );
    }

    // 更新端点的 lastSuccessAt / lastError
    for (const result of results) {
      const ep = this.endpoints.get(result.endpointId);
      if (!ep) continue;
      if (result.success) {
        ep.lastSuccessAt = result.timestamp;
        ep.lastError = undefined;
      } else {
        ep.lastError = result.error;
      }
    }

    // 日志摘要
    const ok = results.filter((r) => r.success).length;
    const fail = results.length - ok;
    if (fail > 0) {
      console.warn(
        `[Webhook] dispatch ${event.type} → ${ok} ok, ${fail} fail`,
      );
    }
  }
}

// ─── 工具函数 ───

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
