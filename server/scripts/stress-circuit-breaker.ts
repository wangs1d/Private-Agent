/**
 * CircuitBreaker 熔断器压测脚本
 *
 * 直接 import CircuitBreaker（无 mock），通过 options.now 注入可控时钟避免长时间等待。
 *
 * 用法：
 *   npx tsx scripts/stress-circuit-breaker.ts
 *
 * 覆盖场景：
 *   1. 正常通过（100 次成功）：canExecute 恒 true，状态恒 closed
 *   2. 熔断触发（11 次连续失败）：失败率 > 50% → open，canExecute 变 false
 *   3. 熔断恢复（open → half-open → closed）：超时后转 half-open，recordSuccess 转 closed
 *   4. half-open 失败（open → half-open → open）：探测失败回退 open
 *   5. 并发安全（100 并发）：canExecute + recordSuccess/recordFailure 无崩溃
 *   6. 延迟基准（1000 次）：canExecute 平均延迟 < 0.1ms
 */
import { performance } from "node:perf_hooks";

import { CircuitBreaker } from "../src/external-model/circuit-breaker.js";

// ---- 可控时钟 ----
function makeClock() {
  let t = 1_000_000; // 起始时间，避开 0 边界
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
    get: () => t,
  };
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
// 场景 1：正常通过（100 次 recordSuccess）
// ====================================================================
function scenario1(): void {
  log("\n========== 场景 1：正常通过（100 次 recordSuccess）==========");
  const cb = new CircuitBreaker();
  let allCanExecute = true;
  let allClosed = true;
  let errors = 0;

  for (let i = 0; i < 100; i++) {
    try {
      if (!cb.canExecute()) allCanExecute = false;
      if (cb.getState() !== "closed") allClosed = false;
      cb.recordSuccess();
    } catch (e) {
      errors++;
      log(`  [step ${i}] 异常: ${(e as Error).message}`);
    }
  }

  const finalCanExecute = cb.canExecute();
  const finalState = cb.getState();
  const passed = allCanExecute && allClosed && finalCanExecute && finalState === "closed" && errors === 0;

  log(`  总循环:           100`);
  log(`  canExecute 恒 true: ${allCanExecute}`);
  log(`  状态恒 closed:    ${allClosed}`);
  log(`  最终 canExecute:  ${finalCanExecute}`);
  log(`  最终状态:         ${finalState}`);
  log(`  异常次数:         ${errors}`);
  log(`  结果:             ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 1：100 次成功恒 closed",
    passed,
    details: `canExecute恒true=${allCanExecute}, 状态恒closed=${allClosed}, final=${finalState}, errors=${errors}`,
    data: { iterations: 100, allCanExecute, allClosed, finalState, errors },
  });
}

// ====================================================================
// 场景 2：熔断触发（11 次连续失败）
// ====================================================================
function scenario2(): void {
  log("\n========== 场景 2：熔断触发（11 次连续 recordFailure）==========");
  const cb = new CircuitBreaker();
  let firstOpenAt = -1;
  let errors = 0;
  const stateTrace: string[] = [];

  for (let i = 0; i < 11; i++) {
    try {
      cb.recordFailure();
      const st = cb.getState();
      stateTrace.push(st);
      if (st === "open" && firstOpenAt === -1) firstOpenAt = i;
    } catch (e) {
      errors++;
      log(`  [step ${i}] 异常: ${(e as Error).message}`);
    }
  }

  const finalCanExecute = cb.canExecute();
  const finalState = cb.getState();

  // 验收：
  //   - 第 1 次失败后失败率 1/1 = 100% > 50% → open
  //   - 最终状态 open
  //   - canExecute = false（仍在 open 态，未超时）
  //   - 无异常
  const trippedCorrectly = firstOpenAt === 0;
  const finalIsOpen = finalState === "open";
  const canExecuteFalse = finalCanExecute === false;
  const passed = trippedCorrectly && finalIsOpen && canExecuteFalse && errors === 0;

  log(`  11 次失败后状态轨迹: ${stateTrace.join(" -> ")}`);
  log(`  首次进入 open 的步: ${firstOpenAt}（期望 0，第 1 次失败即 100% 失败率）`);
  log(`  最终状态:           ${finalState}（期望 open）`);
  log(`  最终 canExecute:    ${finalCanExecute}（期望 false）`);
  log(`  异常次数:           ${errors}`);
  log(`  结果:               ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 2：11 次失败触发熔断",
    passed,
    details: `首次open@step${firstOpenAt}, final=${finalState}, canExecute=${finalCanExecute}, errors=${errors}`,
    data: { firstOpenAt, finalState, finalCanExecute, errors, stateTrace },
  });
}

// ====================================================================
// 场景 3：熔断恢复（open → half-open → closed）
// ====================================================================
function scenario3(): void {
  log("\n========== 场景 3：熔断恢复（open → half-open → closed）==========");
  const clock = makeClock();
  const OPEN_MS = 100;
  const cb = new CircuitBreaker({ openTimeoutMs: OPEN_MS, now: clock.now });

  // 触发熔断
  cb.recordFailure();
  const stateAfterFail = cb.getState();
  const canExecAfterFail = cb.canExecute();
  log(`  触发熔断后: state=${stateAfterFail}, canExecute=${canExecAfterFail}`);

  // 等待 101ms（> openTimeoutMs=100ms），调用 canExecute 应转 half-open 并放行
  clock.advance(OPEN_MS + 1);
  const canExecAfterTimeout = cb.canExecute();
  const stateAfterTimeout = cb.getState();
  log(`  超时后: state=${stateAfterTimeout}, canExecute=${canExecAfterTimeout}（期望 half-open, true）`);

  // recordSuccess → closed
  cb.recordSuccess();
  const stateAfterSuccess = cb.getState();
  const canExecAfterSuccess = cb.canExecute();
  log(`  recordSuccess 后: state=${stateAfterSuccess}, canExecute=${canExecAfterSuccess}（期望 closed, true）`);

  const passed =
    stateAfterFail === "open" &&
    canExecAfterFail === false &&
    stateAfterTimeout === "half-open" &&
    canExecAfterTimeout === true &&
    stateAfterSuccess === "closed" &&
    canExecAfterSuccess === true;

  log(`  结果: ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 3：熔断恢复 open→half-open→closed",
    passed,
    details: `open→${stateAfterTimeout}→${stateAfterSuccess}, canExecute轨迹: ${canExecAfterFail}→${canExecAfterTimeout}→${canExecAfterSuccess}`,
    data: { stateAfterFail, stateAfterTimeout, stateAfterSuccess, canExecAfterFail, canExecAfterTimeout, canExecAfterSuccess },
  });
}

// ====================================================================
// 场景 4：half-open 失败（open → half-open → open）
// ====================================================================
function scenario4(): void {
  log("\n========== 场景 4：half-open 失败回退（open → half-open → open）==========");
  const clock = makeClock();
  const OPEN_MS = 100;
  const cb = new CircuitBreaker({ openTimeoutMs: OPEN_MS, now: clock.now });

  // 触发熔断
  cb.recordFailure();
  const stateAfterFail = cb.getState();
  log(`  触发熔断后: state=${stateAfterFail}（期望 open）`);

  // 等待超时 → half-open
  clock.advance(OPEN_MS + 1);
  const canExecAfterTimeout = cb.canExecute();
  const stateAfterTimeout = cb.getState();
  log(`  超时后: state=${stateAfterTimeout}, canExecute=${canExecAfterTimeout}（期望 half-open, true）`);

  // 探测失败 → 重新 open
  cb.recordFailure();
  const stateAfterProbeFail = cb.getState();
  const canExecAfterProbeFail = cb.canExecute(); // 此时应处于 open（因为刚 toOpen），且未超时
  log(`  探测失败后: state=${stateAfterProbeFail}, canExecute=${canExecAfterProbeFail}（期望 open, false）`);

  const passed =
    stateAfterFail === "open" &&
    stateAfterTimeout === "half-open" &&
    canExecAfterTimeout === true &&
    stateAfterProbeFail === "open" &&
    canExecAfterProbeFail === false;

  log(`  结果: ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 4：half-open 失败回退 open",
    passed,
    details: `open→half-open→open, canExecute: -→true→${canExecAfterProbeFail}`,
    data: { stateAfterFail, stateAfterTimeout, stateAfterProbeFail, canExecAfterTimeout, canExecAfterProbeFail },
  });
}

// ====================================================================
// 场景 5：并发安全（100 并发 worker）
// ====================================================================
async function scenario5(): Promise<void> {
  log("\n========== 场景 5：并发安全（100 并发 worker）==========");
  const clock = makeClock();
  const cb = new CircuitBreaker({ openTimeoutMs: 100, now: clock.now });
  const WORKER_COUNT = 100;
  let totalOps = 0;
  let errors = 0;
  let canExecuteTrueCount = 0;
  let canExecuteFalseCount = 0;
  const errorMessages = new Set<string>();

  // 每个并发 worker 随机执行 canExecute / recordSuccess / recordFailure
  const workers: Promise<void>[] = [];
  for (let w = 0; w < WORKER_COUNT; w++) {
    workers.push(
      (async () => {
        for (let i = 0; i < 50; i++) {
          try {
            const op = (w + i) % 3; // 0=canExecute, 1=success, 2=failure
            if (op === 0) {
              if (cb.canExecute()) canExecuteTrueCount++;
              else canExecuteFalseCount++;
            } else if (op === 1) {
              cb.recordSuccess();
            } else {
              cb.recordFailure();
            }
            totalOps++;
          } catch (e) {
            errors++;
            errorMessages.add((e as Error).message);
          }
        }
      })(),
    );
  }

  await Promise.all(workers);

  const finalState = cb.getState();
  const noCrash = errors === 0;
  // 状态机不变式：始终是 closed / open / half-open 之一
  const stateValid = finalState === "closed" || finalState === "open" || finalState === "half-open";
  const passed = noCrash && stateValid && totalOps === WORKER_COUNT * 50;

  log(`  并发 worker 数:    ${WORKER_COUNT}`);
  log(`  每 worker 操作数: 50`);
  log(`  总操作数:         ${totalOps}（期望 ${WORKER_COUNT * 50}）`);
  log(`  canExecute=true: ${canExecuteTrueCount}`);
  log(`  canExecute=false: ${canExecuteFalseCount}`);
  log(`  异常次数:         ${errors}`);
  log(`  异常消息集合:     ${[...errorMessages].slice(0, 3).join(" | ") || "（无）"}`);
  log(`  最终状态:         ${finalState}（状态合法: ${stateValid}）`);
  log(`  结果:             ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 5：100 并发安全",
    passed,
    details: `totalOps=${totalOps}/${WORKER_COUNT * 50}, errors=${errors}, final=${finalState}, stateValid=${stateValid}`,
    data: { workerCount: WORKER_COUNT, totalOps, canExecuteTrueCount, canExecuteFalseCount, errors, finalState },
  });
}

// ====================================================================
// 场景 6：延迟基准（1000 次 canExecute）
// ====================================================================
function scenario6(): void {
  log("\n========== 场景 6：延迟基准（1000 次 canExecute，avg < 0.1ms）==========");
  const cb = new CircuitBreaker();
  const N = 1000;
  const samples: number[] = [];

  // 预热
  for (let i = 0; i < 50; i++) cb.canExecute();

  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    cb.canExecute();
    const t1 = performance.now();
    samples.push(t1 - t0);
  }

  const sum = samples.reduce((a, b) => a + b, 0);
  const avg = sum / samples.length;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const sorted = samples.slice().sort((a, b) => a - b);
  const p50 = sorted[Math.floor(N * 0.5)];
  const p95 = sorted[Math.floor(N * 0.95)];
  const p99 = sorted[Math.floor(N * 0.99)];
  const overLimit = samples.filter((s) => s >= 0.1).length;

  const passed = avg < 0.1;

  log(`  样本数:     ${N}`);
  log(`  min:        ${min.toFixed(6)} ms`);
  log(`  avg:        ${avg.toFixed(6)} ms（验收 < 0.1ms）`);
  log(`  p50:        ${p50.toFixed(6)} ms`);
  log(`  p95:        ${p95.toFixed(6)} ms`);
  log(`  p99:        ${p99.toFixed(6)} ms`);
  log(`  max:        ${max.toFixed(6)} ms`);
  log(`  >=0.1ms 次数: ${overLimit}`);
  log(`  验收 (avg < 0.1ms): ${passed ? "PASS ✅" : "FAIL ❌"}`);

  results.push({
    name: "场景 6：canExecute 平均延迟 < 0.1ms",
    passed,
    details: `avg=${avg.toFixed(6)}ms p50=${p50.toFixed(6)}ms p99=${p99.toFixed(6)}ms max=${max.toFixed(6)}ms overLimit=${overLimit}/${N}`,
    data: { N, min, avg, p50, p95, p99, max, overLimit },
  });
}

// ====================================================================
// 主入口
// ====================================================================
async function main(): Promise<void> {
  log("============================================================");
  log("  CircuitBreaker 熔断器压测");
  log("  目标: 三态状态机 + 失败率阈值 + 恢复 + 并发 + 延迟");
  log("  时间: " + new Date().toISOString());
  log("============================================================");

  scenario1();
  scenario2();
  scenario3();
  scenario4();
  await scenario5();
  scenario6();

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
