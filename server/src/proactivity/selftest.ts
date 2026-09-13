// 主动性链路自检（fabricSelftest）—— /api/proactivity/selftest 的实现。
//
// 目的：一键验证「传感 → 评估 → 仲裁 → 直达车道 → 管道投递」端到端可用，
// 排查"为什么没跑通"时逐层定位。fire=false 只读预览（不发送）；
// fire=true 实际投递一条测试消息（走真实管道，客户端会收到）。
// 零 LLM。
import type { ProactivePipeline } from "./proactive-pipeline.js";
import type { ArbiterV2 } from "./arbiter-v2.js";
import type { SensorKernel } from "./sensors/kernel.js";
import type { CostCalibrationSnapshot } from "./cost-calibrator.js";

export type FabricSelftestDeps = {
  fire: boolean;
  pipeline: ProactivePipeline;
  primaryActor: () => string | null;
  arbiterV2: ArbiterV2;
  sensorKernel: SensorKernel;
  /** L2 评估器探针（id/订阅流/状态键数） */
  evaluatorProbes?: () => Array<{ id: string; streams: string[]; stateKeys: number; tickEveryMs?: number }>;
  /** 成本校准快照（接受率 → alert 阈值） */
  calibration?: () => CostCalibrationSnapshot;
};

export async function fabricSelftest(deps: FabricSelftestDeps): Promise<Record<string, unknown>> {
  const actorId = deps.primaryActor() ?? "local_user";
  const snapshot = deps.arbiterV2.snapshot(actorId);
  const preview = {
    interrupt: deps.arbiterV2.previewDecision("interrupt", actorId),
    alert: deps.arbiterV2.previewDecision("alert", actorId),
    normal: deps.arbiterV2.previewDecision("normal", actorId),
  };
  const sensors = deps.sensorKernel.health().map((h) => ({
    id: h.sensorId,
    stream: h.stream,
    mode: h.mode,
    alive: !h.tripped && h.lastOkAt !== null,
    lastOkAt: h.lastOkAt,
    tripped: h.tripped,
    lastError: h.lastError,
  }));
  const layers: Record<string, unknown> = {
    L1_sensors: sensors,
    L2_evaluators: deps.evaluatorProbes?.() ?? "not wired",
    L3_context: snapshot,
    L3_cost: interruptCostOf(deps.arbiterV2, actorId),
    L3_preview: preview,
    L3_parked: deps.arbiterV2.parkedEntries(),
    L4_goals: undefined,
    calibration: deps.calibration?.() ?? "not wired",
  };
  if (!deps.fire) {
    return {
      actorId,
      mode: "preview",
      layers,
      hint: "逐层检查：L1 传感器存活 → L2 评估器状态 → L3 打断成本/裁决预览；fire=1 实际投递一条测试消息",
    };
  }
  // fire=true：走真实管道直投（模板文案，带 deliveryId，客户端可回 outcome）
  const decision = deps.pipeline.submitProposal({
    proposalId: `selftest_${Date.now().toString(36)}`,
    actorId,
    kind: "life_reminder",
    tier: "must",
    importance: "medium",
    dedupKey: `selftest:${Math.floor(Date.now() / 60_000)}`,
    title: "主动性链路自检",
    summary: "这是主动性链路自检消息：传感→评估→仲裁→投递 全链路验证。",
    directText: "链路自检：如果你看到这条消息，说明我的主动性通路是通的。",
    evidence: ["selftest"],
    createdAt: Date.now(),
    source: "selftest",
  });
  return {
    actorId,
    mode: "fired",
    layers,
    delivery: {
      verdict: decision.verdict,
      reasonChain: decision.reasonChain,
      note: decision.verdict === "delivered" ? "客户端应已收到测试消息" : `未即时投递（${decision.reasonChain.join(";")}）`,
    },
  };
}

function interruptCostOf(arbiter: ArbiterV2, actorId: string): number {
  // previewDecision 内部即按当前快照算成本；取 normal 档成本值
  return arbiter.previewDecision("normal", actorId).cost;
}
