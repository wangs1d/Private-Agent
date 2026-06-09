/**
 * Webhook 事件驱动系统 — 类型定义
 *
 * 基于 Agent 生命周期事件（上线、下线、错误等）向外推送 HTTP 回调。
 * 设计对齐 GitHub / Discord 风格的 webhook payload 结构。
 */

/** Agent 可对外暴露的所有内置事件类型 */
export type WebhookEventType =
  | "agent.online"        // Agent 服务启动完成，准备就绪
  | "agent.offline"       // Agent 服务即将关闭
  | "agent.error"         // Agent 运行时发生未捕获错误
  | "agent.message_sent"  // Agent 向用户发送了消息
  | "agent.message_received" // Agent 收到用户消息
  | "agent.task_started"  // Agent 开始执行任务
  | "agent.task_completed" // Agent 任务执行完成
  | "agent.task_failed"   // Agent 任务执行失败
  | "agent.tool_called"   // Agent 调用了工具
  | "schedule.reminder_fired" // 日程提醒触发
  | "life.signal"         // 生命信号产生
  | "custom";             // 用户自定义事件

/** 单次 Webhook 推送的事件载荷 */
export type WebhookEvent = {
  id: string;              // 全局唯一事件 ID (uuid v7)
  type: WebhookEventType;  // 事件类型
  timestamp: string;       // ISO 8601 (服务器时间)
  actorId?: string;        // 关联的用户/会话 ID
  data: Record<string, unknown>; // 事件业务数据
  metadata?: {
    source?: string;       // 事件来源模块
    version?: string;      // payload 版本号
    [key: string]: unknown;
  };
};

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
