/**
 * BrainStem 感知预算机制压测脚本（Task 5）
 *
 * 验证 BrainStem 的 adjustSampleRate 与 observeAndAdjustSampleRate 在高频状态切换下的
 * 正确性和稳定性，确保 setInterval 正确重置、无定时器泄漏。
 *
 * 用法：
 *   npx tsx scripts/stress-brain-stem-budget.ts
 *
 * 覆盖场景：
 *   1. 状态高频切换（200 次循环）—— 正确性 + 去抖
 *   2. awareness 未注册降级
 *   3. awareness.observe 返回 null 降级
 *   4. awareness.observe 抛异常降级
 *   5. 定时器泄漏检测（start/stop 5 次循环）
 *   附：单次 adjustSampleRate 延迟测量
 */
import { performance } from "node:perf_hooks";

import { BrainStem } from "../src/brain/brain-stem.js";
import type { BrainStemAwarenessLike, BrainStemHubLike } from "../src/brain/brain-stem.js";
import type { UserActivityKind, UserActivityState } from "../src/brain/types.js";
import type { LifeSignalEvidenceWindow } from "../src/services/life-signal-types.js";

// ---- 期望间隔常量（与 brain-stem.ts 保持一致） ----
const EXPECT_IDLE_MS = 45_000;
const EXPECT_BUSY_MS = 90_000;
const EXPECT_SLEEPING_MS = 300_000;

function expectedIntervalFor(activity: UserActivityKind): number {
  switch (activity) {
    case "busy": return EXPECT_BUSY_MS;
    case "sleeping": return EXPECT_SLEEPING_MS;
    // idle / unknown / just_off_work / going_out -> 45s
    default: return EXPECT_IDLE_MS;
  }
}

// ---- Mock Awareness ----
type MockMode = "sequence" | "null" | "throw";

interface MockAwareness extends BrainStemAwarenessLike {
  callCount: number;
  setSequence(seq: UserActivityKind[]): void;
  setReturnNull(): void;
  setThrow(): void;
}

function createMockAwareness(): MockAwareness {
  let sequence: UserActivityKind[] = [];
  let idx = 0;
  let mode: MockMode = "sequence";
  const aw: MockAwareness = {
    callCount: 0,
    setSequence(seq) { sequence = seq; idx = 0; mode = "sequence"; },
    setReturnNull() { mode = "null"; },
    setThrow() { mode = "throw"; },
    observe(actorId: string): UserActivityState | null {
      aw.callCount++;
      if (mode === "throw") throw new Error("mock observe error (stress)");
      if (mode === "null") return null;
      const activity = sequence[idx % sequence.length] ?? "idle";
      idx++;
      return {
        actorId,
        activity,
        confidence: 0.9,
        evidence: [],
        occurredAt: new Date().toISOString(),
      };
    },
  };
  return aw;
}

// ---- Mock Hub（最小化，recentSignals 返回空使 sweepActor 提前返回，聚焦感知预算） ----
function createMockHub(): BrainStemHubLike {
  const emptyWindow: LifeSignalEvidenceWindow = {
    actorId: "",
    windowMs: 0,
    totalSignals: 0,
    recentSignals: [],
    trend: "stable",
    directionScore: 0,
    slopeScore: 0,
    turningPoints: 0,
    reversalDirection: null,
    topicCounts: {},
    tagCounts: {},
    signalKinds: {},
  };
  return {
    subscribe() { return () => {}; },
    recentSignals() { return []; },
    getEvidenceWindow() { return emptyWindow; },
    publish() {},
  };
}

// ---- 反射访问私有字段 ----
type BrainStemInternals = BrainStem & {
  currentSampleInterval: number;
  sweepTimer: NodeJS.Timeout | null;
  knownActors: Set<string>;
  observeAndAdjustSampleRate(): void;
};

function internals(bs: BrainStem): BrainStemInternals {
  return bs as unknown as BrainStemInternals;
}

function addActor(bs: BrainStem, actorId: string): void {
  internals(bs).knownActors.add(actorId);
}

// ---- 统计 active Timeout 句柄数 ----
function countTimeoutHandles(): number {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  return handles.filter((h) => {
    const ctor = (h as { constructor?: { name?: string } }).constructor;
    return ctor?.name === "Timeout";
  }).length;
}

// ---- 结果收集 ----
interface ScenarioResult {
  name: string;
  passed: boolean;
  details: string;
  data?: Record<string, unknown>;
}

const results: ScenarioResult[] = [];

function log(msg: string): void { console.log(msg); }

// ====================================================================
// 场景 1：状态高频切换（200 次循环）
// ====================================================================
async function scenario1(): Promise<void> {
  log("\n========== 场景 1：状态高频切换（200 次循环）==========");
  const bs = new BrainStem();
  const aw = createMockAwareness();
  bs.registerLifeSignalHub(createMockHub());
  bs.registerAwareness(aw);

  // 构造 200 次状态序列：idle→busy→sleeping→idle→busy→...（每步与前一步不同）
  const cycle: UserActivityKind[] = ["idle", "busy", "sleeping"];
  const sequence: UserActivityKind[] = [];
  for (let i = 0; i < 200; i++) sequence.push(cycle[i % 3]);
  aw.setSequence(sequence);

  addActor(bs, "actor-1");
  const bsInt = internals(bs);
  await bs.start();

  interface StepRecord {
    step: number;
    activity: UserActivityKind;
    expected: number;
    actual: number;
    prevInterval: number;
    changed: boolean;
    timerReset: boolean;
    timerIdentityChanged: boolean;
  }
  const records: StepRecord[] = [];
  let prevInterval = bsInt.currentSampleInterval;
  let prevTimerRef = bsInt.sweepTimer;
  let correctUpdates = 0;   // interval 正确变化
  let correctDebounces = 0; // interval 未变（去抖生效）
  let mismatches = 0;       // interval 与期望不符
  let errors = 0;           // 异常

  for (let i = 0; i < 200; i++) {
    const expectedActivity = sequence[i];
    const expected = expectedIntervalFor(expectedActivity);
    let threw = false;
    try {
      // 通过 sweepOnce 触发完整流程（含 sweepActor + observeAndAdjustSampleRate）
      await bs.sweepOnce();
    } catch (e) {
      threw = true;
      errors++;
      log(`  [step ${i}] sweepOnce 异常: ${(e as Error).message}`);
    }
    const actual = bsInt.currentSampleInterval;
    const changed = actual !== prevInterval;
    const timerIdentityChanged = bsInt.sweepTimer !== prevTimerRef;

    if (!threw) {
      if (actual === expected) {
        if (changed) correctUpdates++;
        else correctDebounces++;
      } else {
        mismatches++;
        log(`  [step ${i}] 不匹配: activity=${expectedActivity} expected=${expected} actual=${actual}`);
      }
    }

    records.push({
      step: i,
      activity: expectedActivity,
      expected,
      actual,
      prevInterval,
      changed,
      timerReset: timerIdentityChanged,
      timerIdentityChanged,
    });
    prevInterval = actual;
    prevTimerRef = bsInt.sweepTimer;
  }

  await bs.stop();

  const total = 200;
  const accuracy = ((correctUpdates + correctDebounces) / total) * 100;
  const timerResetCount = records.filter((r) => r.timerIdentityChanged).length;
  const passed = errors === 0 && mismatches === 0 && accuracy === 100;

  // 去抖验证：序列首步 idle(45000) == 初始 45000 → 去抖；其余每步 activity 不同 → 更新
  // 故期望：correctDebounces=1, correctUpdates=199
  log(`  总步数:           ${total}`);
  log(`  正确更新次数:     ${correctUpdates}（期望 199）`);
  log(`  去抖次数:         ${correctDebounces}（期望 1，首步 idle==初始值）`);
  log(`  不匹配次数:       ${mismatches}`);
  log(`  异常次数:         ${errors}`);
  log(`  observe 调用次数: ${aw.callCount}`);
  log(`  定时器重置次数:   ${timerResetCount}（应等于正确更新次数 ${correctUpdates}）`);
  log(`  准确率:           ${accuracy.toFixed(2)}%`);
  log(`  结果:             ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 1：200 次状态高频切换",
    passed,
    details: `准确率 ${accuracy.toFixed(2)}% | 更新 ${correctUpdates} | 去抖 ${correctDebounces} | 不匹配 ${mismatches} | 异常 ${errors} | 定时器重置 ${timerResetCount}`,
    data: { total, correctUpdates, correctDebounces, mismatches, errors, accuracy, timerResetCount, observeCalls: aw.callCount },
  });
}

// ====================================================================
// 场景 2：awareness 未注册降级
// ====================================================================
async function scenario2(): Promise<void> {
  log("\n========== 场景 2：awareness 未注册降级 ==========");
  const bs = new BrainStem();
  bs.registerLifeSignalHub(createMockHub());
  // 故意不注册 awareness
  addActor(bs, "actor-1");
  const bsInt = internals(bs);
  await bs.start();

  const initial = bsInt.currentSampleInterval;
  let noCrash = true;
  let intervalStable = true;

  for (let i = 0; i < 20; i++) {
    try {
      await bs.sweepOnce();
    } catch (e) {
      noCrash = false;
      log(`  [step ${i}] 异常: ${(e as Error).message}`);
    }
    if (bsInt.currentSampleInterval !== initial) {
      intervalStable = false;
      log(`  [step ${i}] interval 变化: ${initial} -> ${bsInt.currentSampleInterval}`);
    }
  }

  await bs.stop();
  const passed = noCrash && intervalStable && bsInt.currentSampleInterval === EXPECT_IDLE_MS;
  log(`  无崩溃:           ${noCrash}`);
  log(`  interval 稳定 45000: ${intervalStable && bsInt.currentSampleInterval === EXPECT_IDLE_MS}`);
  log(`  结果:             ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 2：awareness 未注册降级",
    passed,
    details: `noCrash=${noCrash}, intervalStable=${intervalStable}, final=${bsInt.currentSampleInterval}`,
  });
}

// ====================================================================
// 场景 3：awareness.observe 返回 null 降级
// ====================================================================
async function scenario3(): Promise<void> {
  log("\n========== 场景 3：awareness.observe 返回 null 降级 ==========");
  const bs = new BrainStem();
  const aw = createMockAwareness();
  aw.setReturnNull();
  bs.registerLifeSignalHub(createMockHub());
  bs.registerAwareness(aw);
  addActor(bs, "actor-1");
  const bsInt = internals(bs);
  await bs.start();

  const initial = bsInt.currentSampleInterval;
  let noCrash = true;
  let intervalStable = true;

  for (let i = 0; i < 20; i++) {
    try {
      await bs.sweepOnce();
    } catch (e) {
      noCrash = false;
      log(`  [step ${i}] 异常: ${(e as Error).message}`);
    }
    if (bsInt.currentSampleInterval !== initial) {
      intervalStable = false;
      log(`  [step ${i}] interval 变化: ${initial} -> ${bsInt.currentSampleInterval}`);
    }
  }

  await bs.stop();
  const passed = noCrash && intervalStable && bsInt.currentSampleInterval === EXPECT_IDLE_MS;
  log(`  observe 调用次数: ${aw.callCount}`);
  log(`  无崩溃:           ${noCrash}`);
  log(`  interval 稳定 45000: ${intervalStable && bsInt.currentSampleInterval === EXPECT_IDLE_MS}`);
  log(`  结果:             ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 3：observe 返回 null 降级",
    passed,
    details: `noCrash=${noCrash}, intervalStable=${intervalStable}, observeCalls=${aw.callCount}, final=${bsInt.currentSampleInterval}`,
  });
}

// ====================================================================
// 场景 4：awareness.observe 抛异常降级
// ====================================================================
async function scenario4(): Promise<void> {
  log("\n========== 场景 4：awareness.observe 抛异常降级 ==========");
  const bs = new BrainStem();
  const aw = createMockAwareness();
  aw.setThrow();
  bs.registerLifeSignalHub(createMockHub());
  bs.registerAwareness(aw);
  addActor(bs, "actor-1");
  const bsInt = internals(bs);
  await bs.start();

  const initial = bsInt.currentSampleInterval;
  let noCrash = true;
  let intervalStable = true;

  for (let i = 0; i < 20; i++) {
    try {
      await bs.sweepOnce();
    } catch (e) {
      // sweepOnce 内部 try/catch 已捕获 sweepActor 异常；observeAndAdjustSampleRate
      // 内部也 try/catch 捕获 observe 异常。此处不应抛出。
      noCrash = false;
      log(`  [step ${i}] sweepOnce 外层异常: ${(e as Error).message}`);
    }
    if (bsInt.currentSampleInterval !== initial) {
      intervalStable = false;
      log(`  [step ${i}] interval 变化: ${initial} -> ${bsInt.currentSampleInterval}`);
    }
  }

  await bs.stop();
  const passed = noCrash && intervalStable && bsInt.currentSampleInterval === EXPECT_IDLE_MS;
  log(`  observe 调用次数: ${aw.callCount}`);
  log(`  无崩溃:           ${noCrash}`);
  log(`  interval 稳定 45000: ${intervalStable && bsInt.currentSampleInterval === EXPECT_IDLE_MS}`);
  log(`  结果:             ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 4：observe 抛异常降级",
    passed,
    details: `noCrash=${noCrash}, intervalStable=${intervalStable}, observeCalls=${aw.callCount}, final=${bsInt.currentSampleInterval}`,
  });
}

// ====================================================================
// 场景 5：定时器泄漏检测
// ====================================================================
async function scenario5(): Promise<void> {
  log("\n========== 场景 5：定时器泄漏检测 ==========");
  const bs = new BrainStem();
  const aw = createMockAwareness();
  bs.registerLifeSignalHub(createMockHub());
  bs.registerAwareness(aw);
  addActor(bs, "actor-1");
  const bsInt = internals(bs);

  // 序列：200 次切换
  const cycle: UserActivityKind[] = ["idle", "busy", "sleeping"];
  aw.setSequence(Array.from({ length: 200 }, (_, i) => cycle[i % 3]));

  const baselineTimers = countTimeoutHandles();
  log(`  基线 Timeout 句柄数: ${baselineTimers}`);

  // ---- 5a: start → 200 次切换 → stop，验证 stop 后 sweepTimer 清理 ----
  await bs.start();
  const afterStartTimers = countTimeoutHandles();
  const sweepTimerAfterStart = bsInt.sweepTimer;
  log(`  start 后 Timeout 句柄数: ${afterStartTimers} (delta=${afterStartTimers - baselineTimers})`);
  log(`  start 后 sweepTimer 非空: ${sweepTimerAfterStart !== null}`);

  for (let i = 0; i < 200; i++) {
    await bs.sweepOnce();
  }
  const afterSwitchTimers = countTimeoutHandles();
  log(`  200 次切换后 Timeout 句柄数: ${afterSwitchTimers} (delta=${afterSwitchTimers - baselineTimers})`);

  await bs.stop();
  const afterStopTimers = countTimeoutHandles();
  const sweepTimerAfterStop = bsInt.sweepTimer;
  log(`  stop 后 Timeout 句柄数: ${afterStopTimers} (delta=${afterStopTimers - baselineTimers})`);
  log(`  stop 后 sweepTimer 为 null: ${sweepTimerAfterStop === null}`);

  const stopClean = sweepTimerAfterStop === null && afterStopTimers <= baselineTimers;

  // ---- 5b: 5 次 start/stop 循环，验证无残留定时器累积 ----
  let cycleAccumulation = 0;
  let cycleClean = true;
  for (let c = 0; c < 5; c++) {
    await bs.start();
    const t1 = countTimeoutHandles();
    // 每轮做一些状态切换
    for (let i = 0; i < 10; i++) {
      await bs.sweepOnce();
    }
    await bs.stop();
    const t2 = countTimeoutHandles();
    const delta = t2 - baselineTimers;
    if (delta > 0) {
      cycleAccumulation = Math.max(cycleAccumulation, delta);
      cycleClean = false;
      log(`  循环 ${c + 1}: stop 后残留 ${delta} 个 Timeout`);
    }
  }
  log(`  5 次 start/stop 后最大残留: ${cycleAccumulation}`);
  log(`  5 次循环无累积: ${cycleClean}`);

  const passed = stopClean && cycleClean;
  log(`  结果: ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 5：定时器泄漏检测",
    passed,
    details: `stopClean=${stopClean} (sweepTimer=${sweepTimerAfterStop === null ? "null" : "LEAK"}), 5次循环无累积=${cycleClean}, baseline=${baselineTimers} afterStop=${afterStopTimers}`,
    data: { baselineTimers, afterStartTimers, afterSwitchTimers, afterStopTimers, cycleAccumulation, cycleClean },
  });
}

// ====================================================================
// 附：单次 adjustSampleRate 延迟测量
// ====================================================================
async function benchmarkAdjustSampleRate(): Promise<void> {
  log("\n========== 附：单次 adjustSampleRate 延迟测量 ==========");
  const bs = new BrainStem();
  bs.registerLifeSignalHub(createMockHub());
  const bsInt = internals(bs);

  // 先 start 使 sweepTimer 存在（adjustSampleRate 会 clearInterval+setInterval）
  await bs.start();
  bsInt.knownActors.add("actor-1");

  // 测量 1000 次 adjustSampleRate 调用（交替 busy/idle 触发实际重排）
  const N = 1000;
  const samples: number[] = [];
  // 预热
  bs.adjustSampleRate("busy");
  bs.adjustSampleRate("idle");

  for (let i = 0; i < N; i++) {
    const state: UserActivityKind = i % 2 === 0 ? "busy" : "idle";
    const t0 = performance.now();
    bs.adjustSampleRate(state);
    const t1 = performance.now();
    samples.push(t1 - t0);
  }

  const max = Math.max(...samples);
  const min = Math.min(...samples);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p99 = samples.slice().sort((a, b) => a - b)[Math.floor(N * 0.99)];
  const overLimit = samples.filter((s) => s >= 1).length;

  log(`  样本数:     ${N}`);
  log(`  min:        ${min.toFixed(4)} ms`);
  log(`  avg:        ${avg.toFixed(4)} ms`);
  log(`  p99:        ${p99.toFixed(4)} ms`);
  log(`  max:        ${max.toFixed(4)} ms`);
  log(`  >=1ms 次数: ${overLimit}`);
  log(`  验收 (<1ms): ${overLimit === 0 ? "PASS ✅" : "FAIL ❌"}`);

  // 清理
  await bs.stop();

  results.push({
    name: "附：adjustSampleRate 延迟 < 1ms",
    passed: overLimit === 0,
    details: `avg=${avg.toFixed(4)}ms p99=${p99.toFixed(4)}ms max=${max.toFixed(4)}ms overLimit=${overLimit}/${N}`,
    data: { N, min, avg, p99, max, overLimit },
  });
}

// ====================================================================
// 主入口
// ====================================================================
async function main(): Promise<void> {
  log("============================================================");
  log("  BrainStem 感知预算机制压测（Task 5）");
  log("  目标: adjustSampleRate / observeAndAdjustSampleRate");
  log("  时间: " + new Date().toISOString());
  log("============================================================");

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await benchmarkAdjustSampleRate();

  // ---- 汇总 ----
  log("\n============================================================");
  log("  汇总");
  log("============================================================");
  const allPassed = results.every((r) => r.passed);
  for (const r of results) {
    log(`  [${r.passed ? "PASS" : "FAIL"}] ${r.name}`);
    log(`        ${r.details}`);
  }
  log("------------------------------------------------------------");
  log(`  总体: ${allPassed ? "ALL PASS ✅" : "HAS FAILURE ❌"}`);
  log("============================================================");

  if (!allPassed) {
    process.exitCode = 1;
  }
}

void main();
