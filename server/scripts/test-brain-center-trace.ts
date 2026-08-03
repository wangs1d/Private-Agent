/**
 * BrainCenter 集成测试：发送一段话，追踪各脑区模块的调用轨迹。
 *
 * 目标：验证 BrainCenter.cognize() 处理一条用户消息时，是否真的经过：
 *   阶段 1：SensoryCortex.listen/look + MemoryCortex.recall + LimbicCortex.inferEmotion
 *           + AwarenessCortex.observe + CapabilityCortex.introspect + ProactionCortex.recentDecisions
 *   阶段 2：DecisionHub.decidePassive → RuleRouter.route（替代 LLM 路由）
 *   阶段 3：LimbicCortex.checkSafety + MemoryCortex.remember + LimbicCortex.checkOutputSafety
 *
 * 用法：
 *   cd server && npx tsx scripts/test-brain-center-trace.ts
 */
import { BrainCenter } from "../src/brain/brain-center.js";
import { RuleRouter } from "../src/brain/rule-router.js";
import { ActionExecutor } from "../src/brain/action-executor.js";
import { DecisionHub } from "../src/brain/decision-hub.js";
import { WorkingMemoryCortex } from "../src/brain/working-memory-cortex.js";
import { TaskSwitchingCortex } from "../src/brain/task-switching-cortex.js";
import { MetaCognitionCortex } from "../src/brain/meta-cognition-cortex.js";
import { ContextCortex } from "../src/brain/context-cortex.js";
import { ToolPlanningCortex } from "../src/brain/tool-planning-cortex.js";
import { CollaborationCortex } from "../src/brain/collaboration-cortex.js";
import { OnlineLearningCortex } from "../src/brain/online-learning-cortex.js";
import type {
  BrainDecision,
  CapabilityDescriptor,
  EmotionVector,
  MemoryItem,
  MemoryRecallResult,
  SafetyCheckResult,
  SensoryFrame,
  SensoryListenResult,
  SensoryLookResult,
  SensorySpeakResult,
  UserActivityState,
  VisualInput,
} from "../src/brain/types.js";

// ============================================================
// 调用计数器：记录每个脑区被调用的次数和最近一次入参
// ============================================================

interface CallTrace {
  count: number;
  lastArgs: string;
}

const traces = new Map<string, CallTrace>();

function recordCall(name: string, argsSummary: string): void {
  const cur = traces.get(name) ?? { count: 0, lastArgs: "" };
  cur.count++;
  cur.lastArgs = argsSummary;
  traces.set(name, cur);
  console.log(`  → [${name}] #${cur.count}  ${argsSummary}`);
}

function resetTraces(): void {
  traces.clear();
}

// ============================================================
// Mock 各脑区（带调用追踪）
// ============================================================

class MockSensoryCortex {
  async listen(): Promise<SensoryListenResult> {
    recordCall("SensoryCortex.listen", "audio input");
    return { text: "", confidence: 0.9 };
  }
  async look(): Promise<SensoryLookResult> {
    recordCall("SensoryCortex.look", "visual input");
    return { description: "mock screen", confidence: 0.9 };
  }
  async speak(): Promise<SensorySpeakResult> {
    recordCall("SensoryCortex.speak", "text output");
    return { played: true };
  }
  buildSensoryFrame(): SensoryFrame {
    recordCall("SensoryCortex.buildSensoryFrame", "assemble frame");
    return {
      actorId: "trace-user",
      capturedAt: new Date().toISOString(),
      modalities: ["text"],
    } as SensoryFrame;
  }
  getStats() {
    return { totalListen: 0, totalLook: 0, totalSpeak: 0 };
  }
}

class MockMemoryCortex {
  private store: MemoryItem[] = [];

  async remember(actorId: string, item: MemoryItem): Promise<void> {
    recordCall("MemoryCortex.remember", `kind=${item.kind} content="${item.content.slice(0, 40)}..."`);
    this.store.push(item);
  }

  /** 性能优化方案 D：批量写入（trace 内一次记录，模拟单次 IO） */
  async rememberBatch(actorId: string, items: MemoryItem[]): Promise<void> {
    recordCall("MemoryCortex.rememberBatch", `count=${items.length} kinds=[${items.map((i) => i.kind).join(",")}]`);
    for (const item of items) this.store.push(item);
  }

  async recall(actorId: string, query: string): Promise<MemoryRecallResult> {
    recordCall("MemoryCortex.recall", `query="${query.slice(0, 30)}" items=${this.store.length}`);
    return {
      actorId,
      query,
      items: this.store.slice(0, 5).map((item) => ({
        content: item.content,
        domain: item.domain ?? "episodic",
        source: item.source,
        importance: item.importance,
        score: 0.85,
        timestamp: item.timestamp,
      })),
      domain: "episodic",
      mode: "single_domain",
      recalledAt: new Date().toISOString(),
    };
  }
}

class MockLimbicCortex {
  async inferEmotion(actorId: string): Promise<EmotionVector> {
    recordCall("LimbicCortex.inferEmotion", `actorId=${actorId}`);
    return { valence: 0.5, arousal: 0.3, dominance: 0.5 };
  }

  checkSafety(action: { tool: string; args: Record<string, unknown> }): SafetyCheckResult {
    recordCall("LimbicCortex.checkSafety", `tool=${action.tool}`);
    return {
      allowed: true,
      severity: "allowed",
      reason: "mock_allow",
      tool: action.tool,
      args: action.args,
      checkedAt: new Date().toISOString(),
    };
  }

  checkOutputSafety(text: string): { safe: boolean; sanitized: string; reason?: string } {
    recordCall("LimbicCortex.checkOutputSafety", `text="${text.slice(0, 30)}"`);
    return { safe: true, sanitized: text };
  }

  getLastEmotion(): EmotionVector | null {
    return null;
  }
  getLastSafetyCheck(): SafetyCheckResult | null {
    return null;
  }
  applyTonePolicy(text: string): { text: string } {
    return { text };
  }
}

class MockAwarenessCortex {
  observe(actorId: string): UserActivityState | null {
    recordCall("AwarenessCortex.observe", `actorId=${actorId}`);
    return {
      actorId,
      activity: "idle",
      kind: "desktop",
      occurredAt: new Date().toISOString(),
    };
  }
}

class MockCapabilityCortex {
  introspect(actorId: string): CapabilityDescriptor[] {
    recordCall("CapabilityCortex.introspect", `actorId=${actorId}`);
    return [
      {
        domain: "weather",
        label: "天气",
        description: "查询天气",
        tools: ["weather_query", "search_web"],
        status: "active",
        source: "builtin",
        registeredAt: new Date().toISOString(),
      },
    ] as CapabilityDescriptor[];
  }
  snapshot(): CapabilityDescriptor[] {
    recordCall("CapabilityCortex.snapshot", "list");
    return [
      {
        domain: "weather",
        label: "天气",
        description: "查询天气",
        tools: ["weather_query", "search_web"],
        status: "active",
        source: "builtin",
        registeredAt: new Date().toISOString(),
      },
    ];
  }
}

class MockProactionCortex {
  recentDecisions(actorId: string): BrainDecision[] {
    recordCall("ProactionCortex.recentDecisions", `actorId=${actorId}`);
    return [];
  }
}

class MockSynapseBus {
  getRecentMessages() {
    return [];
  }
  getSubscriberCount() {
    return 0;
  }
}

// ============================================================
// 装配 BrainCenter
// ============================================================

function buildBrainCenter(): BrainCenter {
  const brainCenter = new BrainCenter();

  const sensory = new MockSensoryCortex();
  const memory = new MockMemoryCortex();
  const limbic = new MockLimbicCortex();
  const awareness = new MockAwarenessCortex();
  const capability = new MockCapabilityCortex();
  const proaction = new MockProactionCortex();

  brainCenter.registerSensory(sensory as any);
  brainCenter.registerMemory(memory as any);
  brainCenter.registerLimbic(limbic as any);
  brainCenter.registerAwareness(awareness as any);
  brainCenter.registerCapability(capability as any);
  brainCenter.registerProaction(proaction as any);
  brainCenter.registerSynapse(new MockSynapseBus() as any);

  // Step 6 扩展：装配 DecisionHub（规则驱动端到端认知）
  const ruleRouter = new RuleRouter();
  const actionExecutor = new ActionExecutor({
    execute: async (name, args) => {
      recordCall("ActionExecutor.execute", `tool=${name}`);
      return { ok: true, result: { mocked: true, args } };
    },
  });
  actionExecutor.registerLimbic(limbic as any);
  const decisionHub = new DecisionHub(ruleRouter, actionExecutor);
  decisionHub.registerMemory(memory as any);
  decisionHub.registerAwareness(awareness as any);
  decisionHub.registerCapability(capability as any);
  brainCenter.setDecisionHub(decisionHub);

  // Step 7 扩展：装配 7 个新皮层模块（包上 trace 计数器）
  const workingMemoryCortex = new WorkingMemoryCortex();
  const origWMLoad = workingMemoryCortex.load.bind(workingMemoryCortex);
  workingMemoryCortex.load = (actorId: string) => {
    const r = origWMLoad(actorId);
    recordCall("WorkingMemoryCortex.load", `actorId=${actorId} slots=${r.slots.length} goals=${r.goals.length}`);
    return r;
  };
  const origWMPushGoal = workingMemoryCortex.pushGoal.bind(workingMemoryCortex);
  workingMemoryCortex.pushGoal = (actorId: string, desc: string, pri: any, existingWm?: any) => {
    const r = origWMPushGoal(actorId, desc, pri, existingWm);
    recordCall("WorkingMemoryCortex.pushGoal", `actorId=${actorId} desc="${desc.slice(0, 30)}" pri=${pri} reusedWm=${existingWm ? "yes" : "no"}`);
    return r;
  };

  const taskSwitchingCortex = new TaskSwitchingCortex();
  taskSwitchingCortex.registerWorkingMemory(workingMemoryCortex);
  const origTSRecognize = taskSwitchingCortex.recognizeIntent.bind(taskSwitchingCortex);
  taskSwitchingCortex.recognizeIntent = (text: string) => {
    const r = origTSRecognize(text);
    recordCall("TaskSwitchingCortex.recognizeIntent", `text="${text.slice(0, 30)}" → type=${r.type} conf=${r.confidence.toFixed(2)}`);
    return r;
  };

  const metaCognitionCortex = new MetaCognitionCortex();
  const origMAssess = metaCognitionCortex.assess.bind(metaCognitionCortex);
  metaCognitionCortex.assess = (actorId: string, input: any) => {
    const r = origMAssess(actorId, input);
    recordCall("MetaCognitionCortex.assess", `actorId=${actorId} conf=${r.confidence.toFixed(2)} shouldReflect=${r.shouldReflect}`);
    return r;
  };

  const contextCortexLocal = new ContextCortex();
  contextCortexLocal.registerAwareness(awareness as any);
  const origCGather = contextCortexLocal.gatherContext.bind(contextCortexLocal);
  contextCortexLocal.gatherContext = async (actorId: string) => {
    const r = await origCGather(actorId);
    recordCall("ContextCortex.gatherContext", `actorId=${actorId} hour=${r.hour} tags=[${r.tags.join(",")}] interruptible=${r.interruptible}`);
    return r;
  };

  const toolPlanningCortex = new ToolPlanningCortex();
  const origTPPlan = toolPlanningCortex.planTools.bind(toolPlanningCortex);
  toolPlanningCortex.planTools = (actorId: string, task: string, caps: any, route: any) => {
    const r = origTPPlan(actorId, task, caps, route);
    recordCall("ToolPlanningCortex.planTools", `actorId=${actorId} tools=[${r.toolChain.map((t) => t.name).join(",")}] gaps=[${r.capabilityGaps.join(",")}]`);
    return r;
  };

  const collaborationCortex = new CollaborationCortex();
  const origCBInit = collaborationCortex.initiate.bind(collaborationCortex);
  collaborationCortex.initiate = (initiator: string, peer: string, task: string) => {
    const r = origCBInit(initiator, peer, task);
    recordCall("CollaborationCortex.initiate", `initiator=${initiator} peer=${peer} task="${task.slice(0, 30)}"`);
    return r;
  };

  const onlineLearningCortex = new OnlineLearningCortex();
  const origOLObserve = onlineLearningCortex.observe.bind(onlineLearningCortex);
  onlineLearningCortex.observe = (actorId: string, input: any, route: any) => {
    const r = origOLObserve(actorId, input, route);
    recordCall("OnlineLearningCortex.observe", `actorId=${actorId} prefs=${r.preferences.length} taboos=${r.taboos.length} totalObs=${r.totalObservations}`);
    return r;
  };

  // 注册到 BrainCenter
  brainCenter.registerWorkingMemoryCortex(workingMemoryCortex);
  brainCenter.registerTaskSwitchingCortex(taskSwitchingCortex);
  brainCenter.registerMetaCognitionCortex(metaCognitionCortex);
  brainCenter.registerContextCortex(contextCortexLocal);
  brainCenter.registerToolPlanningCortex(toolPlanningCortex);
  brainCenter.registerCollaborationCortex(collaborationCortex);
  brainCenter.registerOnlineLearningCortex(onlineLearningCortex);

  // 注入到 DecisionHub（让 decidePassive 调用新模块）
  decisionHub.registerWorkingMemory(workingMemoryCortex);
  decisionHub.registerTaskSwitching(taskSwitchingCortex);
  decisionHub.registerMetaCognition(metaCognitionCortex);
  decisionHub.registerContextCortex(contextCortexLocal);
  decisionHub.registerToolPlanning(toolPlanningCortex);
  decisionHub.registerCollaboration(collaborationCortex);
  decisionHub.registerOnlineLearning(onlineLearningCortex);

  // AnticipationEngine（mock：返回固定预测）
  decisionHub.registerAnticipationEngine({
    predictNextIntent: async (actorId, input) => {
      recordCall("AnticipationEngine.predictNextIntent", `actorId=${actorId} text="${input.text?.slice(0, 30) ?? ""}"`);
      return { intent: "可能查询天气", confidence: 0.6, preparationHints: ["weather_query"] };
    },
  });

  return brainCenter;
}

// ============================================================
// 测试主函数：发送一段话，追踪各模块调用
// ============================================================

async function main(): Promise<void> {
  console.log("=== BrainCenter 模块调用追踪测试 ===");
  console.log(`时间: ${new Date().toISOString()}`);
  console.log("");

  const testCases = [
    { label: "闲聊", text: "你好啊，今天怎么样" },
    { label: "简单工具", text: "今天天气怎么样" },
    { label: "紧急事务", text: "转账500给张三" },
    { label: "复杂任务", text: "打开浏览器登录系统然后导出数据再分析最后生成报告" },
  ];

  const perfRows: Array<{
    label: string;
    totalMs: number;
    totalCalls: number;
    uniqueModules: number;
    repeatCalls: number;
  }> = [];

  for (const c of testCases) {
    console.log("\n" + "=".repeat(70));
    console.log(`发送消息 [${c.label}]: "${c.text}"`);
    console.log("=".repeat(70));

    const brainCenter = buildBrainCenter();
    resetTraces();

    console.log("\n📦 阶段 1：感知收集（并行调用各脑区）");
    const tStart = performance.now();
    const result = await brainCenter.cognize({
      actorId: "trace-user",
      text: c.text,
      sessionId: "trace-session",
    });
    const tEnd = performance.now();

    console.log("\n📦 cognize 返回结果：");
    console.log({
      route: `${result.route.mode} (system=${result.route.system})`,
      rationale: result.rationale.slice(0, 80),
      response: result.response ? `"${result.response.slice(0, 40)}..."` : "(empty)",
      memoryWrites: result.memoryWrites.length,
      action: result.action?.tool ?? "(none)",
      safety: `${result.safety.allowed ? "allowed" : "blocked"} (${result.safety.reason})`,
      needsToolLoop: result.needsToolLoop,
      emotion: result.emotion
        ? `v=${(result.emotion as EmotionVector).valence} a=${(result.emotion as EmotionVector).arousal}`
        : "null",
      recallItems: result.recallItems?.length ?? 0,
    });

    console.log("\n📊 模块调用统计：");
    const orderedKeys = [
      // 原始 11 分区
      "SensoryCortex.listen",
      "SensoryCortex.look",
      "SensoryCortex.buildSensoryFrame",
      "MemoryCortex.recall",
      "LimbicCortex.inferEmotion",
      "AwarenessCortex.observe",
      "CapabilityCortex.introspect",
      "ProactionCortex.recentDecisions",
      "LimbicCortex.checkSafety",
      "LimbicCortex.checkOutputSafety",
      "MemoryCortex.remember",
      "MemoryCortex.rememberBatch",
      "ActionExecutor.execute",
      // Step 7 扩展：7 个新皮层模块
      "WorkingMemoryCortex.load",
      "WorkingMemoryCortex.pushGoal",
      "TaskSwitchingCortex.recognizeIntent",
      "MetaCognitionCortex.assess",
      "ContextCortex.gatherContext",
      "ToolPlanningCortex.planTools",
      "CollaborationCortex.initiate",
      "OnlineLearningCortex.observe",
      "AnticipationEngine.predictNextIntent",
    ];
    const called = new Set<string>();
    for (const k of orderedKeys) {
      const t = traces.get(k);
      if (t) {
        console.log(`  ✓ ${k.padEnd(40)} ${t.count} 次`);
        called.add(k);
      } else {
        console.log(`  ✗ ${k.padEnd(40)} 0 次`);
      }
    }
    // 额外打印不在 orderedKeys 中的调用
    for (const [k, t] of traces) {
      if (!called.has(k)) {
        console.log(`  + ${k.padEnd(40)} ${t.count} 次`);
      }
    }

    // 各阶段汇总
    console.log("\n🎯 阶段覆盖汇总：");
    const stage1Modules = ["SensoryCortex.buildSensoryFrame", "MemoryCortex.recall", "LimbicCortex.inferEmotion", "AwarenessCortex.observe", "CapabilityCortex.introspect", "ProactionCortex.recentDecisions"];
    const stage2Modules = ["LimbicCortex.checkSafety", "WorkingMemoryCortex.load", "TaskSwitchingCortex.recognizeIntent", "MetaCognitionCortex.assess", "ContextCortex.gatherContext", "ToolPlanningCortex.planTools", "OnlineLearningCortex.observe", "AnticipationEngine.predictNextIntent", "WorkingMemoryCortex.pushGoal"];
    const stage3Modules = ["LimbicCortex.checkOutputSafety", "MemoryCortex.remember", "MemoryCortex.rememberBatch"];
    const stage1Hits = stage1Modules.filter((k) => (traces.get(k)?.count ?? 0) > 0).length;
    const stage2Hits = stage2Modules.filter((k) => (traces.get(k)?.count ?? 0) > 0).length;
    const stage3Hits = stage3Modules.filter((k) => (traces.get(k)?.count ?? 0) > 0).length;
    console.log(`  阶段 1 感知收集: ${stage1Hits}/${stage1Modules.length} 模块被调用（原 6 分区）`);
    console.log(`  阶段 2 决策（DecisionHub + 7 新模块 + Anticipation）: ${stage2Hits}/${stage2Modules.length} 模块被调用`);
    console.log(`  阶段 3 后置执行（含元认知反思）: ${stage3Hits}/${stage3Modules.length} 模块被调用`);
    const totalCalls = Array.from(traces.values()).reduce((s, t) => s + t.count, 0);
    console.log(`  总调用次数: ${totalCalls}`);
    const totalMs = tEnd - tStart;
    const uniqueModules = traces.size;
    const repeatCalls = totalCalls - uniqueModules;
    console.log(`  ⏱ cognize 耗时: ${totalMs.toFixed(2)} ms`);
    console.log(`  🔁 重复调用: ${repeatCalls} 次（${uniqueModules} 个唯一模块 × ${totalCalls} 总调用）`);

    perfRows.push({ label: c.label, totalMs, totalCalls, uniqueModules, repeatCalls });
  }

  console.log("\n" + "=".repeat(70));
  console.log("📊 性能汇总（按场景）");
  console.log("=".repeat(70));
  console.log("场景".padEnd(10) + "耗时(ms)".padStart(12) + "总调用".padStart(10) + "唯一".padStart(8) + "重复".padStart(8));
  for (const r of perfRows) {
    console.log(
      r.label.padEnd(10) +
        r.totalMs.toFixed(2).padStart(12) +
        String(r.totalCalls).padStart(10) +
        String(r.uniqueModules).padStart(8) +
        String(r.repeatCalls).padStart(8),
    );
  }
  const avgMs = perfRows.reduce((s, r) => s + r.totalMs, 0) / perfRows.length;
  const avgCalls = perfRows.reduce((s, r) => s + r.totalCalls, 0) / perfRows.length;
  const avgRepeats = perfRows.reduce((s, r) => s + r.repeatCalls, 0) / perfRows.length;
  console.log(
    "平均".padEnd(10) +
      avgMs.toFixed(2).padStart(12) +
      avgCalls.toFixed(1).padStart(10) +
      "".padStart(8) +
      avgRepeats.toFixed(1).padStart(8),
  );
}

main().catch((err) => {
  console.error("测试脚本异常:", err);
  process.exit(1);
});
