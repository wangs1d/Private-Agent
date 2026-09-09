/**
 * 预订 ↔ 日程联动桥（程序层）：
 *
 *   - book 成功 → 自动生成 source=booking 的日程（含服务时长区间 + 提前 30 分钟提醒）
 *   - cancel 成功 → 反向取消关联日程（按 sourceBookingOrderId 定位）
 *   - reschedule 成功 → 反向改期关联日程
 *   - book 阶段一 → 冲突预检（结果透出给 LLM 转述，用户坚持仍可继续下单）
 *
 * 设计约束：桥接失败绝不阻断预订主链路（全部 try/catch，返回可选的告警字段）。
 */

import type { BookingDomain } from "./booking/booking-provider.js";
import type { StoredBookingOrder } from "./booking/booking-order-store.js";
import { ScheduleConflictService, buildConflictToolResult } from "./schedule-conflict-service.js";
import type { ScheduleTaskRecord, ScheduleTaskService } from "./schedule-task-service.js";

const BOOKING_DOMAIN_LABELS: Record<BookingDomain, string> = {
  ride: "网约车",
  home_service: "家政/本地生活",
  restaurant: "餐厅预订",
  travel: "旅行票务",
};

/** 预订日程统一提前量（分钟）：上门/到店/出发前 30 分钟各提醒一次。 */
const BOOKING_PRE_REMINDER_MINUTES = [30];

export type BookingConflictPrecheck =
  | { conflict: false }
  | { conflict: true; toolResult: Record<string, unknown> };

export class ScheduleBookingBridge {
  constructor(
    private readonly tasks: ScheduleTaskService,
    private readonly conflicts: ScheduleConflictService,
  ) {}

  /** book 阶段一冲突预检：无服务时间/无时长直接放行。 */
  precheckBookConflict(
    order: Pick<StoredBookingOrder, "actorId" | "scheduleAt">,
    durationMinutes: number | null | undefined,
    timezone: string,
  ): BookingConflictPrecheck {
    if (!order.scheduleAt || !durationMinutes || durationMinutes <= 0) return { conflict: false };
    const list = this.conflicts.findConflicts({
      sessionId: order.actorId,
      runAt: order.scheduleAt,
      durationMinutes,
    });
    if (list.length === 0) return { conflict: false };
    return {
      conflict: true,
      toolResult: buildConflictToolResult(list, { timezone }),
    };
  }

  /** 下单成功 → 创建关联日程；时间已过（即时单）或已存在则跳过。返回日程（可能 null）。 */
  async onBooked(
    order: StoredBookingOrder,
    opts: { timezone: string; durationMinutes?: number | null },
  ): Promise<ScheduleTaskRecord | null> {
    if (!order.scheduleAt) return null;
    if (new Date(order.scheduleAt).getTime() <= Date.now() + 60_000) return null;
    if (this.tasks.findTaskByBookingOrderId(order.orderId)) return null;
    const label = BOOKING_DOMAIN_LABELS[order.domain] ?? order.domain;
    const reminderMessage = opts.durationMinutes
      ? `${label}：${order.title}（约 ${Math.round(opts.durationMinutes / 60 * 10) / 10} 小时）`
      : `${label}：${order.title}`;
    return this.tasks.createTask({
      sessionId: order.actorId,
      title: `【${label}】${order.title}`,
      shortTitle: order.title.slice(0, 12),
      description: `预订订单 ${order.orderId} 自动创建的日程`,
      kind: "reminder",
      category: "itinerary",
      runAt: order.scheduleAt,
      recurrence: "none",
      timezone: opts.timezone,
      reminderMessage,
      durationMinutes: opts.durationMinutes ?? undefined,
      remindBeforeMinutes: BOOKING_PRE_REMINDER_MINUTES,
      source: "booking",
      sourceBookingOrderId: order.orderId,
    });
  }

  /** 取消成功 → 反向取消关联日程。 */
  async onCancelled(order: StoredBookingOrder): Promise<ScheduleTaskRecord | null> {
    const task = this.tasks.findTaskByBookingOrderId(order.orderId);
    if (!task || task.status === "cancelled" || task.status === "completed") return null;
    return this.tasks.updateTask(task.taskId, { status: "cancelled" });
  }

  /** 改期成功 → 反向更新关联日程时间。 */
  async onRescheduled(
    order: StoredBookingOrder,
    scheduleAt: string,
  ): Promise<ScheduleTaskRecord | null> {
    const task = this.tasks.findTaskByBookingOrderId(order.orderId);
    if (!task || task.status !== "active") return null;
    if (new Date(scheduleAt).getTime() <= Date.now() + 5_000) return null;
    return this.tasks.updateTask(task.taskId, { runAt: scheduleAt });
  }
}
