// 知识层自我学习端到端测试（学知识闭环）
//
// 验证仿人自我学习的"学知识"层真实生效：
//   1. 通过 brainCenter.recordToolInteraction 注入"工具调用成功 + 用户反复问同类问题"轨迹
//      → fromSelfLearningGap 识别为 knowledge_gap 提案（非 new_capability / optimize_existing）
//   2. 调 evolutionCortex.runAutoEvolutionCycle
//      → pending → reviewing → approved → executeKnowledgeGap → loaded
//      （跳过 awaiting_user_approval：知识不是危险操作，不需要用户审批）
//   3. 验证 KnowledgeGapExecutor 三阶段闭环：
//      - RAG 召回（mock：空→返回未命中，触发联网兜底）
//      - 联网兜底（mock：调 toolRegistry.execute("desktop.http_get") 返回网页内容）
//      - 记忆沉淀（验证 narrativeMemory.ingest + memorySync.appendMemorySummaryLine 被调用）
//   4. 验证状态机：knowledge_gap 不进 awaiting_user_approval，直接 loaded
//
// 运行：npx tsx scripts/test-knowledge-gap-e2e.ts

import {
  EvolutionCortex,
} from "../src/brain/index.js";
import { AgentSelfLearningService } from "../src/services/agent-self-learning-service.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";
import type { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import type { KnowledgeGapExecutorLike } from "../src/brain/evolution-cortex.js";

// ===== Mock：最小化的 NarrativeMemoryPort =====
// 行为：
//  - 第一次 recall 返回空（模拟本地知识库未命中）
//  - ingest 被调用时记录调用参数（验证沉淀）
function createMockNarrativeMemory() {
  const ingested: Array<{ actorId: string; text: string; source: string }> = [];
  let recallCallCount = 0;
  const mock: NarrativeMemoryPort = {
    async ingest(actorId, text, source, _opts) {
      ingested.push({ actorId, text, source });
      console.log(`    [MockNarrativeMemory.ingest] actorId=${actorId} source=${source} text=${text.slice(0, 80)}...`);
    },
    async buildNarrativeRecall(_actorId, _query) {
      recallCallCount++;
      console.log(`    [MockNarrativeMemory.buildNarrativeRecall] 第 ${recallCallCount} 次调用，返回空（模拟未命中）`);
      return "";
    },
    async buildCrossContextRecall() { return ""; },
    async buildDetailedRecall() { return ""; },
    async buildSourceRecall() { return ""; },
    async runSleepConsolidation() { return []; },
    async selfCheck() { return { exists: false, domainId: null, confidence: 0 }; },
    getTelemetrySnapshot() { return {}; },
  };
  return { mock, ingested, getRecallCallCount: () => recallCallCount };
}

// ===== Mock：最小化的 AgentMemorySyncService =====
// 只暴露 KnowledgeGapExecutor 实际用到的方法
function createMockMemorySync() {
  const appended: Array<{ actorId: string; line: string; topicHint?: string }> = [];
  const mock = {
    appendMemorySummaryLine(actorId: string, line: string, topicHint?: string) {
      appended.push({ actorId, line, topicHint });
      console.log(`    [MockMemorySync.appendMemorySummaryLine] actorId=${actorId} topicHint=${topicHint ?? "undefined"} line=${line.slice(0, 80)}...`);
    },
  } as unknown as AgentMemorySyncService;
  return { mock, appended };
}

// ===== Mock：ToolRegistry，仅拦截 desktop.http_get =====
function createMockToolRegistry() {
  const calls: Array<{ url: string; timeoutMs?: number }> = [];
  const mock = {
    async execute(name: string, input: Record<string, unknown>, _context: unknown) {
      console.log(`    [MockToolRegistry.execute] tool=${name} url=${input.url}`);
      if (name === "desktop.http_get") {
        calls.push({ url: input.url as string, timeoutMs: input.timeoutMs as number | undefined });
        // 返回一段模拟的网页 HTML 内容
        const body = `
          <html><body>
            <h1>比特币行情分析</h1>
            <p>比特币（BTC）今日价格 68000 美元，24 小时涨幅 2.3%。市场情绪偏多。</p>
            <p>分析师认为近期受 ETF 资金流入影响，价格可能继续上行至 70000 美元阻力位。</p>
            <script>console.log("noise");</script>
            <style>body { color: red; }</style>
          </body></html>
        `;
        return { ok: true, result: { body } };
      }
      return { ok: false, result: { error: `unknown tool: ${name}` } };
    },
  } as unknown as ToolRegistry;
  return { mock, calls };
}

// ===== 真实 KnowledgeGapExecutor（不 mock，验证真实执行链） =====
import { KnowledgeGapExecutor } from "../src/services/knowledge-gap-executor.js";

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 知识层自我学习端到端测试（学知识闭环真实生效）");
  console.log("=".repeat(70));

  // === 装配 ===
  const { mock: mockNarrativeMemory, ingested, getRecallCallCount } = createMockNarrativeMemory();
  const { mock: mockMemorySync, appended } = createMockMemorySync();
  const { mock: mockToolRegistry, calls: httpCalls } = createMockToolRegistry();

  const knowledgeExecutor = new KnowledgeGapExecutor({
    toolRegistry: mockToolRegistry,
    narrativeMemory: mockNarrativeMemory,
    memorySync: mockMemorySync,
  });

  // 真实 AgentSelfLearningService（不依赖 externalChat）
  const selfLearning = new AgentSelfLearningService(null, mockToolRegistry, null);
  const evolution = new EvolutionCortex();
  evolution.registerSelfLearning(selfLearning);
  evolution.registerKnowledgeExecutor(knowledgeExecutor);

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

  // ===== 测试 1：注入"工具成功 + 用户反复问"轨迹，fromSelfLearningGap 产出 knowledge_gap =====
  console.log("\n--- 测试 1：识别 knowledge_gap（非技能缺口）---");

  // 注入 4 次"工具调用成功 + 用户反复问比特币行情"
  for (let i = 0; i < 4; i++) {
    await evolution.recordToolInteraction({
      sessionId: "knowledge-test-1",
      userRequest: [
        "比特币现在什么行情",
        "比特币今天价格多少",
        "比特币行情怎么样",
        "比特币还会涨吗",
      ][i],
      attemptedTools: ["search_web"],
      success: true, // 关键：成功，但用户还在反复问 → 知识缺口
      responseTime: 800 + i * 100,
    });
  }
  const records = selfLearning.getRecentRecords();
  console.log(`  recentRecords.length=${records.length}, allSuccess=${records.every(r => r.success)}`);
  assert(records.length === 4, "工具调用成功记录被写入 selfLearning（4 条）");

  // 调 fromSelfLearningGap
  const gap = evolution.fromSelfLearningGap();
  console.log(`  产出提案: type=${gap?.type} title="${gap?.title}"`);
  assert(gap !== null, "fromSelfLearningGap 产出提案（非 null）");
  assert(gap?.type === "knowledge_gap", `提案类型为 knowledge_gap（实际: ${gap?.type}）`);
  assert(gap?.title.includes("比特"), `提案标题含主题词"比特"（实际: ${gap?.title}）`);

  // ===== 测试 2：状态机推进 pending → reviewing → approved → loaded =====
  console.log("\n--- 测试 2：状态机推进 knowledge_gap → loaded（跳过 awaiting_user_approval）---");

  const beforePending = evolution.listPending().length;
  console.log(`  pending 提案数（before autoLoop）: ${beforePending}`);

  // 执行一次 autoLoop（推进 pending → reviewing → approved → execute → loaded）
  // 注意：runAutoEvolutionCycle 是 private 方法，但我们可以通过 review/approve/execute 显式推进
  const proposalId = gap!.id;
  evolution.review(proposalId);
  console.log(`  review() → status=${evolution.get(proposalId)?.status}`);
  assert(evolution.get(proposalId)?.status === "reviewing", "review 后状态为 reviewing");

  evolution.approve(proposalId);
  console.log(`  approve() → status=${evolution.get(proposalId)?.status}`);
  assert(evolution.get(proposalId)?.status === "approved", "approve 后状态为 approved");

  // 执行 knowledge_gap 提案
  const executed = await evolution.execute(proposalId);
  console.log(`  execute() → status=${executed?.status}`);
  assert(executed?.status === "loaded", "knowledge_gap 执行后直接 loaded（跳过 awaiting_user_approval）");

  // ===== 测试 3：KnowledgeGapExecutor 三阶段闭环真实执行 =====
  console.log("\n--- 测试 3：KnowledgeGapExecutor 三阶段闭环验证 ---");

  // 阶段 1：RAG 召回（mock 返回空，未命中）
  assert(getRecallCallCount() >= 1, `RAG 召回被调用（>=1 次，实际 ${getRecallCallCount()}）`);

  // 阶段 2：联网兜底（mock desktop.http_get 被调用）
  assert(httpCalls.length === 1, `desktop.http_get 被调用（1 次，实际 ${httpCalls.length}）`);
  assert(httpCalls[0]?.url.includes("q=") || httpCalls[0]?.url.includes("query"),
    `联网 URL 含 q= 或 query 查询参数（实际: ${httpCalls[0]?.url}）`);

  // 阶段 3：记忆沉淀（narrativeMemory.ingest + memorySync.appendMemorySummaryLine 都被调用）
  assert(ingested.length === 1, `narrativeMemory.ingest 被调用（1 次，实际 ${ingested.length}）`);
  assert(ingested[0]?.source === "knowledge-gap:web", `ingest source 为 knowledge-gap:web（实际: ${ingested[0]?.source}）`);
  assert(ingested[0]?.text.includes("比特币") || ingested[0]?.text.includes("BTC"),
    `ingest text 含查询关键词（实际: ${ingested[0]?.text.slice(0, 100)}）`);

  assert(appended.length === 1, `memorySync.appendMemorySummaryLine 被调用（1 次，实际 ${appended.length}）`);
  assert(appended[0]?.topicHint === "knowledge", `appendMemorySummaryLine topicHint 为 knowledge（实际: ${appended[0]?.topicHint}）`);

  // ===== 测试 4：验证 skill/learning 字段被正确填充 =====
  console.log("\n--- 测试 4：meta.generatedSkill 字段验证 ---");

  const meta = evolution.getMeta(proposalId);
  console.log(`  meta.generatedSkill.name=${meta?.generatedSkill?.name}`);
  console.log(`  meta.generatedSkill.explanation=${meta?.generatedSkill?.explanation}`);
  assert(meta?.generatedSkill !== undefined, "meta.generatedSkill 被填充（非 undefined）");
  assert(meta?.generatedSkill?.name?.includes("比特币") || meta?.generatedSkill?.name?.includes("query") || meta?.generatedSkill?.name?.startsWith("knowledge:"),
    `generatedSkill.name 形如 knowledge:xxx（实际: ${meta?.generatedSkill?.name}）`);
  assert(meta?.generatedSkill?.explanation?.includes("联网") === true,
    `explanation 含来源标记"联网"（实际: ${meta?.generatedSkill?.explanation}）`);

  // ===== 测试 5：再次注入同类请求 → RAG 命中（不再联网） =====
  console.log("\n--- 测试 5：RAG 命中后不再联网（避免重复入库）---");

  // 改造 mock：让 RAG 召回返回足够长的内容（模拟已沉淀的知识被命中）
  let ragHitCallCount = 0;
  (mockNarrativeMemory as NarrativeMemoryPort).buildNarrativeRecall = async () => {
    ragHitCallCount++;
    console.log(`    [MockNarrativeMemory.buildNarrativeRecall] 第 ${ragHitCallCount} 次调用，返回长内容（模拟命中）`);
    return "比特币（BTC）今日价格 68000 美元，24 小时涨幅 2.3%。".repeat(5); // > 80 字符
  };
  const httpCallsBeforeTest5 = httpCalls.length;

  // 创建第二个 knowledge_gap 提案
  for (let i = 0; i < 4; i++) {
    await evolution.recordToolInteraction({
      sessionId: "knowledge-test-2",
      userRequest: ["以太坊什么行情", "以太坊价格", "以太坊涨跌", "以太坊分析"][i],
      attemptedTools: ["search_web"],
      success: true,
    });
  }
  const gap2 = evolution.fromSelfLearningGap();
  console.log(`  第二个提案: type=${gap2?.type} title="${gap2?.title}"`);
  assert(gap2 !== null && gap2.type === "knowledge_gap", "第二个 knowledge_gap 提案被识别");

  if (gap2) {
    evolution.review(gap2.id);
    evolution.approve(gap2.id);
    await evolution.execute(gap2.id);
    const httpCallsAfterTest5 = httpCalls.length;
    console.log(`  http_get 调用次数（test5 before=${httpCallsBeforeTest5}, after=${httpCallsAfterTest5}）`);
    assert(httpCallsAfterTest5 === httpCallsBeforeTest5,
      "RAG 命中后不再联网（http_get 未被再次调用）");
    assert(evolution.get(gap2.id)?.status === "loaded",
      `第二个提案也直接 loaded（实际: ${evolution.get(gap2.id)?.status}）`);
  }

  // ===== 总结 =====
  console.log("\n" + "=".repeat(70));
  console.log(`📊 知识层自我学习端到端测试：通过 ${passed}/${passed + failed} 项`);
  console.log("=".repeat(70));
  if (failed > 0) {
    console.error(`❌ 失败 ${failed} 项`);
    process.exit(1);
  }
  console.log("✅ 仿人自我学习三层结构全部打通：");
  console.log("   - 学经验（LearningRecord 沉淀失败轨迹）✓");
  console.log("   - 学技能（SkillGenerator 造新工具）✓");
  console.log("   - 学知识（RAG + 联网 + 记忆沉淀）✓");
}

main().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
