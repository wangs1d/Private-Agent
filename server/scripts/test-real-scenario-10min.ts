// 真实场景 10 分钟观察脚本：验证 DMN/decay/cognize 长时联动
//
// 加速参数（通过环境变量）：
//   BRAIN_STEM_SWEEP_INTERVAL_MS=2000  sweep 间隔 2s（原 45s）
//   DMN_IDLE_THRESHOLD_MS=5000         空闲阈值 5s（原 5min）
//   DMN_MIN_INTERVAL_MS=8000           最小 DMN 间隔 8s（原 10min）
//   BrainStem.DECAY_EVERY_N_SWEEPS=5  → 5×2s=10s 触发一次 decay
//   BrainStem.DMN_CHECK_EVERY_N_SWEEPS=7 → 7×2s=14s 检查一次 DMN 空闲
//
// 模拟流程：
//   阶段 A（0-40s）：每 4s 一句对话（共 10 轮）→ 用户活跃，不空闲
//   阶段 B（40-90s）：50s 沉默 → DMN 应在 45s 后触发空闲整合
//   阶段 C（90-120s）：恢复对话 → DMN 停止，新一轮 cognize
//
// 运行：npx tsx scripts/test-real-scenario-10min.ts

import {
  BrainCenter,
  RuleRouter,
  ActionExecutor,
  DecisionHub,
  WorkingMemoryCortex,
  TaskSwitchingCortex,
  MetaCognitionCortex,
  ContextCortex,
  ToolPlanningCortex,
  CollaborationCortex,
  OnlineLearningCortex,
  PredictiveCodingCortex,
  EmotionModulator,
  DefaultModeNetwork,
  GlobalWorkspaceBroadcast,
  BrainStem,
  Cerebellum,
  MemoryCortex,
  LimbicCortex,
  AwarenessCortex,
  CapabilityCortex,
  ProactionCortex,
  EvolutionCortex,
  SensoryCortex,
  SynapseBus,
  type CognitiveInput,
  type MemoryItem,
} from "../src/brain/index.js";

// ===== Mock 工具 =====

class MockMemoryCortex {
  public remembered: MemoryItem[] = [];
  public consolidateCalls = 0;
  async remember(actorId: string, item: MemoryItem): Promise<void> {
    this.remembered.push(item);
  }
  async rememberBatch(actorId: string, items: MemoryItem[]): Promise<void> {
    this.remembered.push(...items);
  }
  async recall() {
    return { items: [], domains: {} };
  }
  async recallCrossDomain() {
    return { items: [], domains: {} };
  }
  async consolidate(actorIds: string[]) {
    this.consolidateCalls++;
    console.log(`[MockMemory] consolidate 调用 #${this.consolidateCalls} actors=${actorIds.join(",")}`);
    return {
      actorIds,
      weeklyMergedCount: this.consolidateCalls * 2,
      knowledgePromotedCount: this.consolidateCalls,
    };
  }
  async start() {}
  async stop() {}
}

function makeCognitiveInput(actorId: string, text: string): CognitiveInput {
  return {
    actorId,
    text,
    sessionId: `real-${actorId}`,
    timestamp: new Date().toISOString(),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ===== 主测试 =====

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 真实场景 10 分钟观察：DMN + decay + cognize 长时联动");
  console.log("=".repeat(70));
  console.log(`配置：sweep=${process.env.BRAIN_STEM_SWEEP_INTERVAL_MS ?? "45000"}ms ` +
    `DMN_IDLE=${process.env.DMN_IDLE_THRESHOLD_MS ?? "300000"}ms ` +
    `DMN_MIN=${process.env.DMN_MIN_INTERVAL_MS ?? "600000"}ms`);
  console.log();

  // === 装配 BrainCenter（与生产装配一致）===
  const brainCenter = new BrainCenter();

  const memoryCortex = new MockMemoryCortex() as unknown as MemoryCortex;
  const limbicCortex = new LimbicCortex();
  const awarenessCortex = new AwarenessCortex();
  const capabilityCortex = new CapabilityCortex();
  const proactionCortex = new ProactionCortex();
  const evolutionCortex = new EvolutionCortex();
  const sensoryCortex = new SensoryCortex();
  const synapseBus = new SynapseBus();

  brainCenter.registerMemory(memoryCortex);
  brainCenter.registerLimbic(limbicCortex);
  brainCenter.registerAwareness(awarenessCortex);
  brainCenter.registerCapability(capabilityCortex);
  brainCenter.registerProaction(proactionCortex);
  brainCenter.registerEvolution(evolutionCortex);
  brainCenter.registerSensory(sensoryCortex);
  brainCenter.registerSynapse(synapseBus);

  const brainStem = new BrainStem();
  brainCenter.registerBrainStem(brainStem);
  const cerebellum = new Cerebellum();
  brainCenter.registerCerebellum(cerebellum);

  const ruleRouter = new RuleRouter();
  const actionExecutor = new ActionExecutor();
  const decisionHub = new DecisionHub(ruleRouter, actionExecutor);
  brainCenter.setDecisionHub(decisionHub);

  const workingMemory = new WorkingMemoryCortex();
  const taskSwitching = new TaskSwitchingCortex();
  const metaCognition = new MetaCognitionCortex();
  const contextCortex = new ContextCortex();
  const toolPlanning = new ToolPlanningCortex();
  const collaboration = new CollaborationCortex();
  const onlineLearning = new OnlineLearningCortex();

  brainCenter.registerWorkingMemoryCortex(workingMemory);
  brainCenter.registerTaskSwitchingCortex(taskSwitching);
  brainCenter.registerMetaCognitionCortex(metaCognition);
  brainCenter.registerContextCortex(contextCortex);
  brainCenter.registerToolPlanningCortex(toolPlanning);
  brainCenter.registerCollaborationCortex(collaboration);
  brainCenter.registerOnlineLearningCortex(onlineLearning);

  // 4 个新增强模块
  const predictiveCoding = new PredictiveCodingCortex();
  predictiveCoding.registerWorkingMemory(workingMemory);
  brainCenter.registerPredictiveCodingCortex(predictiveCoding);

  const emotionModulator = new EmotionModulator();
  brainCenter.registerEmotionModulator(emotionModulator);
  decisionHub.registerEmotionModulator(emotionModulator);

  const dmn = new DefaultModeNetwork();
  dmn.registerMemoryCortex(memoryCortex as unknown as {
    consolidate: (ids: string[]) => Promise<unknown>;
  });
  dmn.registerMetaCognition(metaCognition);
  dmn.registerEvolutionCortex(evolutionCortex); // EvolutionCortex 已有 proposeEvolution
  brainCenter.registerDefaultModeNetwork(dmn);

  const globalWorkspace = new GlobalWorkspaceBroadcast();
  brainCenter.registerGlobalWorkspace(globalWorkspace);

  // 订阅 GlobalWorkspace（与生产装配一致 + 加通配订阅用于观察）
  globalWorkspace.subscribe("urgent_task", async (signal) => {
    console.log(`  📡 [GW订阅] urgent_task 收到: ${(signal.payload as { userText?: string }).userText?.slice(0, 40)}`);
  });
  globalWorkspace.subscribe("emotional_shift", async (signal) => {
    console.log(`  📡 [GW订阅] emotional_shift 收到: valence=${(signal.payload as { valence?: number }).valence?.toFixed(2)}`);
  });
  globalWorkspace.subscribe("task_delegation", async (signal) => {
    console.log(`  📡 [GW订阅] task_delegation 收到: ${(signal.payload as { userText?: string }).userText?.slice(0, 40)}`);
  });
  globalWorkspace.subscribe("low_confidence", async (signal) => {
    console.log(`  📡 [GW订阅] low_confidence 收到: score=${(signal.payload as { score?: number }).score?.toFixed(2)}`);
  });

  // BrainStem 接管 decay + DMN 调度
  (brainStem as unknown as { registerWorkingMemory: (wm: { decay: (a: string) => unknown }) => void })
    .registerWorkingMemory(workingMemory);
  (brainStem as unknown as { registerDefaultModeNetwork: (d: typeof dmn) => void })
    .registerDefaultModeNetwork(dmn);

  // DecisionHub 依赖
  decisionHub.registerWorkingMemory(workingMemory);
  decisionHub.registerTaskSwitching(taskSwitching);
  decisionHub.registerMetaCognition(metaCognition);
  decisionHub.registerContextCortex(contextCortex);
  decisionHub.registerToolPlanning(toolPlanning);
  decisionHub.registerCollaboration(collaboration);
  decisionHub.registerOnlineLearning(onlineLearning);

  // 启动 BrainStem 心跳（真实 setInterval）
  console.log("🚀 启动 BrainStem 心跳扫描...");
  await brainStem.start();
  console.log(`✓ BrainStem 已启动（sweep 间隔 ${process.env.BRAIN_STEM_SWEEP_INTERVAL_MS ?? "45000"}ms）`);
  console.log();

  const ACTOR = "real-user";

  // 让 BrainStem 知道这个 actor（通过 hub subscribe 累积）
  // 这里直接 hack knownActors（仅供测试）
  (brainStem as unknown as { knownActors: Set<string> }).knownActors.add(ACTOR);

  // ===== 阶段 A：活跃对话 40s（每 4s 一句，11 轮，含 1 次紧急事务）=====
  console.log("━━━ 阶段 A：活跃对话（0-44s）━━━");
  const stageA = [
    "你好",
    "嗨",
    "今天天气怎么样",
    "帮我查一下天气",
    "明天呢",
    "换个话题",
    "最近有点累",
    "是啊，工作压力大",
    "帮我紧急转账 10000 元到张三账户", // 紧急事务：应触发 GlobalWorkspace broadcast
    "拜拜",
    "再见",
  ];

  const stageAStart = Date.now();
  for (let i = 0; i < stageA.length; i++) {
    const t0 = Date.now();
    const r = await brainCenter.cognize(makeCognitiveInput(ACTOR, stageA[i]));
    const dur = Date.now() - t0;
    console.log(`[+${((Date.now() - stageAStart) / 1000).toFixed(1)}s] cognize #${i + 1}「${stageA[i]}」` +
      ` route=${r.route.mode} wmSummary="${r.workingMemorySummary?.slice(0, 60) ?? ""}" (${dur}ms)`);
    if (i < stageA.length - 1) await sleep(4000);
  }

  console.log();
  console.log("📊 阶段 A 统计：");
  console.log(`  MemoryCortex.remember 写入条目数: ${memoryCortex.remembered.length}`);
  console.log(`  MemoryCortex.consolidate 调用数: ${memoryCortex.consolidateCalls}`);
  console.log(`  PredictiveCoding: ${JSON.stringify(predictiveCoding.getStats())}`);
  console.log();

  // ===== 阶段 B：50s 沉默，应触发 DMN =====
  console.log("━━━ 阶段 B：50s 沉默（40-90s）━━━");
  console.log("(等待 BrainStem 心跳触发 DMN onIdle...)");

  const stageBStart = Date.now();
  let lastDecayStats = (brainStem as unknown as { getDecayStats: () => { triggered: number; totalDecayed: number } }).getDecayStats();
  let lastDmnStats = (brainStem as unknown as { getDmnStats: () => { triggered: number; idleActors: number } }).getDmnStats();

  // 每 5s 报告一次状态
  for (let i = 0; i < 10; i++) {
    await sleep(5000);
    const elapsed = (Date.now() - stageBStart) / 1000;
    const decayStats = (brainStem as unknown as { getDecayStats: () => { triggered: number; totalDecayed: number } }).getDecayStats();
    const dmnStats = (brainStem as unknown as { getDmnStats: () => { triggered: number; idleActors: number } }).getDmnStats();
    const dmnInternalStats = dmn.getStats();
    console.log(
      `[+${elapsed.toFixed(0)}s] decay: triggered=${decayStats.triggered} decayed=${decayStats.totalDecayed} | ` +
      `DMN: triggered=${dmnStats.triggered} idleActors=${dmnStats.idleActors} | ` +
      `DMN内部: triggered=${dmnInternalStats.triggered} consolidations=${dmnInternalStats.consolidations} reflections=${dmnInternalStats.reflections}`,
    );

    if (dmnInternalStats.triggered > 0 && lastDmnStats.triggered === 0) {
      console.log(`  ⚡ DMN 首次触发！记忆固化 consolidate=${memoryCortex.consolidateCalls}`);
    }
    lastDecayStats = decayStats;
    lastDmnStats = dmnStats;
  }

  console.log();
  console.log("📊 阶段 B 统计：");
  console.log(`  MemoryCortex.consolidate 调用数: ${memoryCortex.consolidateCalls}`);
  console.log();

  // ===== 阶段 C：恢复对话 30s =====
  console.log("━━━ 阶段 C：恢复对话（90-120s）━━━");
  const stageCStart = Date.now();
  const stageC = ["我又回来了", "刚才聊到哪了？", "继续"];
  for (let i = 0; i < stageC.length; i++) {
    const t0 = Date.now();
    const r = await brainCenter.cognize(makeCognitiveInput(ACTOR, stageC[i]));
    const dur = Date.now() - t0;
    console.log(`[+${((Date.now() - stageCStart) / 1000).toFixed(1)}s] cognize「${stageC[i]}」` +
      ` route=${r.route.mode} wmSummary="${r.workingMemorySummary?.slice(0, 60) ?? ""}" (${dur}ms)`);
    await sleep(8000);
  }

  console.log();

  // ===== 最终汇总 =====
  await sleep(2000);
  console.log("=".repeat(70));
  console.log("📊 10 分钟观察最终统计");
  console.log("=".repeat(70));

  const finalDecay = (brainStem as unknown as { getDecayStats: () => { triggered: number; totalDecayed: number; totalForgotten: number } }).getDecayStats();
  const finalDmn = (brainStem as unknown as { getDmnStats: () => { triggered: number; idleActors: number; failed: number } }).getDmnStats();
  const finalDmnInternal = dmn.getStats();
  const finalPc = predictiveCoding.getStats();
  const finalGw = globalWorkspace.getStats();

  console.log(`MemoryCortex:`);
  console.log(`  remember 写入条目数: ${memoryCortex.remembered.length}`);
  console.log(`  consolidate 调用数: ${memoryCortex.consolidateCalls}`);
  console.log();
  console.log(`BrainStem decay 调度:`);
  console.log(`  triggered=${finalDecay.triggered} totalDecayed=${finalDecay.totalDecayed} totalForgotten=${finalDecay.totalForgotten}`);
  console.log();
  console.log(`BrainStem DMN 调度:`);
  console.log(`  triggered=${finalDmn.triggered} idleActors=${finalDmn.idleActors} failed=${finalDmn.failed}`);
  console.log();
  console.log(`DMN 内部统计:`);
  console.log(`  triggered=${finalDmnInternal.triggered} consolidations=${finalDmnInternal.consolidations} reflections=${finalDmnInternal.reflections} evolutionProposals=${finalDmnInternal.evolutionProposals}`);
  console.log();
  console.log(`PredictiveCoding:`);
  console.log(`  predictions=${finalPc.predictions} bypass=${finalPc.bypassCount} accurate=${finalPc.accurateCount} bypassRate=${(finalPc.bypassRate * 100).toFixed(0)}%`);
  console.log();
  console.log(`GlobalWorkspace:`);
  console.log(`  broadcasts=${finalGw.broadcasts} delivered=${finalGw.delivered} deduplicated=${finalGw.deduplicated} subscribers=${finalGw.subscribers}`);
  console.log();

  // 验证关键指标
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    {
      name: "DMN 在沉默期间触发至少 1 次",
      pass: finalDmnInternal.triggered >= 1,
      detail: `triggered=${finalDmnInternal.triggered}`,
    },
    {
      name: "DMN 触发后 MemoryCortex.consolidate 被调用",
      pass: memoryCortex.consolidateCalls >= 1,
      detail: `consolidateCalls=${memoryCortex.consolidateCalls}`,
    },
    {
      name: "BrainStem decay 在沉默期间触发至少 1 次",
      pass: finalDecay.triggered >= 1,
      detail: `triggered=${finalDecay.triggered}`,
    },
    {
      name: "PredictiveCoding 在活跃对话期至少 bypass 1 次",
      pass: finalPc.bypassCount >= 1,
      detail: `bypassCount=${finalPc.bypassCount}`,
    },
    {
      name: "GlobalWorkspace 在对话期至少广播 1 次",
      pass: finalGw.broadcasts >= 1,
      detail: `broadcasts=${finalGw.broadcasts}`,
    },
    {
      name: "MemoryCortex 在对话期至少写入 5 条记忆",
      pass: memoryCortex.remembered.length >= 5,
      detail: `remembered=${memoryCortex.remembered.length}`,
    },
  ];

  console.log("━".repeat(70));
  console.log("✅ 关键验证项");
  console.log("━".repeat(70));
  let passCount = 0;
  for (const c of checks) {
    const mark = c.pass ? "✅" : "❌";
    console.log(`  ${mark} ${c.name} (${c.detail})`);
    if (c.pass) passCount++;
  }
  console.log();
  console.log(`通过 ${passCount}/${checks.length} 项`);

  await brainStem.stop();
  console.log();
  console.log("观察结束。");

  if (passCount < checks.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
