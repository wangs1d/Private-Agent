/**
 * Webhook 服务 — 事件驱动推送的顶层入口
 *
 * 新设计：WebhookService 不再维护自己的事件总线。
 * 它是全局 HookBus 的一个订阅者，业务代码只 emit hook，
 * WebhookService 在 start() 时自动订阅并把所有匹配的 hook
 * 推送到已注册的外部端点。
 *
 * 这种解耦让"接入 webhook"成为零成本操作：
 * 1. 新功能不需要知道 WebhookService 存在
 * 2. 新功能不需要在 bootstrap 阶段手动 wire
 * 3. 只要往 HookBus emit 事件，webhook 推送就自动生效
 *
 * 仍保留的能力：
 * - 端点 CRUD 管理（/api/webhooks）
 * - HMAC-SHA256 签名、并发控制、指数退避重试
 * - 调度结果与统计观测
 * - 事件历史查询（从 hookBus 读取）
 */
import { randomUUID } from "node:crypto";
import { WebhookDispatcher } from "./webhook-dispatcher.js";
import type { HookBus } from "../hooks/hook-bus.js";
import type { HookEvent, HookHandler } from "../hooks/hook-types.js";
import type {
  WebhookEndpoint,
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
  private readonly dispatcher: WebhookDispatcher;
  private readonly config: WebhookServiceConfig;
  private readonly hookBus: HookBus;
  private endpoints: Map<string, WebhookEndpoint> = new Map();
  private unsubscribe?: () => void;
  /** 最近一次调度结果（用于调试 / API 查询） */
  private recentDispatchResults: WebhookDispatchResult[] = [];
  private static readonly MAX_DISPATCH_RESULTS = 100;

  constructor(hookBus: HookBus, config?: WebhookServiceConfig) {
    this.hookBus = hookBus;
    this.config = config ?? resolveWebhookConfig();
    this.dispatcher = new WebhookDispatcher(this.config);
  }

  // ─── 生命周期 ───

  /**
   * 启动服务：
   * 1. 订阅全局 HookBus（所有 hook 都会过这里）
   * 2. 加载环境变量中的默认端点
   *
   * 新功能只要 emit hook 就会自动被推送到所有已注册端点。
   */
  start(): void {
    if (!this.config.enabled) {
      console.log("[Webhook] disabled (WEBHOOK_ENABLED != true)");
      return;
    }

    // 把所有 hook 转成 webhook 事件，自动 dispatch
    const handler: HookHandler = (event) => {
      void this.onHookEvent(event);
    };
    this.unsubscribe = this.hookBus.subscribe(handler);

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

  /** 最近 hook 事件（从 HookBus 读取，业务代码 emit 的所有事件都可见） */
  getRecentEvents(limit = 50, typeFilter?: WebhookEventType): HookEvent[] {
    return this.hookBus.recentEvents(limit, typeFilter);
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

  // ─── 内部：hook → 调度桥接 ───

  private async onHookEvent(event: HookEvent): Promise<void> {
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
