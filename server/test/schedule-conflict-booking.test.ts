/**
 * 日程冲突检测 + 预订↔日程联动桥 + 提前量多偏移提醒 的单测。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ScheduleConflictService,
  precheckCreateConflict,
  resolveRunAtToUtcIso,
} from "../src/services/schedule-conflict-service.js";
import { ScheduleBookingBridge } from "../src/services/schedule-booking-bridge.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import type { StoredBookingOrder } from "../src/services/booking/booking-order-store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withServices<T>(fn: (tasks: ScheduleTaskService, conflicts: ScheduleConflictService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-conflict-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    return await fn(tasks, conflicts);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function makeOrder(overrides: Partial<StoredBookingOrder> = {}): StoredBookingOrder {
  return {
    orderId: `bkg_test_${Math.random().toString(36).slice(2, 8)}`,
    actorId: "actor-1",
    domain: "home_service",
    provider: "simulated",
    providerOrderId: null,
    title: "深度保洁",
    amountCny: 200,
    status: "confirmed",
    scheduleAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    deadline: null,
    params: {},
    paymentUrl: null,
    commitmentId: null,
    simulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --------------------------------------------------------------------------- //
// resolveRunAtToUtcIso
// --------------------------------------------------------------------------- //

test("resolveRunAtToUtcIso: explicit Z passes through, naive wall-clock uses timezone", () => {
  assert.equal(resolveRunAtToUtcIso("2099-03-05T01:30:00Z", "Asia/Shanghai"), "2099-03-05T01:30:00.000Z");
  assert.equal(resolveRunAtToUtcIso("2099-03-05T09:30:00", "Asia/Shanghai"), "2099-03-05T01:30:00.000Z");
  assert.equal(resolveRunAtToUtcIso("2099-03-05 09:30", "Asia/Shanghai"), "2099-03-05T01:30:00.000Z");
  assert.equal(resolveRunAtToUtcIso("", "Asia/Shanghai"), null);
});

// --------------------------------------------------------------------------- //
// findConflicts
// --------------------------------------------------------------------------- //

test("findConflicts: overlapping timed events report overlap minutes", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "会议",
      description: "已有会议",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T01:00:00Z",
      durationMinutes: 60,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "会议",
    });
    const hits = conflicts.findConflicts({
      sessionId: "s1",
      runAt: "2099-03-05T01:30:00Z",
      durationMinutes: 60,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "会议");
    assert.equal(hits[0].overlapMinutes, 30);
  });
});

test("findConflicts: adjacent intervals do not conflict; zero-duration candidate skipped", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "会议",
      description: "已有会议",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T01:00:00Z",
      durationMinutes: 60,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "会议",
    });
    // 10:00(UTC 02:00) 开始 = 既有事件结束时刻，边界相接不算冲突
    assert.equal(
      conflicts.findConflicts({ sessionId: "s1", runAt: "2099-03-05T02:00:00Z", durationMinutes: 60 }).length,
      0,
    );
    // 零时长候选（时间点提醒）不参与冲突
    assert.equal(conflicts.findConflicts({ sessionId: "s1", runAt: "2099-03-05T01:30:00Z" }).length, 0);
  });
});

test("findConflicts: zero-duration point strictly inside timed event conflicts", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "喝水点",
      description: "时间点提醒",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T01:30:00Z",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "喝水点",
    });
    const hits = conflicts.findConflicts({
      sessionId: "s1",
      runAt: "2099-03-05T01:00:00Z",
      durationMinutes: 60,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].overlapMinutes, 0);
  });
});

test("findConflicts: trivia tasks never conflict; excludeTaskId skips self", async () => {
  await withServices(async (tasks, conflicts) => {
    const trivia = await tasks.createTask({
      sessionId: "s1",
      title: "喝水",
      description: "喝水",
      kind: "reminder",
      category: "trivia",
      runAt: "2099-03-05T01:30:00Z",
      durationMinutes: 30,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "喝水",
    });
    assert.equal(
      conflicts.findConflicts({ sessionId: "s1", runAt: "2099-03-05T01:00:00Z", durationMinutes: 60 }).length,
      0,
    );
    const mine = await tasks.createTask({
      sessionId: "s1",
      title: "我的会",
      description: "自身",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T05:00:00Z",
      durationMinutes: 60,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "我的会",
    });
    assert.equal(
      conflicts.findConflicts({ sessionId: "s1", runAt: "2099-03-05T05:00:00Z", durationMinutes: 60, excludeTaskId: mine.taskId }).length,
      0,
    );
    assert.equal(trivia.status, "active");
  });
});

test("findConflicts: recurring daily task conflicts on later occurrence", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "晨会",
      description: "每天重复",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-01T01:00:00Z",
      durationMinutes: 60,
      recurrence: "daily",
      timezone: "Asia/Shanghai",
      reminderMessage: "晨会",
    });
    // 3 月 6 日同一时刻的候选应命中该周期任务
    const hits = conflicts.findConflicts({
      sessionId: "s1",
      runAt: "2099-03-06T01:30:00Z",
      durationMinutes: 30,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].recurrence, "daily");
  });
});

// --------------------------------------------------------------------------- //
// precheckCreateConflict
// --------------------------------------------------------------------------- //

test("precheckCreateConflict: naive wall-clock resolved in user timezone", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "既有",
      description: "既有",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T01:00:00Z",
      durationMinutes: 60,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "既有",
    });
    // 无时长 → 放行
    assert.equal(
      precheckCreateConflict(conflicts, { sessionId: "s1", runAt: "2099-03-05 09:30", timezone: "Asia/Shanghai" }),
      null,
    );
    // forceCreate → 放行
    assert.equal(
      precheckCreateConflict(conflicts, {
        sessionId: "s1",
        runAt: "2099-03-05 09:30",
        durationMinutes: 60,
        timezone: "Asia/Shanghai",
        forceCreate: true,
      }),
      null,
    );
    // 裸墙钟 09:30(+08) = 01:30Z，与 01:00–02:00Z 冲突
    const result = precheckCreateConflict(conflicts, {
      sessionId: "s1",
      runAt: "2099-03-05 09:30",
      durationMinutes: 60,
      timezone: "Asia/Shanghai",
    });
    assert.ok(result);
    assert.equal(result.conflict, true);
    assert.equal(result.matched, false);
    const list = result.conflicts as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "既有");
  });
});

// --------------------------------------------------------------------------- //
// findFreeSlots
// --------------------------------------------------------------------------- //

test("findFreeSlots: carves busy intervals out of the daily window", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "占用",
      description: "10:00-12:00 占用",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T02:00:00Z", // 10:00 +08
      durationMinutes: 120,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "占用",
    });
    const slots = conflicts.findFreeSlots({
      sessionId: "s1",
      durationMinutes: 60,
      from: "2099-03-05T00:00:00Z",
      to: "2099-03-06T00:00:00Z",
      timezone: "Asia/Shanghai",
    });
    // 窗口 09:00–21:00，busy 10:00–12:00 → 09:00–10:00 与 12:00–21:00
    assert.equal(slots.length, 2);
    assert.equal(slots[0].startAt, "2099-03-05T01:00:00.000Z");
    assert.equal(slots[0].endAt, "2099-03-05T02:00:00.000Z");
    assert.equal(slots[1].startAt, "2099-03-05T04:00:00.000Z");
    assert.equal(slots[1].durationMinutes, 540);
  });
});

test("findFreeSlots: no slot when demand exceeds gaps", async () => {
  await withServices(async (tasks, conflicts) => {
    await tasks.createTask({
      sessionId: "s1",
      title: "全天占用",
      description: "全天",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T00:00:00Z",
      durationMinutes: 14 * 60,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "全天",
    });
    const slots = conflicts.findFreeSlots({
      sessionId: "s1",
      durationMinutes: 60,
      from: "2099-03-05T00:00:00Z",
      to: "2099-03-05T23:00:00Z",
      timezone: "Asia/Shanghai",
    });
    assert.equal(slots.length, 0);
  });
});

// --------------------------------------------------------------------------- //
// ScheduleBookingBridge
// --------------------------------------------------------------------------- //

test("bridge onBooked creates linked schedule; duplicate order skipped; past time skipped", async () => {
  await withServices(async (tasks, conflicts) => {
    const bridge = new ScheduleBookingBridge(tasks, conflicts);
    const order = makeOrder();
    const task = await bridge.onBooked(order, { timezone: "Asia/Shanghai", durationMinutes: 90 });
    assert.ok(task);
    assert.equal(task.source, "booking");
    assert.equal(task.sourceBookingOrderId, order.orderId);
    assert.equal(task.durationMinutes, 90);
    assert.deepEqual(task.remindBeforeMinutes, [30]);
    assert.ok(task.title?.includes("家政/本地生活"));
    assert.ok(task.reminderMessage?.includes("1.5 小时"));

    // 同订单重复下单 → 跳过
    assert.equal(await bridge.onBooked(order, { timezone: "Asia/Shanghai", durationMinutes: 90 }), null);
    // 时间已过（即时单）→ 跳过
    const past = makeOrder({ scheduleAt: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(await bridge.onBooked(past, { timezone: "Asia/Shanghai" }), null);
    // 无服务时间 → 跳过
    const noTime = makeOrder({ scheduleAt: null });
    assert.equal(await bridge.onBooked(noTime, { timezone: "Asia/Shanghai" }), null);
  });
});

test("bridge onCancelled and onRescheduled reverse-sync the linked schedule", async () => {
  await withServices(async (tasks, conflicts) => {
    const bridge = new ScheduleBookingBridge(tasks, conflicts);
    const order = makeOrder();
    const task = await bridge.onBooked(order, { timezone: "Asia/Shanghai", durationMinutes: 60 });
    assert.ok(task);

    const newAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
    const updated = await bridge.onRescheduled(order, newAt);
    assert.ok(updated);
    assert.equal(updated.runAt, newAt);
    assert.equal(updated.nextRunAt, newAt);

    const cancelled = await bridge.onCancelled(order);
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");
    // 已取消 → 幂等跳过
    assert.equal(await bridge.onCancelled(order), null);
  });
});

test("bridge precheckBookConflict flags overlap only when duration present", async () => {
  await withServices(async (tasks, conflicts) => {
    const bridge = new ScheduleBookingBridge(tasks, conflicts);
    await tasks.createTask({
      sessionId: "actor-1",
      title: "既有安排",
      description: "既有",
      kind: "reminder",
      category: "itinerary",
      runAt: "2099-03-05T01:00:00Z",
      durationMinutes: 60,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "既有安排",
    });
    assert.equal(bridge.precheckBookConflict({ actorId: "actor-1", scheduleAt: "2099-03-05T01:30:00Z" }, null, "Asia/Shanghai").conflict, false);
    const hit = bridge.precheckBookConflict(
      { actorId: "actor-1", scheduleAt: "2099-03-05T01:30:00Z" },
      60,
      "Asia/Shanghai",
    );
    assert.equal(hit.conflict, true);
    if (hit.conflict) {
      const list = hit.toolResult.conflicts as Array<Record<string, unknown>>;
      assert.equal(list[0].title, "既有安排");
    }
  });
});

// --------------------------------------------------------------------------- //
// 提前量提醒：多偏移全部触发
// --------------------------------------------------------------------------- //

test("firePreReminders: all due offsets fire in one tick (15+5 both due)", async () => {
  await withServices(async (tasks) => {
    const fired: string[] = [];
    tasks.setReminderHandler(async (_task, message) => {
      fired.push(message);
    });
    // 4 分钟后触发：15 与 5 分钟两个偏移都已到期
    await tasks.createTask({
      sessionId: "s-pre",
      title: "面试",
      description: "面试提醒",
      kind: "reminder",
      category: "itinerary",
      runAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "该去面试了",
      remindBeforeMinutes: [15, 5],
    });
    tasks.startScheduler();
    try {
      await sleep(2_500);
      assert.ok(fired.includes("【提前15分钟】该去面试了"), `missing 15-min pre-reminder: ${JSON.stringify(fired)}`);
      assert.ok(fired.includes("【提前5分钟】该去面试了"), `missing 5-min pre-reminder: ${JSON.stringify(fired)}`);
      // 不重复触发
      const before = fired.length;
      await sleep(2_000);
      assert.equal(fired.length, before);
    } finally {
      tasks.stopScheduler();
    }
  });
});
