// Task 20 生活节律引擎测试：
//  1. 维度模型器：睡眠中位数窗口/同日去重、加班按星期聚合幂等、接受度 EWMA
//  2. ProfileStore：落盘回读 + 半损坏数据归一化
//  3. 引擎主循环：collect → ingest → insights → 消费方通知，失败隔离
//  4. 出口 A：睡觉提醒锚定学习窗口渐进重排（±15min/次）、pinned/低样本不动作
//  5. 出口 B/C：receptiveHours 回填、关怀信号限频
//  6. 在线回灌：recordContactOutcome / recordReminderFeedback
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LifeRhythmEngine } from "../src/rhythm/engine.js";
import { RhythmProfileStore } from "../src/rhythm/profile-store.js";
import { SleepDimensionModel } from "../src/rhythm/dimensions/sleep-model.js";
import { OvertimeDimensionModel, LATE_DAY_HOUR } from "../src/rhythm/dimensions/overtime-model.js";
import { ReceptivityDimensionModel } from "../src/rhythm/dimensions/receptivity-model.js";
import { FocusDimensionModel } from "../src/rhythm/dimensions/focus-model.js";
import { buildInsights } from "../src/rhythm/insights.js";
import { SleepWindowSensor } from "../src/rhythm/sensors/sleep-window-sensor.js";
import { createReminderReschedulerConsumer, presetOfTask } from "../src/rhythm/consumers/reminder-rescheduler.js";
import { createReceptiveHoursWriterConsumer } from "../src/rhythm/consumers/receptive-hours-writer.js";
import { createProactiveCandidateSourceConsumer } from "../src/rhythm/consumers/proactive-candidate-source.js";
import { NightlyRhythmAnalyzer } from "../src/rhythm/nightly-rhythm-analyzer.js";
import { circularHourDiff, formatHour } from "../src/rhythm/time-utils.js";
import { RHYTHM_MARK } from "../src/services/schedule-task-service.js";
import type { ScheduleTaskRecord } from "../src/services/schedule-task-service.js";
import type { RhythmObservation, RhythmProfileUpdate, RhythmSensor } from "../src/rhythm/types.js";

const ACTOR = "actor-rhythm-test";
const NOW = new Date("2026-09-03T19:00:00+08:00");

// ── 1. 维度模型器 ──────────────────────────────

test("睡眠模型器：中位数窗口 + 同日样本去重", () => {
  const model = new SleepDimensionModel();
  const mkObs = (date: string, start: number, end: number): RhythmObservation => ({
    dimension: "sleep",
    at: `${date}T12:00:00`,
    value: start,
    value2: end,
    kind: "sleep_sample",
    source: "test",
  });
  let state = model.ingest(null, [mkObs("2026-09-01", 23.5, 7), mkObs("2026-09-01", 1.2, 8)], { now: NOW });
  state = model.ingest(state, [
    mkObs("2026-09-02", 0.8, 8.2),
    mkObs("2026-09-03", 1.0, 8.5),
    mkObs("2026-09-04", 0.6, 7.8),
  ], { now: NOW });
  // 同日去重：9-1 保留最新（1.2），共 4 个样本
  assert.equal(state.sampleCount, 4);
  // 4 样本中位数 = (0.8 + 1.0) / 2
  assert.equal(state.windowStartHour, 0.9);
  // 趋势：需要 ≥2 个历史样本，4 样本时 prior 只有 1 个 → 尚无趋势
  assert.equal(state.trendMinutes, 0);
  // 7 样本满置信
  assert.ok(model.confidence(state) < 1);
  state = model.ingest(state, [
    mkObs("2026-08-25", 23.6, 7.1), mkObs("2026-08-26", 23.7, 7.2), mkObs("2026-08-27", 23.4, 7.3),
  ], { now: NOW });
  assert.equal(state.sampleCount, 7);
  assert.equal(model.confidence(state), 1);
  // 跨午夜趋势：之前 4 晚 23.4-1.2（修正后中位 23.65）→ 近 3 晚 0.6-1.0
  // （修正后中位 24.8）：入睡比之前晚约 69 分钟
  assert.equal(state.trendMinutes, 69);
});

test("加班模型器：按星期聚合晚归位，重复分析同日幂等", () => {
  const model = new OvertimeDimensionModel();
  const mkObs = (iso: string, hour: number): RhythmObservation => ({
    dimension: "overtime",
    at: iso,
    value: hour,
    kind: "desktop_active",
    source: "test",
  });
  // 周五晚归（2026-08-28 周五）+ 周五早走（2026-09-04 周五）
  const observations = [
    mkObs("2026-08-28T21:30:00+08:00", LATE_DAY_HOUR + 0.5),
    mkObs("2026-08-28T09:30:00+08:00", 9.5),
    mkObs("2026-09-04T18:30:00+08:00", 18.5),
  ];
  const state1 = model.ingest(null, observations, { now: NOW });
  const state2 = model.ingest(state1, observations, { now: NOW });
  assert.equal(state2.totalDays, state1.totalDays, "同日重复分析不叠加");
  // 周五 2 天中 1 天晚归
  assert.equal(state2.weekdayDays[5], 2);
  assert.equal(state2.byWeekday[5], 0.5);
  assert.equal(state2.byWeekday[1], 0);
});

test("接受度模型器：EWMA 更新对应小时", () => {
  const model = new ReceptivityDimensionModel();
  let state = model.ingest(null, [
    { dimension: "receptivity", at: "2026-09-01T10:05:00", value: 1, kind: "contact_outcome", source: "test" },
  ], { now: NOW });
  assert.equal(state.byHour[10], 0.25);
  state = model.ingest(state, [
    { dimension: "receptivity", at: "2026-09-02T10:10:00", value: 1, kind: "contact_outcome", source: "test" },
  ], { now: NOW });
  assert.equal(state.byHour[10], 0.438); // 0.4375，状态保留 3 位小数
  assert.equal(state.attempts, 2);
  assert.ok(model.confidence(state) < 1);
});

test("专注模型器：EWMA 直方图 + 峰值块提取", () => {
  const model = new FocusDimensionModel();
  const observations: RhythmObservation[] = [];
  for (let i = 0; i < 20; i++) {
    observations.push({ dimension: "focus", at: `2026-09-0${(i % 3) + 1}T10:30:00`, value: 10.5, kind: "desktop_active", weight: 1, source: "test" });
    observations.push({ dimension: "focus", at: `2026-09-0${(i % 3) + 1}T14:30:00`, value: 14.5, kind: "interaction", weight: 1, source: "test" });
  }
  const state = model.ingest(null, observations, { now: NOW });
  assert.ok(state.hourHistogram[10] > state.hourHistogram[14]! * 2);
  assert.equal(state.peakBlocks[0]?.startHour, 10);
});

// ── 2. ProfileStore ──────────────────────────────

test("ProfileStore：落盘回读 + 非法数据归一化不致命", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-store-"));
  try {
    const store = new RhythmProfileStore(dir);
    const profile = store.ensure(ACTOR, NOW);
    profile.reminderSlots["task-1"] = {
      taskId: "task-1", hour: 23, originalHour: 23, acceptanceEwma: 0.2, attempts: 3,
      lastAdjustedAt: null, lastAdjustDirection: null, pinnedByUser: false,
    };
    await store.save(profile);

    const reopened = new RhythmProfileStore(dir);
    await reopened.load();
    const loaded = reopened.get(ACTOR);
    assert.ok(loaded);
    assert.equal(loaded.reminderSlots["task-1"]?.hour, 23);

    // 半损坏文件：缺 dimensions 字段也能加载
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "actor-broken.json"), JSON.stringify({ actorId: "actor-broken" }), "utf8");
    const third = new RhythmProfileStore(dir);
    await third.load();
    assert.ok(third.get("actor-broken"));
    assert.equal(third.get("actor-broken")?.dimensions.sleep.sampleCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ── 3. 引擎主循环 ──────────────────────────────

function makeSensor(id: string, observations: RhythmObservation[]): RhythmSensor {
  return { id, dimensions: [...new Set(observations.map((o) => o.dimension))] as never, collect: async () => observations };
}

test("引擎主循环：collect → ingest → insights → 消费方通知", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-engine-"));
  try {
    const store = new RhythmProfileStore(dir);
    await store.load();
    const engine = new LifeRhythmEngine({ profileStore: store });
    const sleepObs: RhythmObservation[] = [];
    for (let i = 1; i <= 7; i++) {
      sleepObs.push({
        dimension: "sleep", at: `2026-08-${String(27 + i).padStart(2, "0")}T12:00:00`,
        value: 0.7 + (i % 3) * 0.1, value2: 8, kind: "sleep_sample", source: "test",
      });
    }
    engine.registerSensor(makeSensor("sleep", sleepObs));

    const updates: RhythmProfileUpdate[] = [];
    let consumerCalls = 0;
    engine.subscribe((update) => { updates.push(update); });
    // 失败的消费方不阻塞其他消费方
    engine.subscribe(() => { consumerCalls += 1; throw new Error("consumer boom"); });

    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    assert.ok(update);
    assert.ok(update!.changedDimensions.includes("sleep"));
    assert.equal(update!.confidences.sleep, 1);
    assert.equal(updates.length, 1);
    assert.equal(consumerCalls, 1, "抛错的消费方不影响其他消费方收到通知");
    assert.ok(engine.getProfile(ACTOR)?.lastAnalyzedDay === NOW.toISOString().slice(0, 10));
    // 洞察已生成（睡眠样本含 0.7+ 入睡 → 晚睡建议）
    assert.ok(engine.getProfile(ACTOR)!.insights.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ── 4. 出口 A：提醒重排 ──────────────────────────────

function makeScheduleTask(overrides: Partial<ScheduleTaskRecord> & { taskId: string }): ScheduleTaskRecord {
  return {
    sessionId: ACTOR,
    title: "睡觉提醒",
    description: `${RHYTHM_MARK}sleep] 睡觉提醒 23:00`,
    kind: "reminder",
    category: "trivia",
    recurrence: "daily",
    timezone: "Asia/Shanghai",
    runAt: "2026-09-01T15:00:00.000Z",
    nextRunAt: "2026-09-04T15:00:00.000Z", // 北京时间 23:00
    status: "active",
    reminderMessage: "睡觉",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFakeSchedule(tasks: ScheduleTaskRecord[]) {
  const updated: Array<{ taskId: string; runAt: string }> = [];
  return {
    tasks,
    updated,
    listAllTasks: () => tasks,
    updateTask: async (taskId: string, input: { runAt: string }) => {
      updated.push({ taskId, runAt: input.runAt });
      const task = tasks.find((t) => t.taskId === taskId)!;
      // nextLocalOccurrenceIso 产出任务时区的本地时刻字符串（无时区后缀）；
      // 真实 ScheduleTaskService.parseLocalRunAt 会按任务时区转 UTC，这里按
      // Asia/Shanghai 固定偏移做等价转换，保证断言与机器时区无关。
      task.nextRunAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.runAt)
        ? new Date(`${input.runAt}:00+08:00`).toISOString()
        : input.runAt;
      return task;
    },
  };
}

function sleepEngineSetup(storeDir: string, windowStartHour: number) {
  const store = new RhythmProfileStore(storeDir);
  const engine = new LifeRhythmEngine({ profileStore: store });
  const sleepObs: RhythmObservation[] = [];
  for (let i = 1; i <= 7; i++) {
    sleepObs.push({
      dimension: "sleep", at: `2026-08-${String(27 + i).padStart(2, "0")}T12:00:00`,
      value: windowStartHour, value2: 8, kind: "sleep_sample", source: "test",
    });
  }
  engine.registerSensor(makeSensor("sleep", sleepObs));
  return { store, engine };
}

test("出口 A：睡觉提醒向学习窗口渐进重排（每次 ≤15 分钟）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-resched-"));
  try {
    // 用户实际 00:45 入睡；提醒当前 23:00 → 目标 00:15
    const { store, engine } = sleepEngineSetup(dir, 0.75);
    const schedule = makeFakeSchedule([makeScheduleTask({ taskId: "t-sleep" })]);
    engine.subscribe(createReminderReschedulerConsumer(schedule, engine));

    await engine.runAnalysis(ACTOR, { now: NOW });
    assert.equal(schedule.updated.length, 1);
    // 23:00 + 15 分钟 = 23:15
    const task = schedule.tasks[0]!;
    const { toTzLocalTime } = await import("../src/rhythm/time-utils.js");
    const local = toTzLocalTime(new Date(task.nextRunAt!), task.timezone);
    assert.equal(local.hour, 23);
    assert.equal(local.minute, 15);

    // 槽位已记账：连续多轮分析（模拟多晚），逐步逼近 00:15 后停住
    // 23:00 → 00:15 共 75 分钟 = 5 步 × 15 分钟
    for (let day = 1; day <= 12; day++) {
      await engine.runAnalysis(ACTOR, { now: new Date(NOW.getTime() + day * 24 * 3600 * 1000) });
    }
    const profile = engine.getProfile(ACTOR)!;
    const slot = profile.reminderSlots["t-sleep"]!;
    assert.equal(Math.round(slot.hour * 100) / 100, 0.25, "最终锚定入睡窗口前 30 分钟");
    assert.equal(schedule.updated.length, 5, "从 23:00 到 00:15 恰好 5 步 × 15 分钟，到位后不再调整");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("出口 A：pinned 任务永不调整；睡眠样本不足不动作", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-pin-"));
  try {
    const { store, engine } = sleepEngineSetup(dir, 0.75);
    const profile = store.ensure(ACTOR, NOW);
    profile.reminderSlots["t-sleep"] = {
      taskId: "t-sleep", hour: 23, originalHour: 23, acceptanceEwma: null, attempts: 0,
      lastAdjustedAt: null, lastAdjustDirection: null, pinnedByUser: true,
    };
    const schedule = makeFakeSchedule([makeScheduleTask({ taskId: "t-sleep" })]);
    engine.subscribe(createReminderReschedulerConsumer(schedule, engine));
    await engine.runAnalysis(ACTOR, { now: NOW });
    assert.equal(schedule.updated.length, 0, "pinned 不动");

    // 低置信（2 个样本）也不动
    const dir2 = await mkdtemp(join(tmpdir(), "rhythm-lowconf-"));
    try {
      const lowStore = new RhythmProfileStore(dir2);
      const lowEngine = new LifeRhythmEngine({ profileStore: lowStore });
      lowEngine.registerSensor(makeSensor("sleep", [
        { dimension: "sleep", at: "2026-09-01T12:00:00", value: 0.75, value2: 8, kind: "sleep_sample", source: "test" },
        { dimension: "sleep", at: "2026-09-02T12:00:00", value: 0.75, value2: 8, kind: "sleep_sample", source: "test" },
      ]));
      const lowSchedule = makeFakeSchedule([makeScheduleTask({ taskId: "t-sleep" })]);
      lowEngine.subscribe(createReminderReschedulerConsumer(lowSchedule, lowEngine));
      await lowEngine.runAnalysis(ACTOR, { now: NOW });
      assert.equal(lowSchedule.updated.length, 0, "样本不足不动作");
    } finally {
      await rm(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("presetOfTask：按标记解析预设", () => {
  assert.equal(presetOfTask(makeScheduleTask({ taskId: "x" })), "sleep");
  assert.equal(
    presetOfTask(makeScheduleTask({ taskId: "x", description: `${RHYTHM_MARK}water] 喝水提醒 10:00` })),
    "water",
  );
  assert.equal(presetOfTask(makeScheduleTask({ taskId: "x", description: "普通日程" })), "unknown");
});

// ── 5. 出口 B / C ──────────────────────────────

test("出口 B：接受度达标时回填 receptiveHours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-writer-"));
  try {
    const store = new RhythmProfileStore(dir);
    const engine = new LifeRhythmEngine({ profileStore: store });
    const outcomes: RhythmObservation[] = [];
    for (let i = 0; i < 12; i++) {
      outcomes.push({ dimension: "receptivity", at: `2026-09-0${(i % 3) + 1}T10:00:00`, value: i % 4 === 0 ? 0 : 1, kind: "contact_outcome", source: "test" });
      outcomes.push({ dimension: "receptivity", at: `2026-09-0${(i % 3) + 1}T23:30:00`, value: 0, kind: "contact_outcome", source: "test" });
    }
    engine.registerSensor(makeSensor("feedback", outcomes));

    const written: Array<{ actorId: string; byHour: Record<string, number> }> = [];
    engine.subscribe(createReceptiveHoursWriterConsumer({
      applyLearnedReceptivity: (actorId, byHour) => written.push({ actorId, byHour }),
    }));

    await engine.runAnalysis(ACTOR, { now: NOW });
    assert.equal(written.length, 1);
    assert.ok(written[0]!.byHour["10"]! > written[0]!.byHour["23"]!);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("出口 C：强洞察发布关怀信号，同维度 3 天限频", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-candidate-"));
  try {
    const store = new RhythmProfileStore(dir);
    const engine = new LifeRhythmEngine({ profileStore: store });
    // 晚睡趋势 ≥45 分钟 → notifiable；先给 4 个早样本再给 3 个晚样本
    const sleepObs: RhythmObservation[] = [
      ...[23.0, 23.1, 23.0, 23.2].map((v, i) => ({
        dimension: "sleep" as const, at: `2026-08-2${i + 5}T12:00:00`, value: v, value2: 7.5, kind: "sleep_sample", source: "test",
      })),
      ...[0.9, 1.0, 0.9].map((v, i) => ({
        dimension: "sleep" as const, at: `2026-09-0${i + 1}T12:00:00`, value: v, value2: 8.2, kind: "sleep_sample", source: "test",
      })),
    ];
    engine.registerSensor(makeSensor("sleep", sleepObs));

    const published: string[] = [];
    engine.subscribe(createProactiveCandidateSourceConsumer(
      { publish: (signal) => published.push(signal.kind) },
      engine,
    ));

    await engine.runAnalysis(ACTOR, { now: NOW });
    assert.equal(published.length, 1);
    const stored = store.get(ACTOR)!;
    assert.ok(stored.lastCandidateAt.sleep);

    // 立即再跑一轮：限频内不再发布
    await engine.runAnalysis(ACTOR, { now: new Date(NOW.getTime() + 3600 * 1000), force: true });
    assert.equal(published.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ── 6. 在线回灌 ──────────────────────────────

test("recordContactOutcome / recordReminderFeedback：在线 EWMA 更新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-online-"));
  try {
    const store = new RhythmProfileStore(dir);
    const engine = new LifeRhythmEngine({ profileStore: store });
    await engine.registerReminderSlot(ACTOR, "t-water", 15);
    await engine.recordReminderFeedback(ACTOR, "t-water", "ignored");
    await engine.recordReminderFeedback(ACTOR, "t-water", "ignored");
    await engine.recordReminderFeedback(ACTOR, "t-water", "accepted");
    const slot = engine.getProfile(ACTOR)!.reminderSlots["t-water"]!;
    assert.equal(slot.attempts, 3);
    // EWMA α=0.4: 0 → 0 → 0.4
    assert.equal(slot.acceptanceEwma, 0.4);

    // push 观察进入缓冲，随下次分析被接受度模型消费
    engine.recordContactOutcome(ACTOR, "accepted", new Date("2026-09-03T21:00:00+08:00"));
    await engine.runAnalysis(ACTOR, { now: NOW });
    const receptivity = engine.getProfile(ACTOR)!.dimensions.receptivity;
    assert.equal(receptivity.attempts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ── 7. 夜间分析任务 ──────────────────────────────

test("NightlyRhythmAnalyzer：按日去重，同日不重复分析", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-nightly-"));
  try {
    const store = new RhythmProfileStore(dir);
    const engine = new LifeRhythmEngine({ profileStore: store });
    const analyzer = new NightlyRhythmAnalyzer({ engine, listActorIds: () => [ACTOR] });

    // 同日两次 runAll：第二次被 profile.lastAnalyzedDay 去重
    await analyzer.runAll(NOW);
    assert.ok(engine.getProfile(ACTOR));
    const day = engine.getProfile(ACTOR)!.lastAnalyzedDay;
    await analyzer.runAll(NOW);
    assert.equal(engine.getProfile(ACTOR)!.lastAnalyzedDay, day);
    assert.equal(engine.getProfile(ACTOR)!.updatedAt, NOW.toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ── 8. 时间工具 ──────────────────────────────

test("时间工具：环形小时差与格式化", () => {
  assert.equal(circularHourDiff(0.25, 23), 1.25);
  assert.equal(circularHourDiff(23, 0.25), -1.25);
  assert.equal(circularHourDiff(10, 10), 0);
  assert.equal(formatHour(23.25), "23:15");
  assert.equal(formatHour(0.75), "00:45");
});
