/**
 * 预订 ↔ 日程联动端到端：book 两阶段自动建日程、cancel/reschedule 反向同步、
 * book 阶段一冲突预检透出 scheduleConflict。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BookingOrderStore,
  BookingService,
  SimulatedHomeServiceProvider,
} from "../src/services/booking/index.js";
import { ScheduleBookingBridge } from "../src/services/schedule-booking-bridge.js";
import { ScheduleConflictService } from "../src/services/schedule-conflict-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "bsess", userId: "buser" };

async function withBridgeBooking<T>(
  fn: (
    service: BookingService,
    tasks: ScheduleTaskService,
    dispose: () => void,
  ) => Promise<T>,
) {
  const dir = await mkdtemp(join(tmpdir(), "booking-schedule-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    const bridge = new ScheduleBookingBridge(tasks, conflicts);
    const service = new BookingService({
      providers: [new SimulatedHomeServiceProvider()],
      store: new BookingOrderStore(null),
      scheduleBridge: bridge,
      config: { maxAmountCny: 1000, dailyBudgetCny: 2000, confirmationTtlMs: 300_000 },
    });
    return await fn(service, tasks, () => service.dispose());
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 未来时间（相对真实时钟），保证桥接的「即时单跳过」不误伤。 */
function futureAt(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

async function bookHome(service: BookingService, scheduleAt: string) {
  const params = { serviceType: "cleaning", address: "望京SOHO" };
  const stage1 = await service.book(ctx, "home_service", {
    optionId: "clean-basic",
    params,
    scheduleAt,
    confirm: false,
  });
  assert.equal(stage1.ok, true);
  if (!stage1.ok) throw new Error("stage1 failed");
  const token = (stage1 as { confirmationToken: string }).confirmationToken;
  const stage2 = await service.book(ctx, "home_service", {
    optionId: "clean-basic",
    params,
    scheduleAt,
    confirm: true,
    confirmationToken: token,
  });
  assert.equal(stage2.ok, true);
  if (!stage2.ok) throw new Error("stage2 failed");
  return { stage1, stage2, token };
}

test("book 成功 → 自动创建关联日程；cancel → 日程反向取消", async () => {
  await withBridgeBooking(async (service, tasks, dispose) => {
    try {
      const scheduleAt = futureAt(48);
      const { stage2 } = await bookHome(service, scheduleAt);
      const orderId = (stage2 as { orderId: string }).orderId;

      const task = tasks.findTaskByBookingOrderId(orderId);
      assert.ok(task, "booking should create linked schedule task");
      assert.equal(task.source, "booking");
      assert.equal(task.sourceBookingOrderId, orderId);
      assert.equal(task.sessionId, "buser");
      assert.equal(task.durationMinutes, 120); // clean-basic = 2 小时
      assert.deepEqual(task.remindBeforeMinutes, [30]);
      assert.ok(task.title?.startsWith("【家政/本地生活】"));

      const cancel1 = await service.cancel(ctx, "home_service", orderId, false);
      assert.equal(cancel1.ok, true);
      const cancel2 = await service.cancel(
        ctx,
        "home_service",
        orderId,
        true,
        (cancel1 as { confirmationToken: string }).confirmationToken,
        "不需要了",
      );
      assert.equal(cancel2.ok, true);

      // 反向同步：日程已取消（findTaskByBookingOrderId 排除 cancelled）
      assert.equal(tasks.findTaskByBookingOrderId(orderId), undefined);
      const stillThere = tasks.getTask(task.taskId);
      assert.equal(stillThere?.status, "cancelled");
    } finally {
      dispose();
    }
  });
});

test("reschedule → 关联日程时间同步更新", async () => {
  await withBridgeBooking(async (service, tasks, dispose) => {
    try {
      const { stage2 } = await bookHome(service, futureAt(48));
      const orderId = (stage2 as { orderId: string }).orderId;
      const task = tasks.findTaskByBookingOrderId(orderId);
      assert.ok(task);

      const newAt = futureAt(96);
      const rescheduled = await service.reschedule(ctx, "home_service", orderId, newAt);
      assert.equal(rescheduled.ok, true);

      const updated = tasks.getTask(task.taskId);
      assert.ok(updated);
      assert.equal(Date.parse(updated.runAt), Date.parse(newAt));
      assert.equal(Date.parse(updated.nextRunAt ?? ""), Date.parse(newAt));
    } finally {
      dispose();
    }
  });
});

test("book 阶段一：与既有日程冲突时透出 scheduleConflict，用户坚持仍可下单", async () => {
  await withBridgeBooking(async (service, tasks, dispose) => {
    try {
      const scheduleAt = futureAt(48);
      // 用户已有同区间日程
      await tasks.createTask({
        sessionId: "buser",
        title: "重要会议",
        description: "重要会议",
        kind: "reminder",
        category: "itinerary",
        runAt: scheduleAt,
        durationMinutes: 60,
        recurrence: "none",
        timezone: "Asia/Shanghai",
        reminderMessage: "重要会议",
      });

      const params = { serviceType: "cleaning", address: "望京SOHO" };
      const stage1 = await service.book(ctx, "home_service", {
        optionId: "clean-basic",
        params,
        scheduleAt,
        confirm: false,
      });
      assert.equal(stage1.ok, true);
      const s1 = stage1 as Record<string, unknown>;
      assert.ok(s1.scheduleConflict, "stage1 should surface scheduleConflict");
      const conflict = s1.scheduleConflict as { conflict: boolean; conflicts: Array<Record<string, unknown>> };
      assert.equal(conflict.conflict, true);
      assert.equal(conflict.conflicts[0].title, "重要会议");
      assert.match(String(s1.summary), /冲突/);

      // 用户坚持 → 阶段二照常下单并建日程
      const stage2 = await service.book(ctx, "home_service", {
        optionId: "clean-basic",
        params,
        scheduleAt,
        confirm: true,
        confirmationToken: String(s1.confirmationToken),
      });
      assert.equal(stage2.ok, true);
      if (stage2.ok) {
        const orderId = (stage2 as { orderId: string }).orderId;
        assert.ok(tasks.findTaskByBookingOrderId(orderId));
      }
    } finally {
      dispose();
    }
  });
});
