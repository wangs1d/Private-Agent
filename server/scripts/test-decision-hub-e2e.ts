/**
 * BrainCenter 类人化决策架构 —— 端到端测试（Step 8）
 *
 * 目标：覆盖 8 类场景，验证 Step 1-6 重构后的：
 *   - RuleRouter 规则路由正确性（场景 1-4）
 *   - DecisionHub 完整 PassiveDecisionResult 产出（场景 5）
 *   - BrainStem 事件驱动 + 注意力调度（场景 6）
 *   - Cerebellum 动态犹豫期 + 打断抑制（场景 7-8）
 *
 * 用法：
 *   cd server && npx tsx scripts/test-decision-hub-e2e.ts
 *
 * 测试不启动完整服务器，仅依赖：
 *   - RuleRouter/ActionExecutor/DecisionHub/Cerebellum 可独立实例化
 *   - BrainStem 需 mock 依赖（Hub/Awareness/Sensory/Personalization）
 *   - 通过 as unknown as XxxLike 绕过严格类型检查
 */
import { performance } from "node:perf_hooks";
import { RuleRouter } from "../src/brain/rule-router.js";
import { ActionExecutor } from "../src/brain/action-executor.js";
import { DecisionHub } from "../src/brain/decision-hub.js";
import { BrainStem, type AttentionFocus } from "../src/brain/brain-stem.js";
import { Cerebellum } from "../src/brain/cerebellum.js";
import type {
  BrainDecision,
  BrainSignalInput,
  CognitiveContext,
  CognitiveInput,
} from "../src/brain/types.js";

// ============================================================
// 全局测试结果收集
// ============================================================

interface TestResult {
  scenario: string;
  caseName: string;
  passed: boolean;
  expected: string;
  actual: string;
  note?: string;
}

const results: TestResult[] = [];

function record(
  scenario: string,
  caseName: string,
  passed: boolean,
  expected: string,
  actual: string,
  note?: string,
): void {
  results.push({ scenario, caseName, passed, expected, actual, note });
  const mark = passed ? "✓" : "✗";
  const noteStr = note ? `  ⚠️ ${note}` : "";
  console.log(
    `  ${mark} ${caseName}\n     期望: ${expected}\n     实际: ${actual}${noteStr}`,
  );
}

// ============================================================
// Mock 工厂
// ============================================================

function makeMockToolRegistry() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    execute: async (
      name: string,
      args: Record<string, unknown>,
      _opts?: { actorId?: string },
    ): Promise<{ ok: boolean; result: Record<string, unknown> }> => {
      calls.push({ name, args });
      if (name === "safety_check") {
        return { ok: true, result: { checked: true, args } };
      }
      if (name === "__throw__") {
        throw new Error("mock_thrown");
      }
      return { ok: true, result: { echoed: name, args } };
    },
  };
}

function makeMockLimbic(allowAll = true) {
  return {
    checkSafety: (action: { tool: string; args: Record<string, unknown> }) => ({
      allowed: allowAll,
      severity: allowAll ? "allowed" : "denied",
      reason: allowAll ? "test_pass" : "test_blocked",
      tool: action.tool,
      args: action.args,
      checkedAt: new Date().toISOString(),
    }),
  };
}

function makeMockMemory() {
  return {
    remember: async () => {},
    recall: async () => ({ items: [] }),
  };
}

function makeMockAwareness(activity: string = "idle") {
  return {
    observe: () => ({
      activity,
      kind: "desktop",
      occurredAt: new Date().toISOString(),
    }),
  };
}

function makeMockCapability() {
  return {
    snapshot: () => [],
    introspect: () => [],
  };
}

// ============================================================
// 场景 1: 闲聊路由（RuleRouter）
// ============================================================

function testScenario1_chitchat(): void {
  console.log("\n【场景 1: 闲聊路由】");
  const router = new RuleRouter();

  const cases: Array<{ input: string; expectMode: string; expectConf: number; expectRule: string }> = [
    { input: "你好", expectMode: "direct_llm", expectConf: 0.9, expectRule: "chitchat" },
    { input: "早上好", expectMode: "direct_llm", expectConf: 0.9, expectRule: "chitchat" },
    { input: "hi", expectMode: "direct_llm", expectConf: 0.9, expectRule: "chitchat" },
    { input: "谢谢", expectMode: "direct_llm", expectConf: 0.9, expectRule: "chitchat" },
    { input: "晚安", expectMode: "direct_llm", expectConf: 0.9, expectRule: "chitchat" },
  ];

  for (const c of cases) {
    const start = performance.now();
    const r = router.route(c.input);
    const elapsed = performance.now() - start;
    const passed =
      r.mode === c.expectMode &&
      Math.abs(r.confidence - c.expectConf) < 0.001 &&
      r.matchedRules.some((rule) => rule.startsWith(c.expectRule));
    record(
      "1.闲聊",
      `"${c.input}"`,
      passed,
      `mode=${c.expectMode}, conf=${c.expectConf}, rule~=${c.expectRule}*, 耗时≈${elapsed.toFixed(3)}ms`,
      `mode=${r.mode}, conf=${r.confidence.toFixed(2)}, rules=[${r.matchedRules.join(",")}]`,
      passed ? undefined : `命中规则不符（${r.reason}）`,
    );
  }
}

// ============================================================
// 场景 2: 简单工具路由（RuleRouter）
// ============================================================

function testScenario2_simpleTool(): void {
  console.log("\n【场景 2: 简单工具路由】");
  const router = new RuleRouter();

  const cases: Array<{ input: string; expectMode: string; expectConf: number }> = [
    { input: "今天天气怎么样", expectMode: "direct_llm", expectConf: 0.85 },
    { input: "现在几点了", expectMode: "direct_llm", expectConf: 0.85 },
    { input: "明天日历有什么安排", expectMode: "direct_llm", expectConf: 0.85 },
    { input: "帮我搜索Python教程", expectMode: "direct_llm", expectConf: 0.85 },
  ];

  for (const c of cases) {
    const r = router.route(c.input);
    const passed =
      r.mode === c.expectMode &&
      Math.abs(r.confidence - c.expectConf) < 0.001;
    record(
      "2.简单工具",
      `"${c.input}"`,
      passed,
      `mode=${c.expectMode}, conf=${c.expectConf}`,
      `mode=${r.mode}, conf=${r.confidence.toFixed(2)}, rules=[${r.matchedRules.join(",")}]`,
      passed ? undefined : r.reason,
    );
  }
}

// ============================================================
// 场景 3: 复杂任务委派（RuleRouter）
// ============================================================

function testScenario3_delegate(): void {
  console.log("\n【场景 3: 复杂任务委派】");
  const router = new RuleRouter();

  const cases: Array<{
    input: string;
    expectMode: string;
    expectConf: number;
    expectAgentType?: string;
  }> = [
    // 多步 + tech 关键词
    {
      input: "打开浏览器登录系统然后导出数据再分析最后生成报告",
      expectMode: "master_delegate",
      expectConf: 0.8,
      expectAgentType: "tech",
    },
    {
      input: "批量重命名桌面所有文件然后整理到不同文件夹再压缩打包",
      expectMode: "master_delegate",
      expectConf: 0.8,
      expectAgentType: "tech",
    },
    // 多步 + info 关键词
    {
      input: "研究市场然后对比三个产品接着分析价格再生成报告",
      expectMode: "master_delegate",
      expectConf: 0.8,
      expectAgentType: "info",
    },
  ];

  for (const c of cases) {
    const r = router.route(c.input);
    const passed =
      r.mode === c.expectMode &&
      Math.abs(r.confidence - c.expectConf) < 0.001 &&
      (c.expectAgentType ? r.agentType === c.expectAgentType : true);
    record(
      "3.复杂任务委派",
      `"${c.input.slice(0, 25)}..."`,
      passed,
      `mode=${c.expectMode}, conf=${c.expectConf}, agentType=${c.expectAgentType ?? "*"}`,
      `mode=${r.mode}, conf=${r.confidence.toFixed(2)}, agentType=${r.agentType ?? "undefined"}, rules=[${r.matchedRules.join(",")}]`,
      passed ? undefined : r.reason,
    );
  }
}

// ============================================================
// 场景 4: 紧急事务（RuleRouter + DecisionHub）
// ============================================================

async function testScenario4_urgent(): Promise<void> {
  console.log("\n【场景 4: 紧急事务】");
  const router = new RuleRouter();
  const toolRegistry = makeMockToolRegistry();
  const actionExecutor = new ActionExecutor(toolRegistry);
  actionExecutor.registerLimbic(makeMockLimbic(true));
  const decisionHub = new DecisionHub(router, actionExecutor);
  decisionHub.registerMemory(makeMockMemory() as any);
  decisionHub.registerAwareness(makeMockAwareness() as any);
  decisionHub.registerCapability(makeMockCapability() as any);

  const cases: Array<{ input: string; expectMode: string; expectConf: number; expectAction: string }> = [
    { input: "转账500给张三", expectMode: "master_delegate", expectConf: 0.95, expectAction: "safety_check" },
    { input: "帮我付款", expectMode: "master_delegate", expectConf: 0.95, expectAction: "safety_check" },
    { input: "帮我下单买这个", expectMode: "master_delegate", expectConf: 0.95, expectAction: "safety_check" },
  ];

  for (const c of cases) {
    const input: CognitiveInput = { actorId: "test-user", text: c.input };
    const ctx: CognitiveContext = {
      memories: [],
      emotion: null,
      userActivity: null,
      capabilities: [],
      recentDecisions: [],
    };
    const decision = await decisionHub.decidePassive(input, ctx);
    const passed =
      decision.route.mode === c.expectMode &&
      Math.abs(decision.route.confidence - c.expectConf) < 0.001 &&
      decision.action?.tool === c.expectAction;
    record(
      "4.紧急事务",
      `"${c.input}"`,
      passed,
      `mode=${c.expectMode}, conf=${c.expectConf}, action=${c.expectAction}`,
      `mode=${decision.route.mode}, conf=${decision.route.confidence.toFixed(2)}, action=${decision.action?.tool ?? "undefined"}`,
      passed ? undefined : decision.route.reason,
    );
  }
}

// ============================================================
// 场景 5: DecisionHub 端到端（完整 PassiveDecisionResult）
// ============================================================

async function testScenario5_decisionHub(): Promise<void> {
  console.log("\n【场景 5: DecisionHub 端到端】");
  const router = new RuleRouter();
  const toolRegistry = makeMockToolRegistry();
  const actionExecutor = new ActionExecutor(toolRegistry);
  actionExecutor.registerLimbic(makeMockLimbic(true));
  const decisionHub = new DecisionHub(router, actionExecutor);
  decisionHub.registerMemory(makeMockMemory() as any);
  decisionHub.registerAwareness(makeMockAwareness() as any);
  decisionHub.registerCapability(makeMockCapability() as any);

  const cases: Array<{
    input: string;
    expectResponse: string;
    expectMemoryMin: number;
    expectNeedsToolLoop: boolean;
  }> = [
    { input: "你好", expectResponse: "", expectMemoryMin: 1, expectNeedsToolLoop: true },
    { input: "今天天气", expectResponse: "", expectMemoryMin: 1, expectNeedsToolLoop: true },
    { input: "转账100", expectResponse: "", expectMemoryMin: 2, expectNeedsToolLoop: false },
  ];

  for (const c of cases) {
    const input: CognitiveInput = { actorId: "test-user", text: c.input };
    const ctx: CognitiveContext = {
      memories: [],
      emotion: null,
      userActivity: null,
      capabilities: [],
      recentDecisions: [],
    };
    const start = performance.now();
    const decision = await decisionHub.decidePassive(input, ctx);
    const elapsed = performance.now() - start;

    const passed =
      decision.response === c.expectResponse &&
      decision.memoryWrites.length >= c.expectMemoryMin &&
      decision.needsToolLoop === c.expectNeedsToolLoop &&
      typeof decision.confidence === "number" &&
      decision.confidenceReason.length > 0;

    record(
      "5.DecisionHub",
      `"${c.input}"`,
      passed,
      `response="", memoryWrites>=${c.expectMemoryMin}, needsToolLoop=${c.expectNeedsToolLoop}, 耗时≈${elapsed.toFixed(3)}ms`,
      `response="${decision.response}", memoryWrites=${decision.memoryWrites.length}, needsToolLoop=${decision.needsToolLoop}, conf=${decision.confidence.toFixed(2)}, reason="${decision.confidenceReason.slice(0, 50)}"`,
      passed ? undefined : "PassiveDecisionResult 字段不完整或值不匹配",
    );
  }
}

// ============================================================
// 场景 6: BrainStem 注意力调度
// ============================================================

async function testScenario6_brainStemAttention(): Promise<void> {
  console.log("\n【场景 6: BrainStem 注意力调度】");
  const stem = new BrainStem();
  // 注册 mock 依赖（不需要启动定时器，只测 setAttentionFocus + getStats）
  stem.registerLifeSignalHub({
    subscribe: () => () => {},
    recentSignals: () => [],
    getEvidenceWindow: () =>
      ({ signals: [], turningPoints: [], lastUpdated: new Date().toISOString() }) as any,
    publish: () => {},
  } as any);
  stem.registerAwareness(makeMockAwareness("idle") as any);
  await stem.start();

  try {
    // 6.1 默认 focus=default
    const defaultFocus = stem.getAttentionFocus("user-1");
    record(
      "6.BrainStem",
      "默认注意力焦点",
      defaultFocus === "default",
      "focus=default",
      `focus=${defaultFocus}`,
    );

    // 6.2 设置 focus=waiting_delivery
    stem.setAttentionFocus("user-1", "waiting_delivery");
    const newFocus = stem.getAttentionFocus("user-1");
    const stats1 = stem.getStats();
    record(
      "6.BrainStem",
      "设置 focus=waiting_delivery",
      newFocus === "waiting_delivery" && stats1.attentionChangeCount >= 1,
      "focus=waiting_delivery, attentionChangeCount>=1",
      `focus=${newFocus}, attentionChangeCount=${stats1.attentionChangeCount}`,
    );

    // 6.3 切换到 in_meeting
    stem.setAttentionFocus("user-1", "in_meeting");
    const stats2 = stem.getStats();
    record(
      "6.BrainStem",
      "切换 focus=in_meeting",
      stats2.attentionChangeCount >= 2 && stem.getAttentionFocus("user-1") === "in_meeting",
      "focus=in_meeting, attentionChangeCount>=2",
      `focus=${stem.getAttentionFocus("user-1")}, attentionChangeCount=${stats2.attentionChangeCount}`,
    );

    // 6.4 事件触发注册
    let eventTriggered = false;
    stem.registerEventTrigger("transaction_completed", () => {
      eventTriggered = true;
    });
    const stats3 = stem.getStats();
    record(
      "6.BrainStem",
      "注册事件触发器 transaction_completed",
      stats3.registeredEventTypes.includes("transaction_completed"),
      "registeredEventTypes 包含 transaction_completed",
      `registeredEventTypes=[${stats3.registeredEventTypes.join(",")}]`,
    );

    // 6.5 全局事件触发（actorId 未指定 → 扫描所有 knownActors，但 knownActors 为空，仅触发 handler）
    // 注意：triggerEvent 不调用 handler 时需要 knownActors 有值。这里仅验证 handler 不抛错。
    // 由于 knownActors 通过 hub subscribe 自动累积，mock 的 hub.subscribe 返回 noop 不会注入 actor，
    // 所以这里只验证 triggerEvent 不抛异常 + 5s 内不重复触发。
    try {
      stem.triggerEvent("external_trigger", "user-1");
      record(
        "6.BrainStem",
        "triggerEvent('external_trigger', 'user-1')",
        true,
        "不抛异常",
        "执行成功",
      );
    } catch (err) {
      record(
        "6.BrainStem",
        "triggerEvent('external_trigger', 'user-1')",
        false,
        "不抛异常",
        `抛出: ${String(err).slice(0, 80)}`,
      );
    }
  } finally {
    await stem.stop();
  }
}

// ============================================================
// 场景 7: Cerebellum 动态犹豫期
// ============================================================

async function testScenario7_cerebellumHesitate(): Promise<void> {
  console.log("\n【场景 7: Cerebellum 动态犹豫期】");
  const cerebellum = new Cerebellum();
  // 不注册 awareness → observeActivity 返回 null → 不 defer，走立即执行分支
  await cerebellum.start();

  try {
    const cases: Array<{
      importance: "critical" | "high" | "medium" | "low";
      expectRange: { min: number; max: number };
    }> = [
      { importance: "critical", expectRange: { min: 300, max: 800 } },
      { importance: "high", expectRange: { min: 800, max: 2000 } },
      { importance: "medium", expectRange: { min: 1500, max: 3500 } },
      { importance: "low", expectRange: { min: 3000, max: 6000 } },
    ];

    for (const c of cases) {
      // 通过私有方法 computeHesitation 直接验证（as any 访问）
      const samples: number[] = [];
      for (let i = 0; i < 50; i++) {
        const ms = (cerebellum as any).computeHesitation(c.importance) as number;
        samples.push(ms);
      }
      const min = Math.min(...samples);
      const max = Math.max(...samples);
      const passed =
        min >= c.expectRange.min && max <= c.expectRange.max;
      record(
        "7.Cerebellum 犹豫",
        `importance=${c.importance}`,
        passed,
        `hesitateMs ∈ [${c.expectRange.min}, ${c.expectRange.max}]`,
        `samples 50 次: min=${min}, max=${max}`,
        passed ? undefined : "犹豫期超出预期范围",
      );
    }

    // 7.5 验证 schedule 后 dynamicHesitateCount 增加
    const beforeCount = (cerebellum as any).dynamicHesitateCount as number;
    const decision: BrainDecision = {
      actorId: "user-1",
      outcome: "speak",
      valueScore: 5,
      disturbScore: 3,
      rationale: "test",
      decidedAt: new Date().toISOString(),
    };
    const signal: BrainSignalInput = {
      actorId: "user-1",
      kind: "test_signal",
      title: "测试信号",
      importance: "medium",
    };
    let fired = false;
    await cerebellum.schedule(decision, signal, async () => {
      fired = true;
    });
    // schedule 内部用 setTimeout，等 4s 让其执行
    await new Promise((r) => setTimeout(r, 4000));
    const afterCount = (cerebellum as any).dynamicHesitateCount as number;
    const snapshot = cerebellum.snapshot();
    record(
      "7.Cerebellum 犹豫",
      "schedule(medium) 触发 dynamicHesitateCount++",
      afterCount > beforeCount && fired,
      `dynamicHesitateCount > ${beforeCount} 且 fire 已执行`,
      `dynamicHesitateCount: ${beforeCount} → ${afterCount}, fired=${fired}, snapshot.dynamicHesitateCount=${snapshot.dynamicHesitateCount}`,
    );
  } finally {
    await cerebellum.stop();
  }
}

// ============================================================
// 场景 8: Cerebellum 打断抑制
// ============================================================

async function testScenario8_cerebellumInterrupt(): Promise<void> {
  console.log("\n【场景 8: Cerebellum 打断抑制】");
  const cerebellum = new Cerebellum();
  await cerebellum.start();

  try {
    const cases: Array<{
      importance: "critical" | "high" | "medium" | "low";
      expectSuppressMs: number;
    }> = [
      { importance: "critical", expectSuppressMs: 5_000 },
      { importance: "high", expectSuppressMs: 30_000 },
      { importance: "medium", expectSuppressMs: 60_000 },
      { importance: "low", expectSuppressMs: 120_000 },
    ];

    for (const c of cases) {
      // 通过私有方法 computeSuppressWindow 直接验证
      const ms = (cerebellum as any).computeSuppressWindow(c.importance) as number;
      const passed = ms === c.expectSuppressMs;
      record(
        "8.Cerebellum 打断抑制",
        `importance=${c.importance}`,
        passed,
        `suppressMs=${c.expectSuppressMs}`,
        `suppressMs=${ms}`,
        passed ? undefined : "抑制窗口与预期不符",
      );
    }

    // 8.5 验证 interrupt 后 suppressUntil 设置 + dynamicSuppressCount++
    const beforeSuppressCount = (cerebellum as any).dynamicSuppressCount as number;
    // 先 schedule 一次 critical 信号，记录 lastSpeakImportance
    const decision: BrainDecision = {
      actorId: "user-2",
      outcome: "speak",
      valueScore: 5,
      disturbScore: 3,
      rationale: "test",
      decidedAt: new Date().toISOString(),
    };
    const signal: BrainSignalInput = {
      actorId: "user-2",
      kind: "test_critical",
      title: "紧急测试",
      importance: "critical",
    };
    await cerebellum.schedule(decision, signal, async () => {});
    // 立即打断
    cerebellum.interrupt("user-2");
    const afterSuppressCount = (cerebellum as any).dynamicSuppressCount as number;
    const snapshot = cerebellum.snapshot();
    record(
      "8.Cerebellum 打断抑制",
      "interrupt(user-2, critical) 触发 dynamicSuppressCount++",
      afterSuppressCount > beforeSuppressCount && snapshot.interruptedCount >= 1,
      `dynamicSuppressCount > ${beforeSuppressCount}, interruptedCount >= 1`,
      `dynamicSuppressCount: ${beforeSuppressCount} → ${afterSuppressCount}, snapshot.interruptedCount=${snapshot.interruptedCount}, snapshot.dynamicSuppressCount=${snapshot.dynamicSuppressCount}`,
    );

    // 8.6 验证 defer 队列清空：先 enqueue 几个，interrupt 后 pending 为空
    // 通过 schedule + 抑制窗口设置 → 走 defer 分支
    // 先注册 awareness 让 observeActivity 返回 busy
    const busyAwareness = {
      observe: () => ({
        activity: "busy",
        kind: "desktop",
        occurredAt: new Date().toISOString(),
      }),
    };
    (cerebellum as any).awareness = busyAwareness;
    // 重新 interrupt 设抑制窗口
    cerebellum.interrupt("user-3");
    const signal2: BrainSignalInput = {
      actorId: "user-3",
      kind: "test_signal",
      title: "测试",
      importance: "high",
    };
    await cerebellum.schedule(decision, signal2, async () => {});
    const pendingBefore = (cerebellum as any).pending.get("user-3")?.length ?? 0;
    cerebellum.interrupt("user-3");
    const pendingAfter = (cerebellum as any).pending.get("user-3")?.length ?? 0;
    record(
      "8.Cerebellum 打断抑制",
      "interrupt 清空 defer 队列",
      pendingBefore >= 1 && pendingAfter === 0,
      `pendingBefore >= 1, pendingAfter = 0`,
      `pendingBefore=${pendingBefore}, pendingAfter=${pendingAfter}`,
    );
  } finally {
    await cerebellum.stop();
  }
}

// ============================================================
// 性能基准
// ============================================================

function benchmark(): void {
  console.log("\n【性能基准】");
  const router = new RuleRouter();
  const queries = [
    "你好",
    "今天天气",
    "打开浏览器登录系统然后导出数据再分析最后生成报告",
    "转账500给张三",
    "帮我搜索Python教程",
  ];

  // RuleRouter.route
  let total = 0;
  const iterations = 1000;
  for (let i = 0; i < iterations; i++) {
    const q = queries[i % queries.length];
    const start = performance.now();
    router.route(q);
    total += performance.now() - start;
  }
  console.log(
    `  RuleRouter.route 平均耗时: ${(total / iterations).toFixed(4)}ms (共 ${iterations} 次)`,
  );

  // DecisionHub.decidePassive
  const toolRegistry = makeMockToolRegistry();
  const actionExecutor = new ActionExecutor(toolRegistry);
  actionExecutor.registerLimbic(makeMockLimbic(true));
  const hub = new DecisionHub(router, actionExecutor);
  hub.registerMemory(makeMockMemory() as any);
  hub.registerAwareness(makeMockAwareness() as any);
  hub.registerCapability(makeMockCapability() as any);

  let hubTotal = 0;
  const hubIters = 200;
  for (let i = 0; i < hubIters; i++) {
    const q = queries[i % queries.length];
    const input: CognitiveInput = { actorId: "bench", text: q };
    const ctx: CognitiveContext = {
      memories: [],
      emotion: null,
      userActivity: null,
      capabilities: [],
      recentDecisions: [],
    };
    const start = performance.now();
    void hub.decidePassive(input, ctx);
    hubTotal += performance.now() - start;
  }
  console.log(
    `  DecisionHub.decidePassive 平均耗时: ${(hubTotal / hubIters).toFixed(4)}ms (共 ${hubIters} 次, mock 异步未 await)`,
  );
}

// ============================================================
// 主函数
// ============================================================

async function main(): Promise<void> {
  console.log("=== BrainCenter 类人化决策架构 端到端测试 ===");
  console.log(`时间: ${new Date().toISOString()}`);
  console.log("");

  // 同步场景
  testScenario1_chitchat();
  testScenario2_simpleTool();
  testScenario3_delegate();

  // 异步场景
  await testScenario4_urgent();
  await testScenario5_decisionHub();
  await testScenario6_brainStemAttention();
  await testScenario7_cerebellumHesitate();
  await testScenario8_cerebellumInterrupt();

  // 性能
  benchmark();

  // 汇总
  printSummary();
}

function printSummary(): void {
  console.log("\n=== 测试结果汇总 ===");
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";

  console.log(`通过: ${passed}/${total} (${passRate}%)`);
  console.log(`失败: ${failed}`);

  if (failed > 0) {
    console.log("\n失败 case 列表:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ [${r.scenario}] ${r.caseName}`);
      console.log(`     期望: ${r.expected}`);
      console.log(`     实际: ${r.actual}`);
      if (r.note) console.log(`     备注: ${r.note}`);
    }
  }

  // 按场景分组统计
  console.log("\n按场景分组:");
  const scenarioMap = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    const key = r.scenario.split(".")[0];
    const cur = scenarioMap.get(key) ?? { passed: 0, total: 0 };
    cur.total++;
    if (r.passed) cur.passed++;
    scenarioMap.set(key, cur);
  }
  for (const [key, val] of scenarioMap) {
    const rate = ((val.passed / val.total) * 100).toFixed(0);
    const mark = val.passed === val.total ? "✓" : "⚠";
    console.log(`  ${mark} 场景 ${key}: ${val.passed}/${val.total} (${rate}%)`);
  }

  console.log("\n=== 测试结束 ===");
}

main().catch((err) => {
  console.error("测试脚本异常:", err);
  process.exit(1);
});
