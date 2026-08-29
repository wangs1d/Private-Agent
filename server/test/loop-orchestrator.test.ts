/**
 * Loop Orchestrator 单元测试
 *
 * 覆盖 P1+P2 核心模块：
 * - shared-task-context: 上下文创建、工具历史追加、失败聚合、预算耗尽
 * - default-termination: 四种终止原因触发条件
 * - tool-metadata: 分类查询、alternatives、buildRecoveryHint
 * - default-recovery: 确定性 fallback 链
 * - loop-orchestrator: finished=true 直接终止、单向升级校验
 *
 * 运行：npx tsx --test test/loop-orchestrator.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSharedTaskContext,
  appendToolCall,
  appendFailure,
  isBudgetExhausted,
  type SharedTaskContext,
  type TaskSeed,
} from "../src/agent/loop/shared-task-context.js";
import { DefaultTerminationPolicy } from "../src/agent/loop/default-termination.js";
import { DefaultRecoveryPolicy } from "../src/agent/loop/default-recovery.js";
import { DefaultProgressTracker } from "../src/agent/loop/default-progress.js";
import { DefaultEscalationPolicy } from "../src/agent/loop/default-escalation.js";
import {
  getToolCategory,
  getToolAlternatives,
  getSameCategoryTools,
  buildRecoveryHint,
} from "../src/agent/loop/tool-metadata.js";
import { LoopOrchestrator } from "../src/agent/loop/loop-orchestrator.js";
import type { LoopStrategy, LoopRunParams, LoopRunResult } from "../src/agent/loop/loop-strategy.js";
import type { LlmExecutionMode } from "../src/agent/task-router.js";

// ────────────────────────────────────────────────────────────
// 辅助：构造测试用 ctx / strategy
// ────────────────────────────────────────────────────────────

function makeSeed(overrides: Partial<TaskSeed> = {}): TaskSeed {
  return {
    taskId: "test-task",
    actorId: "test-actor",
    sessionId: "test-session",
    goal: "测试目标",
    initialMode: "fast",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<TaskSeed> = {}): SharedTaskContext {
  return createSharedTaskContext(makeSeed(overrides));
}

/** 假 strategy：按预设返回 result，用于测试编排器控制流 */
class FakeStrategy implements LoopStrategy {
  readonly mode: LlmExecutionMode;
  constructor(
    mode: LlmExecutionMode,
    private readonly resultFactory: (ctx: SharedTaskContext) => LoopRunResult,
    private readonly canHandleFn: (ctx: SharedTaskContext) => boolean = () => true,
  ) {
    this.mode = mode;
  }
  canHandle(ctx: SharedTaskContext): boolean {
    return this.canHandleFn(ctx);
  }
  async run(ctx: SharedTaskContext, _params: LoopRunParams): Promise<LoopRunResult> {
    const result = this.resultFactory(ctx);
    ctx.budget.roundsUsed += 1;
    ctx.budget.modelCallsUsed += result.modelCalls;
    return result;
  }
}

const noopParams = {} as LoopRunParams;

// ────────────────────────────────────────────────────────────
// shared-task-context
// ────────────────────────────────────────────────────────────

describe("SharedTaskContext", () => {
  it("createSharedTaskContext 初始化所有字段", () => {
    const ctx = makeCtx({ maxRounds: 5 });
    assert.equal(ctx.taskId, "test-task");
    assert.equal(ctx.goal, "测试目标");
    assert.equal(ctx.currentLoop, "fast");
    assert.equal(ctx.plan, null);
    assert.equal(ctx.toolHistory.length, 0);
    assert.equal(ctx.failures.length, 0);
    assert.equal(ctx.budget.maxRounds, 5);
    assert.equal(ctx.budget.roundsUsed, 0);
    assert.equal(ctx.progress.consecutiveFailures, 0);
    assert.equal(ctx.progress.consecutiveNoProgress, 0);
  });

  it("appendToolCall 成功调用重置 consecutiveFailures", () => {
    const ctx = makeCtx();
    appendToolCall(ctx, {
      round: 0, loop: "fast", name: "search_web", args: {},
      ok: false, resultSummary: "", durationMs: 100, timestamp: Date.now(),
    });
    assert.equal(ctx.progress.consecutiveFailures, 1);
    appendToolCall(ctx, {
      round: 0, loop: "fast", name: "search_web", args: {},
      ok: true, resultSummary: "", durationMs: 100, timestamp: Date.now(),
    });
    assert.equal(ctx.progress.consecutiveFailures, 0);
  });

  it("appendToolCall 维持 MAX_TOOL_HISTORY 上限", () => {
    const ctx = makeCtx();
    for (let i = 0; i < 150; i++) {
      appendToolCall(ctx, {
        round: i, loop: "fast", name: `tool_${i}`, args: {},
        ok: true, resultSummary: "", durationMs: 10, timestamp: Date.now(),
      });
    }
    assert.equal(ctx.toolHistory.length, 100);
    assert.equal(ctx.toolHistory[0].name, "tool_50");
  });

  it("appendFailure 按 toolName 聚合 attempts", () => {
    const ctx = makeCtx();
    const base = {
      toolName: "desktop.open", category: "desktop", args: {},
      error: "not found", attempts: 1, timestamp: Date.now(),
    };
    appendFailure(ctx, { ...base });
    appendFailure(ctx, { ...base });
    appendFailure(ctx, { ...base });
    assert.equal(ctx.failures.length, 1);
    // 首次插入 attempts=1，后续两次聚合各 +=1
    assert.equal(ctx.failures[0].attempts, 3);
  });

  it("isBudgetExhausted 检测轮次/模型调用/时长", () => {
    const ctx = makeCtx({ maxRounds: 2 });
    assert.equal(isBudgetExhausted(ctx), false);
    ctx.budget.roundsUsed = 2;
    assert.equal(isBudgetExhausted(ctx), true);

    const ctx2 = makeCtx({ maxModelCalls: 1 });
    ctx2.budget.modelCallsUsed = 1;
    assert.equal(isBudgetExhausted(ctx2), true);

    const ctx3 = makeCtx({ maxDurationMs: 100 });
    ctx3.budget.startedAt = Date.now() - 200;
    assert.equal(isBudgetExhausted(ctx3), true);
  });
});

// ────────────────────────────────────────────────────────────
// default-termination
// ────────────────────────────────────────────────────────────

describe("DefaultTerminationPolicy", () => {
  it("budget_exhausted 优先级最高", () => {
    const policy = new DefaultTerminationPolicy();
    const ctx = makeCtx({ maxRounds: 1 });
    ctx.budget.roundsUsed = 1;
    const decision = policy.shouldTerminate(ctx);
    assert.equal(decision.terminate, true);
    assert.equal(decision.reason, "budget_exhausted");
    assert.ok(decision.hint);
  });

  it("max_consecutive_failures 达阈值终止", () => {
    const policy = new DefaultTerminationPolicy({ maxConsecutiveFailures: 3 });
    const ctx = makeCtx();
    ctx.progress.consecutiveFailures = 3;
    const decision = policy.shouldTerminate(ctx);
    assert.equal(decision.terminate, true);
    assert.equal(decision.reason, "max_consecutive_failures");
  });

  it("no_progress 达阈值终止", () => {
    const policy = new DefaultTerminationPolicy({ maxConsecutiveNoProgress: 2 });
    const ctx = makeCtx();
    ctx.progress.consecutiveNoProgress = 2;
    const decision = policy.shouldTerminate(ctx);
    assert.equal(decision.terminate, true);
    assert.equal(decision.reason, "no_progress");
  });

  it("goal_met 匹配完成标记", () => {
    const policy = new DefaultTerminationPolicy();
    const ctx = makeCtx();
    ctx.finalText = "任务已完成，结果如下";
    const decision = policy.shouldTerminate(ctx);
    assert.equal(decision.terminate, true);
    assert.equal(decision.reason, "goal_met");
  });

  it("正常进行中不终止", () => {
    const policy = new DefaultTerminationPolicy();
    const ctx = makeCtx();
    ctx.progress.consecutiveFailures = 1;
    ctx.progress.consecutiveNoProgress = 1;
    ctx.budget.roundsUsed = 1;
    const decision = policy.shouldTerminate(ctx);
    assert.equal(decision.terminate, false);
  });
});

// ────────────────────────────────────────────────────────────
// tool-metadata
// ────────────────────────────────────────────────────────────

describe("tool-metadata", () => {
  it("getToolCategory 已知工具返回正确分类", () => {
    assert.equal(getToolCategory("desktop.open"), "desktop");
    assert.equal(getToolCategory("search_web"), "web");
    assert.equal(getToolCategory("shopping.order.place"), "life");
    assert.equal(getToolCategory("clock.get_current_time"), "clock");
  });

  it("getToolCategory 未知工具返回 misc", () => {
    assert.equal(getToolCategory("unknown_tool"), "misc");
  });

  it("getToolAlternatives 返回显式替代链", () => {
    assert.deepEqual(getToolAlternatives("desktop.open"), [
      "desktop.visual.screenshot", "desktop.run_preset", "desktop.run_shell",
    ]);
    assert.deepEqual(getToolAlternatives("search_web"), ["fetch_web", "info.search"]);
    assert.deepEqual(getToolAlternatives("unknown_tool"), []);
  });

  it("getSameCategoryTools 返回同类其他工具", () => {
    const sameCat = getSameCategoryTools("desktop.open");
    assert.ok(sameCat.includes("desktop.run_preset"));
    assert.ok(sameCat.includes("desktop.uia_query"));
    assert.ok(!sameCat.includes("desktop.open"));
  });

  it("buildRecoveryHint 为有 alternatives 的工具生成提示", () => {
    const hint = buildRecoveryHint("desktop.open", "app not found");
    assert.ok(hint.includes("失败恢复"));
    assert.ok(hint.includes("禁止"));
    assert.ok(hint.includes("desktop.visual.screenshot"));
  });

  it("buildRecoveryHint 无 alternatives 且非 honest 返回空", () => {
    const hint = buildRecoveryHint("clock.get_current_time", "");
    assert.equal(hint, "");
  });

  it("buildRecoveryHint honest 工具即使无 alternatives 也生成禁止假成功约束", () => {
    // wallet.transfer 在 HONEST_FAILURE_TOOLS 但不在 TOOL_ALTERNATIVES
    const hint = buildRecoveryHint("wallet.transfer", "insufficient balance");
    assert.ok(hint.includes("禁止"));
    assert.ok(hint.includes("失败"));
  });
});

// ────────────────────────────────────────────────────────────
// default-recovery
// ────────────────────────────────────────────────────────────

describe("DefaultRecoveryPolicy", () => {
  it("attempts < 阈值 → retry", () => {
    const policy = new DefaultRecoveryPolicy({ maxRetriesBeforeSwitch: 2 });
    const ctx = makeCtx();
    const action = policy.onFailure(ctx, {
      toolName: "desktop.open", category: "desktop", args: {},
      error: "fail", attempts: 1, timestamp: Date.now(),
    });
    assert.equal(action.type, "retry");
  });

  it("attempts >= 阈值且有 alternatives → switch_tool", () => {
    const policy = new DefaultRecoveryPolicy({ maxRetriesBeforeSwitch: 2 });
    const ctx = makeCtx();
    const action = policy.onFailure(ctx, {
      toolName: "desktop.open", category: "desktop", args: {},
      error: "fail", attempts: 2, timestamp: Date.now(),
    });
    assert.equal(action.type, "switch_tool");
    assert.equal(action.alternativeTool, "desktop.visual.screenshot");
    assert.ok(action.injectHint);
  });

  it("无显式 alternatives 但同类有工具 → switch_tool 同类兜底", () => {
    const policy = new DefaultRecoveryPolicy({ maxRetriesBeforeSwitch: 1 });
    const ctx = makeCtx();
    // desktop.run_input 不在 TOOL_ALTERNATIVES，但同 desktop 类有其他工具
    const action = policy.onFailure(ctx, {
      toolName: "desktop.run_input", category: "desktop", args: {},
      error: "fail", attempts: 1, timestamp: Date.now(),
    });
    assert.equal(action.type, "switch_tool");
    assert.ok(action.alternativeTool);
  });

  it("无替代 → escalate", () => {
    const policy = new DefaultRecoveryPolicy({ maxRetriesBeforeSwitch: 1 });
    const ctx = makeCtx();
    const action = policy.onFailure(ctx, {
      toolName: "totally_unknown_tool", category: "misc", args: {},
      error: "fail", attempts: 1, timestamp: Date.now(),
    });
    assert.equal(action.type, "escalate");
    assert.equal(action.escalateTo, "complex");
  });
});

// ────────────────────────────────────────────────────────────
// loop-orchestrator
// ────────────────────────────────────────────────────────────

describe("LoopOrchestrator", () => {
  it("strategy.finished=true → goal_met 立即终止", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    strategies.set("fast", new FakeStrategy("fast", () => ({
      finalText: "完成", finished: true, finishReason: "done",
      toolCalls: [], modelCalls: 1,
    })));
    const orch = new LoopOrchestrator(strategies, {});

    const result = await orch.run(makeSeed(), noopParams);
    assert.equal(result.finished, true);
    assert.equal(result.terminateReason, "goal_met");
    assert.equal(result.finalText, "完成");
    assert.equal(result.modelCalls, 1);
  });

  it("finished=false 且无升级 → 预算耗尽终止", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    // 每轮都返回 finished=false，模拟卡住
    strategies.set("fast", new FakeStrategy("fast", () => ({
      finalText: "", finished: false, finishReason: "max_rounds",
      toolCalls: [], modelCalls: 1,
    })));
    // P4：progress 返回 onTrack=false + continue（不 replan 不 escalate），让循环跑到 budget 耗尽
    const orch = new LoopOrchestrator(strategies, {
      progress: {
        async assess() {
          return { onTrack: false, progressScore: 0.3, recommendation: "continue" };
        },
      },
    });

    const result = await orch.run(makeSeed({ maxRounds: 2 }), noopParams);
    assert.equal(result.finished, false);
    // 跑满 2 轮后 budget_exhausted
    assert.equal(result.terminateReason, "budget_exhausted");
  });

  it("单向升级：fast → complex 允许", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    let directCallCount = 0;
    strategies.set("fast", new FakeStrategy("fast", (ctx) => {
      directCallCount++;
      if (directCallCount === 1) {
        // 第一轮返回 needs_escalation
        return {
          finalText: "", finished: false, finishReason: "needs_escalation",
          toolCalls: [], modelCalls: 1,
        };
      }
      return { finalText: "", finished: false, finishReason: "max_rounds", toolCalls: [], modelCalls: 1 };
    }));
    strategies.set("complex", new FakeStrategy("complex", () => ({
      finalText: "升级后完成", finished: true, finishReason: "done",
      toolCalls: [], modelCalls: 1,
    })));

    // 自定义 escalation：needs_escalation 时升级到 complex
    const orch = new LoopOrchestrator(strategies, {
      escalation: {
        shouldEscalate(_ctx, lastResult) {
          if (lastResult.finishReason === "needs_escalation") {
            return { escalate: true, to: "complex", reason: "test_escalation" };
          }
          return { escalate: false, reason: "no" };
        },
      },
    });

    const result = await orch.run(makeSeed(), noopParams);
    assert.equal(result.finished, true);
    assert.equal(result.finalText, "升级后完成");
    assert.equal(result.loopSwitches.length, 1);
    assert.equal(result.loopSwitches[0].from, "fast");
    assert.equal(result.loopSwitches[0].to, "complex");
  });

  it("单向升级：禁止回退（complex → fast 拒绝）", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    strategies.set("complex", new FakeStrategy("complex", () => ({
      finalText: "", finished: false, finishReason: "needs_escalation",
      toolCalls: [], modelCalls: 1,
    })));
    // fast 即使被 escalation 建议也不应被升级到（方向相反）
    strategies.set("fast", new FakeStrategy("fast", () => ({
      finalText: "不应到这里", finished: true, finishReason: "done",
      toolCalls: [], modelCalls: 1,
    })));

    const orch = new LoopOrchestrator(strategies, {
      escalation: {
        shouldEscalate() {
          return { escalate: true, to: "fast", reason: "try_downgrade" };
        },
      },
    });

    const result = await orch.run(makeSeed({ initialMode: "complex", maxRounds: 2 }), noopParams);
    // 升级被拒绝，needs_escalation 直接终止
    assert.equal(result.finished, false);
    assert.equal(result.terminateReason, "needs_escalation");
    assert.equal(result.loopSwitches.length, 0);
  });

  it("无可用 strategy → no_strategy 终止", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>(); // 空
    const orch = new LoopOrchestrator(strategies, {});
    const result = await orch.run(makeSeed(), noopParams);
    assert.equal(result.finished, false);
    assert.equal(result.terminateReason, "no_strategy");
  });

  // ── P4：complex replan 流程 ──

  it("complex + onTrack=true → goal_met（评估驱动完成，非 strategy.finished）", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    // complex 恒返回 finished=false（P4 行为）
    strategies.set("complex", new FakeStrategy("complex", () => ({
      finalText: "执行完成", finished: false, finishReason: "done",
      toolCalls: [], modelCalls: 2,
    })));
    const orch = new LoopOrchestrator(strategies, {
      progress: {
        async assess() {
          return { onTrack: true, progressScore: 0.9, recommendation: "continue" };
        },
      },
    });
    const result = await orch.run(makeSeed({ initialMode: "complex" }), noopParams);
    assert.equal(result.finished, true);
    assert.equal(result.terminateReason, "goal_met");
    assert.equal(result.finalText, "执行完成");
  });

  it("complex + onTrack=false + replan → replanCount 递增，strategy 检测到 replan 标记", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    let runCount = 0;
    let sawReplanMarker = false;
    strategies.set("complex", new FakeStrategy("complex", (ctx) => {
      runCount++;
      // 第二次运行时检查 replan 标记
      if (ctx.reflections.some((r) => r.body.startsWith("replan:"))) {
        sawReplanMarker = true;
      }
      return { finalText: "执行中", finished: false, finishReason: "done", toolCalls: [], modelCalls: 1 };
    }));
    let assessCount = 0;
    const orch = new LoopOrchestrator(strategies, {
      maxReplans: 2,
      progress: {
        async assess() {
          assessCount++;
          // 前两次返回 replan，第三次返回 onTrack
          if (assessCount <= 2) {
            return { onTrack: false, progressScore: 0.4, deviation: "卡住", recommendation: "replan" };
          }
          return { onTrack: true, progressScore: 0.9, recommendation: "continue" };
        },
      },
    });
    const result = await orch.run(makeSeed({ initialMode: "complex", maxRounds: 10 }), noopParams);
    assert.equal(result.finished, true);
    assert.equal(result.terminateReason, "goal_met");
    assert.equal(result.ctx.replanCount, 2);
    assert.ok(sawReplanMarker, "strategy 应检测到 replan 标记");
  });

  it("complex + replan 耗尽（maxReplans=2）→ replan_exhausted 放弃", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    strategies.set("complex", new FakeStrategy("complex", () => ({
      finalText: "仍未完成", finished: false, finishReason: "done", toolCalls: [], modelCalls: 1,
    })));
    const orch = new LoopOrchestrator(strategies, {
      maxReplans: 2,
      progress: {
        async assess() {
          // 永远返回 replan（模拟持续偏离）
          return { onTrack: false, progressScore: 0.2, deviation: "持续失败", recommendation: "replan" };
        },
      },
    });
    const result = await orch.run(makeSeed({ initialMode: "complex", maxRounds: 10 }), noopParams);
    assert.equal(result.finished, false);
    assert.equal(result.terminateReason, "replan_exhausted");
    assert.equal(result.ctx.replanCount, 2);
    assert.equal(result.finalText, "仍未完成");
  });

  it("complex + recommendation=escalate → 不再升级（已在顶层）", async () => {
    const strategies = new Map<LlmExecutionMode, LoopStrategy>();
    strategies.set("complex", new FakeStrategy("complex", () => ({
      finalText: "complex 执行中", finished: false, finishReason: "done", toolCalls: [], modelCalls: 1,
    })));
    const orch = new LoopOrchestrator(strategies, {
      progress: {
        async assess() {
          return { onTrack: false, progressScore: 0.1, deviation: "严重偏离", recommendation: "escalate" };
        },
      },
      // escalation：即使建议升级，complex 已是顶层，canEscalate 拒绝同级
      escalation: {
        shouldEscalate(_ctx, _lastResult) {
          return { escalate: true, to: "complex", reason: "pe_escalate" };
        },
      },
    });
    const result = await orch.run(makeSeed({ initialMode: "complex", maxRounds: 3 }), noopParams);
    // complex 已是顶层，无法继续升级
    assert.equal(result.loopSwitches.length, 0);
    assert.equal(result.finished, false);
    assert.equal(result.terminateReason, "budget_exhausted");
  });
});

// ────────────────────────────────────────────────────────────
// DefaultProgressTracker（P3）
// ────────────────────────────────────────────────────────────

/** 假 provider：返回预设文本，用于测试 ProgressTracker 的 LLM 评估解析 */
class FakeProvider {
  readonly id = "fake";
  readonly displayLabel = "Fake";
  private nextResponse: string;
  public lastPrompt: string | null = null;
  public clearedSessions: string[] = [];

  constructor(response: string) {
    this.nextResponse = response;
  }
  isEnabled() {
    return true;
  }
  async streamCompletion(
    _sessionId: string,
    userTurn: { text: string },
    _onDelta: (delta: string) => void,
  ): Promise<string> {
    this.lastPrompt = userTurn.text;
    return this.nextResponse;
  }
  clearSession(sessionId: string): void {
    this.clearedSessions.push(sessionId);
  }
}

describe("DefaultProgressTracker", () => {
  it("频率控制：K 轮内不重复评估（规则降级）", async () => {
    const provider = new FakeProvider('{"onTrack":false,"progressScore":0.2,"recommendation":"replan"}');
    const tracker = new DefaultProgressTracker(provider as any, { assessEveryKRounds: 3, minNoProgressToTrigger: 1 });
    const ctx = makeCtx();

    // 第一次：noProgress=0，不触发 LLM，走规则
    ctx.progress.consecutiveNoProgress = 0;
    const a1 = await tracker.assess(ctx);
    assert.equal(a1.recommendation, "continue");
    assert.equal(provider.lastPrompt, null); // 未调 LLM

    // noProgress=1 但 < minNoProgress(1)? 不，minNoProgress=1 时 >=1 触发
    // 但 assessEveryK=3，第一次评估后 lastAssessedRound=0，roundsUsed 仍 0，差值 0 < 3
    // 所以仍走规则
    ctx.progress.consecutiveNoProgress = 1;
    const a2 = await tracker.assess(ctx);
    // 差值 < K，走规则；noProgress>=2 → replan
    assert.equal(a2.recommendation, "continue");
  });

  it("LLM 评估：解析 JSON 响应", async () => {
    const provider = new FakeProvider('{"onTrack":false,"progressScore":0.3,"deviation":"卡在搜索","recommendation":"replan"}');
    const tracker = new DefaultProgressTracker(provider as any, { assessEveryKRounds: 1, minNoProgressToTrigger: 1 });
    const ctx = makeCtx();
    ctx.budget.roundsUsed = 2;
    ctx.progress.consecutiveNoProgress = 2;

    const assessment = await tracker.assess(ctx);
    assert.equal(assessment.onTrack, false);
    assert.equal(assessment.progressScore, 0.3);
    assert.equal(assessment.deviation, "卡在搜索");
    assert.equal(assessment.recommendation, "replan");
    assert.ok(provider.lastPrompt);
    assert.equal(provider.clearedSessions.length, 1); // 评估后清理临时 session
  });

  it("LLM 评估失败 → 降级规则", async () => {
    const provider = new FakeProvider("not a json at all");
    const tracker = new DefaultProgressTracker(provider as any, { assessEveryKRounds: 1, minNoProgressToTrigger: 1 });
    const ctx = makeCtx();
    ctx.budget.roundsUsed = 2;
    ctx.progress.consecutiveNoProgress = 2;

    const assessment = await tracker.assess(ctx);
    // 解析失败降级，noProgress>=2 → replan
    assert.equal(assessment.recommendation, "replan");
  });

  it("正常推进时不触发 LLM", async () => {
    const provider = new FakeProvider("should not be called");
    const tracker = new DefaultProgressTracker(provider as any);
    const ctx = makeCtx();
    ctx.progress.consecutiveNoProgress = 0;

    const assessment = await tracker.assess(ctx);
    assert.equal(assessment.recommendation, "continue");
    assert.equal(provider.lastPrompt, null);
  });
});

// ────────────────────────────────────────────────────────────
// DefaultEscalationPolicy（P3）
// ────────────────────────────────────────────────────────────

describe("DefaultEscalationPolicy", () => {
  const policy = new DefaultEscalationPolicy();

  it("needs_escalation → 升一级", () => {
    const ctx = makeCtx({ initialMode: "fast" });
    const result = { finishReason: "needs_escalation" } as any;
    const dec = policy.shouldEscalate(ctx, result);
    assert.equal(dec.escalate, true);
    assert.equal(dec.to, "complex");
  });

  it("react 连续无进展达阈值 → 升级 complex", () => {
    const ctx = makeCtx({ initialMode: "fast" });
    ctx.progress.consecutiveNoProgress = 3;
    const result = { finishReason: "max_rounds" } as any;
    const dec = policy.shouldEscalate(ctx, result);
    assert.equal(dec.escalate, true);
    assert.equal(dec.to, "complex");
  });

  it("complex + 低分 reflection → 不升级（已在顶层）", () => {
    const ctx = makeCtx({ initialMode: "complex" });
    // 模拟 ProgressTracker 写入的低分 reflection
    ctx.reflections.push({
      loop: "complex", round: 1, body: "偏离", confidence: 0.2,
    });
    const result = { finishReason: "done" } as any;
    const dec = policy.shouldEscalate(ctx, result);
    assert.equal(dec.escalate, false);
    assert.equal(dec.reason, "already_at_top");
  });

  it("已在顶层(complex) → 不升级", () => {
    const ctx = makeCtx({ initialMode: "complex" });
    const result = { finishReason: "needs_escalation" } as any;
    const dec = policy.shouldEscalate(ctx, result);
    assert.equal(dec.escalate, false);
    assert.equal(dec.reason, "already_at_top");
  });

  it("正常进行中 → 不升级", () => {
    const ctx = makeCtx({ initialMode: "fast" });
    ctx.progress.consecutiveNoProgress = 0;
    const result = { finishReason: "done", finished: true } as any;
    const dec = policy.shouldEscalate(ctx, result);
    assert.equal(dec.escalate, false);
  });
});
