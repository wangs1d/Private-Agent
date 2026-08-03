// 全环节学习测试：学经验 / 学技能 / 学知识 三层端到端
//
// 用户强调：
//  1. 自我学习是 Agent 自己的事，不需要用户确认
//  2. 仿人学习三层并列：学经验、学技能、学知识
//  3. 学知识 ≠ 联网：通过反馈、经验、验证得到真实的、属于 agent 自己的知识库
//
// 本测试验证三层学习闭环全部自主完成（无用户审批环节）：
//
//  层 1 - 学经验：
//    - 工具调用结果（含失败 errorMessage）自动写入 LearningRecord
//    - AgentSelfLearningService.recentRecords 真实累积
//    - 不需要用户介入
//
//  层 2 - 学技能：
//    - 工具反复失败 → EvolutionCortex 识别 new_capability 缺口
//    - LLM 生成 handler 代码 → 直接 promote 装载 → loaded
//    - 全过程无 awaiting_user_approval 状态
//    - 不需要用户审批
//
//  层 3 - 学知识：
//    - 工具成功 + 用户反复问 → knowledge_gap 提案
//    - RAG 召回 → 联网兜底 → LLM 摘要 → 沉淀 + 注册验证
//    - 反馈回路：用户追问=负反馈 / 切换话题=正反馈 / 明确确认=强正反馈
//    - 置信度收敛：0.3 → 0.7 → 0.9 / 0.3 → 0.1 → rejected
//    - 不需要用户审批
//
// 运行：npx tsx scripts/test-full-learning-pipeline.ts

import { EvolutionCortex } from "../src/brain/index.js";
import { AgentSelfLearningService } from "../src/services/agent-self-learning-service.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { KnowledgeVerificationService } from "../src/services/knowledge-verification-service.js";
import { KnowledgeGapExecutor } from "../src/services/knowledge-gap-executor.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";
import type { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import type {
  SkillGenerationRequest,
  SkillGenerationResult,
} from "../src/services/skill-generator.js";
import type { SkillMetadata } from "../src/skills/types.js";

// ===== Mock：NarrativeMemoryPort（始终返回空，强制走联网） =====
function createMockNarrativeMemory() {
  const ingested: Array<{ actorId: string; text: string; source: string }> = [];
  const mock: NarrativeMemoryPort = {
    async ingest(actorId, text, source) {
      ingested.push({ actorId, text, source });
    },
    async buildNarrativeRecall() { return ""; },
    async buildCrossContextRecall() { return ""; },
    async buildDetailedRecall() { return ""; },
    async buildSourceRecall() { return ""; },
    async runSleepConsolidation() { return []; },
    async selfCheck() { return { exists: false, domainId: null, confidence: 0 }; },
    getTelemetrySnapshot() { return {}; },
  };
  return { mock, ingested };
}

// ===== Mock：AgentMemorySyncService =====
function createMockMemorySync() {
  const appended: Array<{ actorId: string; line: string; topicHint?: string }> = [];
  const mock = {
    appendMemorySummaryLine(actorId: string, line: string, topicHint?: string) {
      appended.push({ actorId, line, topicHint });
    },
  } as unknown as AgentMemorySyncService;
  return { mock, appended };
}

// ===== Mock：ToolRegistry 拦截 desktop.http_get =====
function createMockToolRegistry() {
  const calls: Array<{ name: string; url?: string }> = [];
  const mock = {
    async execute(name: string, input: Record<string, unknown>) {
      calls.push({ name, url: input.url as string | undefined });
      if (name === "desktop.http_get") {
        return {
          ok: true,
          result: {
            body:
              "<html><body>" +
              "<h1>加密货币分析</h1>" +
              "<p>BTC 今日 68000 美元，24h 涨幅 2.3%。市场情绪偏多。</p>" +
              "<p>ETH 今日 3500 美元，24h 涨幅 3.5%。分析师认为近期受 ETF 资金流入影响。</p>" +
              "<p>建议关注宏观经济数据发布，CPI 公布前后波动加大。</p>" +
              "</body></html>",
          },
        };
      }
      return { ok: false, result: { error: `unknown tool: ${name}` } };
    },
  } as unknown as ToolRegistry;
  return { mock, calls };
}

// ===== Mock：SkillGenerator（模拟 LLM 生成 handler 代码） =====
function createMockSkillGenerator() {
  const generateCalls: SkillGenerationRequest[] = [];
  const mock = {
    async generateSkill(request: SkillGenerationRequest): Promise<SkillGenerationResult> {
      generateCalls.push(request);
      // 模拟 LLM 生成的真实 skill handler 代码
      const handlerCode = `async function handler(input, context) {
  // 自动生成：${request.description.slice(0, 50)}
  const result = {
    summary: "已为 ${request.description.slice(0, 30)} 生成结果",
    timestamp: new Date().toISOString(),
  };
  return { ok: true, result };
}`;
      const metadata: SkillMetadata = {
        name: "auto." + request.description.slice(0, 10).replace(/[^a-zA-Z0-9]/g, "_"),
        version: "1.0.0",
        displayName: `自动技能-${request.description.slice(0, 15)}`,
        description: request.description,
        kind: "community",
        parameters: [],
        permissions: [],
        tags: ["auto-generated"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ok: true,
        skill: {
          metadata,
          handlerCode,
          explanation: "由 SkillGenerator 自动生成的技能代码",
        },
      };
    },
  };
  return { mock, generateCalls };
}

// ===== Mock：PromotionPipeline（模拟 skill 装载） =====
function createMockPromotionPipeline() {
  const promoted: Array<{ name: string; handlerCodeLength: number }> = [];
  const mock = {
    async promote(skill: { metadata: SkillMetadata; handlerCode: string }) {
      promoted.push({
        name: skill.metadata.name,
        handlerCodeLength: skill.handlerCode.length,
      });
      return { ok: true };
    },
  };
  return { mock, promoted };
}

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 全环节学习测试：学经验 / 学技能 / 学知识 三层端到端");
  console.log("=".repeat(70));
  console.log("📋 设计原则：自我学习是 Agent 自己的事，三层都不需要用户确认\n");

  // === 装配 ===
  const { mock: mockNarrativeMemory, ingested } = createMockNarrativeMemory();
  const { mock: mockMemorySync, appended } = createMockMemorySync();
  const { mock: mockToolRegistry, calls: toolCalls } = createMockToolRegistry();
  const { mock: mockSkillGenerator, generateCalls } = createMockSkillGenerator();
  const { mock: mockPromotionPipeline, promoted } = createMockPromotionPipeline();

  const knowledgeVerification = new KnowledgeVerificationService();
  await knowledgeVerification.start();

  const knowledgeExecutor = new KnowledgeGapExecutor({
    toolRegistry: mockToolRegistry,
    narrativeMemory: mockNarrativeMemory,
    memorySync: mockMemorySync,
    verification: knowledgeVerification,
    chatProvider: null, // 不调 LLM，降级为原始 snippet
  });

  const selfLearning = new AgentSelfLearningService(null, mockToolRegistry, null);
  const evolution = new EvolutionCortex();
  evolution.registerSelfLearning(selfLearning);
  evolution.registerSkillGenerator(mockSkillGenerator);
  evolution.registerPromotionPipeline(mockPromotionPipeline);
  evolution.registerKnowledgeExecutor(knowledgeExecutor);
  evolution.registerKnowledgeVerification(knowledgeVerification);

  let passed = 0;
  let failed = 0;
  const assert = (cond: boolean, msg: string) => {
    if (cond) {
      console.log(`  ✅ ${msg}`);
      passed++;
    } else {
      console.log(`  ❌ ${msg}`);
      failed++;
    }
  };

  // ============================================================
  // 层 1：学经验（失败轨迹自动沉淀）
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("📚 层 1：学经验 - 失败轨迹自动沉淀到 LearningRecord");
  console.log("=".repeat(70));

  // 模拟 4 次工具调用失败（某工具反复报错）
  console.log("\n  注入 4 次工具调用失败轨迹...");
  for (let i = 0; i < 4; i++) {
    await evolution.recordToolInteraction({
      sessionId: "exp-1",
      userRequest: `帮我查询区块链项目${i + 1}的信息`,
      attemptedTools: ["blockchain.info"],
      success: false,
      errorMessage: `工具 blockchain.info 调用失败：connection refused (attempt ${i + 1})`,
      responseTime: 1200 + i * 100,
    });
  }

  const records = selfLearning.getRecentRecords();
  console.log(`  LearningRecord 累积: ${records.length} 条`);
  assert(records.length === 4, `学经验：4 条失败轨迹已自动沉淀（实际 ${records.length}）`);
  assert(
    records.every((r) => r.success === false),
    "学经验：所有记录 success=false",
  );
  assert(
    records.every((r) => r.errorMessage?.includes("connection refused")),
    "学经验：errorMessage 字段被正确保存",
  );
  assert(
    records.every((r) => r.attemptedTools?.includes("blockchain.info")),
    "学经验：attemptedTools 字段被正确保存",
  );
  console.log("  ✓ 学经验层已验证：失败轨迹通过 AgentSelfLearningService 自动沉淀，无需用户介入");

  // ============================================================
  // 层 2：学技能（工具反复失败 → LLM 生成 → 直接装载）
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("🛠️  层 2：学技能 - 工具反复失败 → LLM 生成 handler → 直接装载");
  console.log("=".repeat(70));

  // 上面已注入 4 次失败，fromSelfLearningGap 应识别为技能层缺口
  // （new_capability = 新建工具 / optimize_existing = 优化现有工具，两者都属于学技能层）
  console.log("\n  fromSelfLearningGap 识别能力缺口...");
  const gap1 = evolution.fromSelfLearningGap();
  console.log(`  产出提案: type=${gap1?.type} title="${gap1?.title}"`);
  assert(
    gap1?.type === "new_capability" || gap1?.type === "optimize_existing",
    `学技能：识别为技能层提案（new_capability 或 optimize_existing，实际 ${gap1?.type}）`,
  );
  assert(
    gap1?.title.includes("blockchain.info") || gap1?.rationale.includes("blockchain.info"),
    "学技能：提案标题/理由含失败工具名",
  );

  // review + approve（自动批准，非 LLM）
  evolution.review(gap1!.id);
  evolution.approve(gap1!.id);
  console.log(`  review + approve 完成，状态: ${evolution.get(gap1!.id)?.status}`);

  // execute：应直接调 SkillGenerator + PromotionPipeline.promote → loaded
  console.log("\n  execute 执行：LLM 生成 handler → 直接 promote 装载...");
  const executed1 = await evolution.execute(gap1!.id);
  console.log(`  执行后状态: ${executed1?.status}`);
  assert(
    executed1?.status === "loaded",
    `学技能：execute 后直接 loaded（无需用户审批，实际 ${executed1?.status}）`,
  );
  assert(
    generateCalls.length === 1,
    `学技能：SkillGenerator.generateSkill 被调用 1 次（实际 ${generateCalls.length}）`,
  );
  assert(
    promoted.length === 1,
    `学技能：PromotionPipeline.promote 被调用 1 次（实际 ${promoted.length}）`,
  );
  assert(
    promoted[0]?.handlerCodeLength > 0,
    "学技能：装载的 handler 代码非空",
  );

  // 关键：验证不进 awaiting_user_approval 状态
  const finalProposal1 = evolution.get(gap1!.id);
  assert(
    finalProposal1?.status !== "awaiting_user_approval",
    "学技能：终态不是 awaiting_user_approval（无需用户审批）",
  );

  // 验证 getMeta 包含生成的 skill 信息
  const meta1 = evolution.getMeta(gap1!.id);
  assert(
    !!meta1?.generatedSkill?.handlerCode,
    "学技能：meta.generatedSkill 包含生成的 handler 代码",
  );
  console.log("  ✓ 学技能层已验证：LLM 生成 + 直接装载 + 无用户审批环节");

  // ============================================================
  // 层 3：学知识（用户反复问 → 联网+沉淀+验证状态机）
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("🧠 层 3：学知识 - 反复问 → 联网+沉淀 → 反馈+验证收敛");
  console.log("=".repeat(70));

  // 清空 records（避免上层失败轨迹影响）—— 通过重新创建 EvolutionCortex 实例
  const selfLearning2 = new AgentSelfLearningService(null, mockToolRegistry, null);
  const evolution2 = new EvolutionCortex();
  evolution2.registerSelfLearning(selfLearning2);
  evolution2.registerSkillGenerator(mockSkillGenerator);
  evolution2.registerPromotionPipeline(mockPromotionPipeline);
  evolution2.registerKnowledgeExecutor(knowledgeExecutor);
  evolution2.registerKnowledgeVerification(knowledgeVerification);

  // 3.1 采集闸门：注入 4 次工具成功 + 反复问"以太坊"
  console.log("\n  --- 3.1 采集闸门：联网沉淀为 pending_verification ---");
  for (let i = 0; i < 4; i++) {
    await evolution2.recordToolInteraction({
      sessionId: "know-1",
      userRequest: ["以太坊什么行情", "以太坊价格", "以太坊分析", "以太坊涨跌"][i],
      attemptedTools: ["search_web"],
      success: true,
    });
  }
  const gap2 = evolution2.fromSelfLearningGap();
  console.log(`  产出提案: type=${gap2?.type} title="${gap2?.title}"`);
  assert(gap2?.type === "knowledge_gap", "学知识：识别为 knowledge_gap 提案");
  assert(gap2?.title.includes("以太坊"), "学知识：提案标题含完整主题词「以太坊」");

  evolution2.review(gap2!.id);
  evolution2.approve(gap2!.id);
  const executed2 = await evolution2.execute(gap2!.id);
  console.log(`  执行后状态: ${executed2?.status}`);

  const stats1 = knowledgeVerification.getStats();
  console.log(`  verification stats: ${JSON.stringify(stats1)}`);
  assert(executed2?.status === "loaded", "学知识：execute 后直接 loaded");
  assert(stats1.pending === 1, `学知识：采集后 pending_verification=1（实际 ${stats1.pending}）`);

  // 验证联网 + 沉淀被调用
  assert(
    toolCalls.some((c) => c.name === "desktop.http_get"),
    "学知识：联网 desktop.http_get 被调用",
  );
  assert(
    ingested.length >= 1,
    `学知识：NarrativeMemoryPort.ingest 被调用 ${ingested.length} 次`,
  );
  assert(
    appended.some((a) => a.line.includes("待验证") && a.line.includes("以太坊")),
    "学知识：memory_facts 写入含「待验证」+「以太坊」标签",
  );

  // 3.2 负反馈：用户继续追问同类 → disputed → rejected
  console.log("\n  --- 3.2 负反馈：用户追问同类 → disputed → rejected ---");
  await evolution2.recordToolInteraction({
    sessionId: "know-2",
    userRequest: "以太坊最新价格是多少",
    attemptedTools: ["search_web"],
    success: true,
  });
  const stats2 = knowledgeVerification.getStats();
  console.log(`  1 次负反馈后 stats: ${JSON.stringify(stats2)}`);
  assert(stats2.disputed === 1, `学知识：1 次负反馈 → disputed=1（实际 ${stats2.disputed}）`);

  await evolution2.recordToolInteraction({
    sessionId: "know-3",
    userRequest: "以太坊还会涨吗",
    attemptedTools: ["search_web"],
    success: true,
  });
  await evolution2.recordToolInteraction({
    sessionId: "know-4",
    userRequest: "以太坊怎么看",
    attemptedTools: ["search_web"],
    success: true,
  });
  const stats3 = knowledgeVerification.getStats();
  console.log(`  3 次负反馈后 stats: ${JSON.stringify(stats3)}`);
  assert(stats3.rejected === 1, `学知识：3 次负反馈 → rejected=1（实际 ${stats3.rejected}）`);

  // 3.3 重新学习新主题：注入"比特币"（验证 rejected 后能继续学新主题）
  console.log("\n  --- 3.3 学新主题：注入「比特币」（验证主题隔离）---");
  for (let i = 0; i < 4; i++) {
    await evolution2.recordToolInteraction({
      sessionId: "know-5",
      userRequest: ["比特币什么行情", "比特币价格", "比特币分析", "比特币涨跌"][i],
      attemptedTools: ["search_web"],
      success: true,
    });
  }
  const gap3 = evolution2.fromSelfLearningGap();
  console.log(`  新提案: type=${gap3?.type} title="${gap3?.title}"`);
  assert(gap3?.type === "knowledge_gap", "学知识：第二个主题识别为 knowledge_gap");
  assert(gap3?.title.includes("比特币"), "学知识：提案标题含「比特币」（最长匹配）");

  evolution2.review(gap3!.id);
  evolution2.approve(gap3!.id);
  await evolution2.execute(gap3!.id);
  const stats4 = knowledgeVerification.getStats();
  console.log(`  比特币知识沉淀后 stats: ${JSON.stringify(stats4)}`);
  assert(stats4.pending === 1, `学知识：比特币 pending=1（实际 ${stats4.pending}）`);

  // 3.4 隐式正反馈：用户切换话题 → pending → verified
  console.log("\n  --- 3.4 隐式正反馈：用户切换话题 → verified ---");
  await evolution2.recordToolInteraction({
    sessionId: "know-6",
    userRequest: "今天天气怎么样",
    attemptedTools: ["weather_api"],
    success: true,
  });
  const stats5 = knowledgeVerification.getStats();
  console.log(`  切换话题后 stats: ${JSON.stringify(stats5)}`);
  assert(stats5.verified === 1, `学知识：隐式正反馈 → verified=1（实际 ${stats5.verified}）`);

  const btcEntry = knowledgeVerification.queryByTopic("比特币")[0];
  console.log(`  比特币知识: status=${btcEntry?.status} confidence=${btcEntry?.confidence}`);
  assert(
    btcEntry?.status === "verified" && btcEntry.confidence >= 0.7,
    `学知识：置信度收敛至 0.7+（实际 ${btcEntry?.confidence}）`,
  );

  // 3.5 强正反馈：用户明确确认 → verified_strong
  console.log("\n  --- 3.5 强正反馈：用户明确确认 → verified_strong ---");
  await evolution2.recordToolInteraction({
    sessionId: "know-7",
    userRequest: "对的，比特币的信息很准确，谢谢",
    attemptedTools: [],
    success: true,
  });
  const stats6 = knowledgeVerification.getStats();
  console.log(`  明确确认后 stats: ${JSON.stringify(stats6)}`);
  assert(stats6.verifiedStrong === 1, `学知识：强正反馈 → verified_strong=1（实际 ${stats6.verifiedStrong}）`);

  const btcStrong = knowledgeVerification.queryByTopic("比特币")[0];
  console.log(`  比特币最终: status=${btcStrong?.status} confidence=${btcStrong?.confidence}`);
  assert(
    btcStrong?.status === "verified_strong" && btcStrong.confidence >= 0.9,
    `学知识：置信度收敛至 0.9+（实际 ${btcStrong?.confidence}）`,
  );

  // 3.6 RAG 召回差异化
  console.log("\n  --- 3.6 RAG 召回差异化：verified_strong 优先，无待验证标签 ---");
  const recall = await knowledgeExecutor.executeKnowledgeGap({
    actorId: "test-recall",
    query: "比特币",
    rationale: "测试召回",
  });
  console.log(`  召回结果: ragHit=${recall.ragHit} confidence=${recall.confidence}`);
  assert(recall.ragHit === true, "学知识：RAG 命中（已沉淀的 verified_strong 知识）");
  assert(recall.confidence === 0.9, `学知识：召回置信度=0.9（实际 ${recall.confidence}）`);
  assert(
    !recall.knowledge?.includes("可能不准确"),
    "学知识：verified_strong 知识召回无「可能不准确」标签",
  );

  console.log("\n  ✓ 学知识层已验证：联网+沉淀+验证状态机+反馈回路，全程无用户介入");

  // ============================================================
  // 全局验证：三层学习闭环全部自主完成（无 awaiting_user_approval）
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("🎯 全局验证：三层学习闭环全部自主完成");
  console.log("=".repeat(70));

  // 验证所有提案终态都不是 awaiting_user_approval
  const allProposals = [
    ...evolution.listAll(),
    ...evolution2.listAll(),
  ];
  const awaitingCount = allProposals.filter(
    (p) => p.status === "awaiting_user_approval",
  ).length;
  console.log(`  所有提案终态: ${allProposals.map((p) => `${p.type}=${p.status}`).join(", ")}`);
  assert(
    awaitingCount === 0,
    `全局：无任何提案处于 awaiting_user_approval 状态（实际 ${awaitingCount} 个）`,
  );

  // 验证三层都有产出
  const layer1Ok = records.length === 4; // 学经验
  const layer2Ok = promoted.length === 1; // 学技能
  const layer3Ok = stats6.verifiedStrong === 1; // 学知识
  console.log(
    `  层 1 学经验: ${records.length} 条 LearningRecord ✓\n` +
    `  层 2 学技能: ${promoted.length} 个 Skill 已装载 ✓\n` +
    `  层 3 学知识: verified_strong=${stats6.verifiedStrong} 条 ✓`,
  );
  assert(layer1Ok && layer2Ok && layer3Ok, "全局：三层学习闭环全部产出有效结果");

  // ============================================================
  // 总结
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log(`📊 全环节学习测试：通过 ${passed}/${passed + failed} 项`);
  console.log("=".repeat(70));
  if (failed > 0) {
    console.error(`❌ 失败 ${failed} 项`);
    process.exit(1);
  }
  console.log("\n✅ 仿人自我学习三层闭环已全部验证：");
  console.log("   ┌──────────────────────────────────────────────────────────┐");
  console.log("   │ 层 1 学经验  │ AgentSelfLearningService 自动沉淀失败轨迹   │");
  console.log("   │              │ → 无用户介入                                │");
  console.log("   ├──────────────────────────────────────────────────────────┤");
  console.log("   │ 层 2 学技能  │ EvolutionCortex 识别 new_capability 缺口     │");
  console.log("   │              │ → SkillGenerator LLM 生成 handler            │");
  console.log("   │              │ → PromotionPipeline.promote 直接装载         │");
  console.log("   │              │ → LimbicCortex 安全闸门（无需用户审批）     │");
  console.log("   ├──────────────────────────────────────────────────────────┤");
  console.log("   │ 层 3 学知识  │ EvolutionCortex 识别 knowledge_gap 缺口      │");
  console.log("   │              │ → KnowledgeGapExecutor 联网+LLM 摘要+沉淀    │");
  console.log("   │              │ → KnowledgeVerificationService 反馈状态机    │");
  console.log("   │              │   pending(0.3) → verified(0.7) → strong(0.9)│");
  console.log("   │              │   pending(0.3) → disputed(0.1) → rejected   │");
  console.log("   │              │ → 与联网的根本区别：验证+反馈+置信度收敛     │");
  console.log("   └──────────────────────────────────────────────────────────┘");
  console.log("\n   全程无 awaiting_user_approval 状态，无用户审批环节。");
  console.log("   学知识 ≠ 联网：联网有真有假，学知识通过反馈验证得到 Agent 自己的知识库。");
}

main().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
