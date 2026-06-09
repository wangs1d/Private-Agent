/**
 * Webhook HTTP 调度器 — 负责将事件 POST 到已注册的端点
 *
 * 能力：
 * - 并发调度（信号量控制并发上限）
 * - 指数退避重试
 * - HMAC-SHA256 签名（可选，对齐 GitHub webhook secret 风格）
 * - 事件类型过滤（端点级别 events 白名单）
 */
import { createHmac } from "node:crypto";
import type {
  WebhookEndpoint,
  WebhookEvent,
  WebhookDispatchResult,
  WebhookServiceConfig,
} from "./webhook-event-types.js";

export class WebhookDispatcher {
  private readonly config: WebhookServiceConfig;
  private activeDispatches = 0;

  constructor(config: WebhookServiceConfig) {
    this.config = config;
  }

  /** 当前正在调度的请求数 */
  get activeCount(): number {
    return this.activeDispatches;
  }

  /**
   * 将事件分发到所有匹配的已启用端点。
   * 返回每个端点的调度结果（不抛异常，结果中携带错误信息）。
   */
  async dispatch(
    event: WebhookEvent,
    endpoints: readonly WebhookEndpoint[],
  ): Promise<WebhookDispatchResult[]> {
    const matched = endpoints.filter(
      (ep) =>
        ep.enabled &&
        (ep.events.length === 0 || ep.events.includes(event.type)),
    );

    if (matched.length === 0) return [];

    // 并发控制
    const slots = this.config.maxConcurrentDispatches;
    const results: WebhookDispatchResult[] = [];

    const dispatchOne = async (
      endpoint: WebhookEndpoint,
    ): Promise<WebhookDispatchResult> => {
      this.activeDispatches++;
      try {
        return await this.dispatchToEndpoint(event, endpoint);
      } finally {
        this.activeDispatches--;
      }
    };

    // 分批并发
    for (let i = 0; i < matched.length; i += slots) {
      const batch = matched.slice(i, i + slots);
      const batchResults = await Promise.all(batch.map(dispatchOne));
      results.push(...batchResults);
    }

    return results;
  }

  /** 向单个端点发送请求，含重试逻辑 */
  private async dispatchToEndpoint(
    event: WebhookEvent,
    endpoint: WebhookEndpoint,
  ): Promise<WebhookDispatchResult> {
    const startTime = Date.now();
    const payload = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "PrivateAI-Agent-Webhook/1.0",
      "X-Webhook-Event": event.type,
      "X-Webhook-ID": event.id,
    };

    // HMAC-SHA256 签名（对齐 GitHub: X-Hub-Signature-256）
    if (endpoint.secret) {
      const sig = this.signPayload(payload, endpoint.secret);
      headers["X-Webhook-Signature-256"] = sig;
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      if (attempt > 0) {
        // 指数退避
        const delay = this.config.retryBaseMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const response = await fetch(endpoint.url, {
          method: "POST",
          headers,
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;

        if (response.ok) {
          return {
            endpointId: endpoint.id,
            url: endpoint.url,
            success: true,
            statusCode: response.status,
            latencyMs,
            timestamp: new Date().toISOString(),
          };
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // AbortError 是超时，不再重试
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = `timeout after ${this.config.timeoutMs}ms`;
          break;
        }
      }
    }

    return {
      endpointId: endpoint.id,
      url: endpoint.url,
      success: false,
      latencyMs: Date.now() - startTime,
      error: lastError,
      timestamp: new Date().toISOString(),
    };
  }

  /** HMAC-SHA256 签名：hex(sha256(secret + body)) */
  private signPayload(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
