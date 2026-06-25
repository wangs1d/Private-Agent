/**
 * Webhook 事件类型 — 与 HookBus 共用枚举
 *
 * 整个项目对"事件类型"只有一份事实来源（WebhookEventType），
 * 业务代码用 HookBus.emit() 发射事件，WebhookService 在 start() 时
 * 自动订阅并把匹配的事件外推到已注册端点。
 */
import type { HookEvent, WebhookEventType } from "../hooks/hook-types.js";

export type { WebhookEventType } from "../hooks/hook-types.js";

/** 向后兼容：旧代码仍可能引用 WebhookEvent，等价于 HookEvent */
export type WebhookEvent = HookEvent;

/** 已注册的 Webhook 端点配置 */
export type WebhookEndpoint = {
  id: string;
  url: string;
  /** 空数组 = 接收所有事件；非空 = 仅接收匹配类型的事件 */
  events: WebhookEventType[];
  /** 可选：HMAC-SHA256 签名密钥（不填则不签名） */
  secret?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  createdAt: string;
  /** 统计：最近一次成功推送时间 */
  lastSuccessAt?: string;
  /** 统计：最近一次失败原因 */
  lastError?: string;
  /** 创建者备注 */
  description?: string;
};

/** Webhook 调度结果 */
export type WebhookDispatchResult = {
  endpointId: string;
  url: string;
  success: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
  timestamp: string;
};

/** Webhook 服务配置（从环境变量读取） */
export type WebhookServiceConfig = {
  enabled: boolean;
  /** 默认端点 URL 列表（逗号分隔） */
  defaultUrls: string[];
  /** 默认签名密钥 */
  secret: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 失败重试次数 */
  retryCount: number;
  /** 重试间隔基数（毫秒，指数退避） */
  retryBaseMs: number;
  /** 事件历史最大保留条数 */
  maxHistorySize: number;
  /** 并发调度上限 */
  maxConcurrentDispatches: number;
};
