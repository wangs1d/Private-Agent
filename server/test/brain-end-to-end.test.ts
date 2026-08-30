/**
 * BrainCenter 端到端架构验证。
 *
 * 验证三阶段端到端流水线：
 *  阶段 1 — 规则预筛（不调 LLM）：policy 硬闸门 + 阈值粗筛 + 重复抑制
 *  阶段 2 — 端到端认知 LLM（仅通过粗筛才走）：一次调用完成判断+话术
 *  阶段 3 — 后置执行：shadow / 缓存 / 记录 speak kind / 话术写入
 *
 * 同时验证 BrainCenter.cognize() 端到端认知入口：
 *  感知并行收集 → 一次认知 LLM → 后置安全/记忆
 *
 * 8 个场景 A-H 覆盖主动决策（ProactionCortex.decide）和被动认知（BrainCenter.cognize）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ProactionCortex, type EndToEndDecisionMaker } from "../src/brain/proaction-cortex.js";
import { BrainCenter } from "../src/brain/brain-center.js";
import type {
  BrainSignalInput,
  CognitiveEngine,
  MemoryItem,
  SystemRouteDecision,
} from "../src/brain/types.js";
import type { ProactiveContactPolicyService } from "../src/services/proactive-contact-policy.js";

// ---- helpers ------------------------------------------------------------

function makeSignal(overrides: Partial<BrainSignalInput> = {}): BrainSignalInput {
  return {
    actorId: "test-user",
    kind: "transaction_completed",
    title: "测试信号",
    importance: "medium",
    ...overrides,
  };
}

/** 临时设置 PROACTION_THRESHOLD，测试结束后恢复 */
async function withThreshold<T>(threshold: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PROACTION_THRESHOLD;
  process.env.PROACTION_THRESHOLD = String(threshold);
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.PROACTION_THRESHOLD;
    else process.env.PROACTION_THRESHOLD = prev;
  }
}

/** 构造一个追踪调用次数的 EndToEndDecisionMaker mock */
function makeTrackingMaker(
  response: { speak: boolean; message: string; reason: string },
): EndToEndDecisionMaker & { callCount: number } {
  const maker = {
    callCount: 0,
    async decide() {
      maker.callCount++;
      return { ...response };
    },
  };
  return maker;
}

// ---- 场景 A: 低价值信号被规则预筛拦截，不进端到端 LLM --------------------

test("场景 A: 低价值信号被预筛拦截 → silent，不调端到端 LLM", async () => {
  await withThreshold(5.0, async () => {
    const maker = makeTrackingMaker({ speak: true, message: "不应该出现", reason: "bug" });
    const cortex = new ProactionCortex();
    cortex.registerEndToEndMaker(maker);

    // low importance + mood_shift → value = 3*0.6 + 4*0.4 = 3.4
    // gap = 3.4 - disturb(1~3) = 0.4~2.4 < threshold(5.0) → 预筛拦截
    const signal = makeSignal({
      kind: "mood_shift",
      importance: "low",
      title: "检测到微弱情绪波动",
    });

    const decision = await cortex.decide(signal);

    assert.equal(decision.outcome, "silent", "低价值信号应被预筛拦截为 silent");
    assert.ok(
      decision.rationale.includes("prefilter:gap<"),
      `rationale 应包含 prefilter 标记，实际: ${decision.rationale}`,
    );
    assert.equal(maker.callCount, 0, "端到端 LLM 不应被调用");
  });
});

// ---- 场景 B: 高价值信号通过预筛，走端到端 LLM 产出 speak + 话术 ----------

test("场景 B: 高价值信号通过预筛 → 端到端 LLM 决策 speak + 话术", async () => {
  const maker = makeTrackingMaker({
    speak: true,
    message: "你的快递已签收，顺丰单号 12345",
    reason: "high_value_transaction",
  });
  const cortex = new ProactionCortex();
  cortex.registerEndToEndMaker(maker);

  // critical + transaction_completed → value = 9*0.6 + 7*0.4 = 8.2
  // gap = 8.2 - disturb(1~3) = 5.2~7.2 > threshold(2.0) → 通过预筛 → 调 e2e maker
  const signal = makeSignal({
    importance: "critical",
    title: "你的快递已签收",
    summary: "顺丰快递 12345 已由本人签收",
  });

  const decision = await cortex.decide(signal);

  assert.equal(decision.outcome, "speak", "高价值信号应通过端到端 LLM 决策为 speak");
  assert.equal(maker.callCount, 1, "端到端 LLM 应被调用一次");
  assert.equal(
    decision.message,
    "你的快递已签收，顺丰单号 12345",
    "话术应来自端到端 LLM 输出",
  );
  assert.ok(
    decision.rationale.includes("e2e:speak"),
    `rationale 应包含 e2e:speak 标记，实际: ${decision.rationale}`,
  );
});

// ---- 场景 C: policy 硬闸门阻断 → silent，不进端到端 LLM -------------------

test("场景 C: policy 硬闸门阻断 → silent，不调端到端 LLM", async () => {
  const maker = makeTrackingMaker({ speak: true, message: "不应该出现", reason: "bug" });
  const cortex = new ProactionCortex();
  cortex.registerEndToEndMaker(maker);

  // mock contact policy: 返回 allowed=false（cooldown 中）
  const blockedPolicy = {
    decide() {
      return { allowed: false, reason: "cooldown", channel: "ws" };
    },
  } as unknown as ProactiveContactPolicyService;
  cortex.registerContactPolicy(blockedPolicy);

  // 即使是 critical 高价值信号，policy 硬闸门优先于阈值粗筛
  const signal = makeSignal({
    importance: "critical",
    title: "你的快递已签收",
  });

  const decision = await cortex.decide(signal);

  assert.equal(decision.outcome, "silent", "policy 阻断应为 silent");
  assert.ok(
    decision.rationale.includes("policy_blocked:cooldown"),
    `rationale 应包含 policy_blocked:cooldown，实际: ${decision.rationale}`,
  );
  assert.equal(maker.callCount, 0, "policy 阻断后端到端 LLM 不应被调用");
});

// ---- 场景 D: 未注入 EndToEndMaker 时回退规则决策 ---------------------------

test("场景 D: 未注入 EndToEndMaker → 通过粗筛后回退规则决策 speak", async () => {
  const cortex = new ProactionCortex();
  // 不注册 endToEndMaker

  // critical + transaction_completed → value = 8.2，通过粗筛
  const signal = makeSignal({
    importance: "critical",
    title: "你的快递已签收",
  });

  const decision = await cortex.decide(signal);

  assert.equal(decision.outcome, "speak", "无 e2e maker 时应回退为 speak");
  assert.equal(decision.message, undefined, "回退模式 message 应为空（交由后续话术流程）");
  assert.ok(
    decision.rationale.includes("fallback:no_e2e_maker"),
    `rationale 应包含 fallback:no_e2e_maker，实际: ${decision.rationale}`,
  );
});

// ---- 场景 E: 重复抑制——同 kind 信号窗口期内已 speak → value 砍半 ---------

test("场景 E: 重复抑制——第二次同 kind 信号 value 砍半", async () => {
  const cortex = new ProactionCortex();
  // 不注册 maker → 通过粗筛即 speak，触发 recordSpokenKind
  const signal = makeSignal({
    importance: "critical",
    title: "你的快递已签收",
    actorId: "test-repeat-user",
  });

  // 第一次：正常 value = 8.2
  const d1 = await cortex.decide(signal);
  assert.equal(d1.outcome, "speak", "第一次应 speak");

  // 第二次：同 kind，窗口期内已 speak → value 砍半 = 4.1
  const d2 = await cortex.decide(signal);

  assert.ok(
    d2.rationale.includes("repeat_suppress"),
    `第二次 rationale 应包含 repeat_suppress，实际: ${d2.rationale}`,
  );
  assert.ok(
    d2.valueScore < d1.valueScore,
    `第二次 value(${d2.valueScore}) 应低于第一次(${d1.valueScore})`,
  );
  // value 砍半：8.2 → 4.1
  assert.ok(
    Math.abs(d2.valueScore - d1.valueScore / 2) < 0.1,
    `value 应精确砍半，实际 d1=${d1.valueScore}, d2=${d2.valueScore}`,
  );
});

// ---- 场景 F: cognize 被动认知——一次 LLM 产出 route+response ---------------

test("场景 F: cognize 端到端认知——一次 LLM 产出 route + response", async () => {
  const brain = new BrainCenter();

  const expectedRoute: SystemRouteDecision = {
    userMessage: "今天天气怎么样",
    system: "system2",
    mode: "complex",
    rationale: "需要调用天气工具",
    decidedAt: new Date().toISOString(),
  };

  const cognitiveEngine: CognitiveEngine = {
    async cognize(input, _context) {
      return {
        route: expectedRoute,
        response: "我查一下北京今天的天气",
        memoryWrites: [],
        needsToolLoop: true,
        rationale: "weather_query_needs_tool",
      };
    },
  };
  brain.registerCognitiveEngine(cognitiveEngine);

  const result = await brain.cognize({
    actorId: "user-f",
    text: "今天天气怎么样",
  });

  assert.equal(result.response, "我查一下北京今天的天气", "response 应来自端到端认知 LLM");
  assert.equal(result.route.mode, "complex", "route 应来自端到端认知 LLM");
  assert.equal(result.route.system, "system2", "应为 system2 慢思考");
  assert.equal(result.needsToolLoop, true, "需要工具循环");
  assert.equal(result.rationale, "weather_query_needs_tool", "rationale 应来自 LLM");
  assert.equal(result.actorId, "user-f", "actorId 应透传");
});

// ---- 场景 G: cognize 后置——engine 产出 memoryWrites 时触发 remember ------

test("场景 G: cognize 后置——memoryWrites 触发 remember", async () => {
  const brain = new BrainCenter();

  const rememberCalls: MemoryItem[] = [];
  const expectedMemory: MemoryItem = {
    actorId: "user-g",
    kind: "fact",
    content: "用户询问了今天的天气",
    importance: "low",
    source: "chat",
    timestamp: new Date().toISOString(),
  };

  // mock MemoryCortex（BrainCenter 内部 MemoryCortexLike 的结构兼容实现）
  const mockMemory = {
    remember: async (_actorId: string, item: MemoryItem) => {
      rememberCalls.push(item);
    },
    recall: async () => ({ items: [] }),
    recallCrossDomain: async () => ({ items: [] }),
    consolidate: async () => ({}),
  };
  brain.registerMemory(mockMemory as never);

  const cognitiveEngine: CognitiveEngine = {
    async cognize(_input, _context) {
      return {
        route: {
          userMessage: "今天天气",
          system: "system1" as const,
          mode: "fast" as const,
          rationale: "simple",
          decidedAt: new Date().toISOString(),
        },
        response: "北京今天晴",
        memoryWrites: [expectedMemory],
        needsToolLoop: false,
        rationale: "cognized",
      };
    },
  };
  brain.registerCognitiveEngine(cognitiveEngine);

  const result = await brain.cognize({
    actorId: "user-g",
    text: "今天天气",
  });

  assert.equal(rememberCalls.length, 1, "engine 产出 memoryWrites 应触发一次 remember");
  assert.equal(rememberCalls[0].content, "用户询问了今天的天气", "记忆内容应正确");
  assert.equal(result.memoryWrites.length, 1, "cognize 结果应回传 memoryWrites");
});

// ---- 场景 H: 未注入 CognitiveEngine 时 cognize 降级到 routeSystem ----------

test("场景 H: 未注入 CognitiveEngine → cognize 降级到 routeSystem", async () => {
  const brain = new BrainCenter();
  // 不注册 cognitiveEngine，也不注册 planner

  const result = await brain.cognize({
    actorId: "user-h",
    text: "你好",
  });

  assert.equal(result.response, "", "无认知引擎时 response 应为空");
  assert.equal(result.rationale, "no_cognitive_engine", "rationale 应标记降级原因");
  assert.equal(result.route.mode, "fast", "无 planner 时应降级为 fast");
  assert.equal(result.route.system, "system1", "应为 system1 快思考");
  assert.equal(result.needsToolLoop, false, "fast 不需要工具循环");
});
