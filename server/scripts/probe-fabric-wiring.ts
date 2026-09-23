/**
 * 五层主动性架构接线探针（probe-fabric-wiring.ts）。
 *
 * 复现生产装配（SensorKernel + 内置评估器链 + ArbiterV2 同款桥接），
 * 验证 L1 传感信号真的能到达 L2 评估器并产出 AttentionEvent。
 *
 *   npx tsx scripts/probe-fabric-wiring.ts            # 修复后行为（应产出事件）
 *   npx tsx scripts/probe-fabric-wiring.ts --legacy   # 复现修复前（缺桥接，事件=0）
 *
 * 背景：生产装配曾漏掉 sensorKernel.onSignal → evaluatorChain.handleSignal 一行，
 * events.ndjson 里只有 digest_beat——流式评估器全部空转。本探针把"接线是否在"变成可断言。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SensorKernel, registerFeeder } from "../src/proactivity/sensors/kernel.js";
import { EvaluatorChain, bridgeSensorKernelToChain, type AttentionEvent } from "../src/proactivity/evaluators/evaluator-chain.js";
import { buildBuiltinEvaluators } from "../src/proactivity/evaluators/builtin-evaluators.js";

const legacy = process.argv.includes("--legacy");
const dir = mkdtempSync(join(tmpdir(), "fabric-probe-"));

const services = {
  listTodayTasks: () => [{ title: "周会", runAt: Date.now() + 10 * 60_000 }],
  commitmentsDue: () => [],
  weatherLine: () => null,
  unreadSenders: () => ["妈妈", "老板"],
  readyGoals: () => [],
  interestLines: () => [],
  recallMemory: () => [],
};

const kernel = new SensorKernel({ dataPath: dir, disablePersist: true });
const scheduleSensor = {
  id: "schedule_probe",
  stream: "schedule" as const,
  pollIntervalMs: 0,
  collect: () => [],
};
kernel.register(scheduleSensor);
const scheduleFeeder = registerFeeder(kernel, "schedule_probe", "schedule");
const goalFeeder = registerFeeder(kernel, "goal_probe", "goal");
const messageFeeder = registerFeeder(kernel, "message_probe", "message");
const presenceFeeder = registerFeeder(kernel, "presence_probe", "presence");

const chain = new EvaluatorChain({ defaultActorId: () => "probe_user", services });
for (const evaluator of buildBuiltinEvaluators(services)) chain.register(evaluator);

const received: AttentionEvent[] = [];
chain.onEvent((e) => received.push(e));

// 修复前行为 = 缺这行桥接（--legacy 复现）
if (!legacy) bridgeSensorKernelToChain(kernel, chain);

const at = Date.now();
scheduleFeeder({ at, fingerprint: `probe:schedule:${at}`, salience: "high", payload: { nextRunAt: at + 10 * 60_000, nextTitle: "周会" } });
goalFeeder({ at, fingerprint: `probe:goal:${at}`, salience: "medium", payload: { goalId: "g1", title: "会前准备包", body: "已备好", status: "ready" } });
for (let i = 0; i < 3; i++) {
  messageFeeder({ at: at + i, fingerprint: `probe:msg:${at}:${i}`, salience: "low", payload: { sender: `联系人${i}` } });
}
presenceFeeder({ at, fingerprint: `probe:presence:${at}`, salience: "low", payload: { state: "active" } });

void (async () => {
  await chain.flush();
  const kinds = received.map((e) => e.kind);
  console.log(`\n[probe] 模式=${legacy ? "legacy（无桥接，复现修复前）" : "wired（生产桥接）"}`);
  console.log(`[probe] 链收到信号 → 产出事件 ${received.length} 个: ${kinds.join(", ") || "（无）"}`);
  const expect = legacy ? 0 : 2; // meeting_soon(brief) + goal_ready（消息 3 条应触发 unread_burst，见下）
  // unread_burst 需要 30min 窗口内 ≥3 条：feeder at 均为 now → 命中
  const ok = legacy ? received.length === 0 : received.length >= 2 && kinds.includes("meeting_soon") && kinds.includes("goal_ready");
  console.log(`[probe] 结论: ${ok ? "PASS" : "FAIL"}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
