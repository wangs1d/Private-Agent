/**
 * Hook 总线 — 类型定义
 *
 * Hook 是"业务域事件"的统一抽象。新功能只需 emit 一个 hook，框架会自动：
 * 1. 记录到事件历史（环形缓冲）
 * 2. 推送到已注册的下游订阅者（默认：WebhookService）
 * 3. 推送到所有匹配事件类型白名单的 Webhook 端点
 *
 * 新功能接入零成本：不需要知道 WebhookService 的存在，
 * 也不需要在 bootstrap 里手动 wire 任何东西。
 *
 * ⚠️ 事件类型枚举是项目内单一事实来源，编译时强类型校验。
 * 新增事件类型必须先在此枚举中追加，业务代码才能 emit。
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
  // ─── 监控/价格/数据 信号事件（外部系统接入价格/数据 webhook 后触发）───
  | "market.position_snapshot"   // 持仓快照（价格/盈亏/波动率）
  | "market.anomaly"             // 价格/成交量异动
  | "data.threshold_breach"      // 通用数据阈值突破
  | "data.source_heartbeat"      // 外部数据源心跳/在线状态
  | "custom";                    // 用户自定义事件

/** 复用 WebhookEventType 作为 hook 事件类型枚举，保证两端契约一致 */
export type HookEventType = WebhookEventType;

/** 单次 hook 发射产生的事件 */
export type HookEvent<T = Record<string, unknown>> = {
  id: string;                // uuid v7
  type: HookEventType;
  timestamp: string;         // ISO 8601
  actorId?: string;
  source?: string;           // 业务模块名，便于调试
  data: T;
  metadata?: {
    source?: string;
    version?: string;
    [key: string]: unknown;
  };
};

/** hook 订阅者回调 */
export type HookHandler<T = Record<string, unknown>> = (
  event: HookEvent<T>,
) => Promise<void> | void;

/** emit() 的可选项 */
export type HookEmitOptions = {
  actorId?: string;
  source?: string;
  version?: string;
};

/** Feature 声明式注册：用于新功能批量声明其 hook 触发点 */
export type FeatureHookSpec<T = Record<string, unknown>> = {
  type: HookEventType;
  description: string;
  /** 可选：data 的运行时类型守卫（仅做日志/校验用，不强制） */
  validate?: (data: T) => boolean;
};

/** 声明一个 feature 的全部 hook */
export type FeatureHookManifest = {
  feature: string;
  hooks: FeatureHookSpec[];
};
