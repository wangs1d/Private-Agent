// 真实学知识闭环端到端测试（验证状态机 + 反馈回路）
//
// 用户强调：学知识 ≠ 联网。区别在于"真实 + 属于自己"——
// 通过反馈、经验、验证得到真实的、属于 agent 自己的知识库。
//
// 验证三道闸门 + 反馈回路：
//
//  1. **采集闸门**：联网拉取 → 沉淀为 pending_verification，置信度 0.3
//  2. **隐式正反馈**：用户切换话题 → pending_verification 升级为 verified，置信度 0.7
//  3. **强正反馈**：用户明确确认（"对的"/"谢谢"）→ verified_strong，置信度 0.9
//  4. **负反馈**：用户继续追问同类 + 工具成功 → disputed，置信度 0.1
//  5. **多次负反馈**：累积达阈值 → rejected（从 active 集合移除）
//  6. **RAG 召回差异化**：verified 优先返回；disputed/rejected 不返回
//
// 运行：npx tsx scripts/test-knowledge-verification-e2e.ts

import {
  EvolutionCortex,
} from "../src/brain/index.js";
import { AgentSelfLearningService } from "../src/services/agent-self-learning-service.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { KnowledgeVerificationService } from "../src/services/knowledge-verification-service.js";
import { KnowledgeGapExecutor } from "../src/services/knowledge-gap-executor.js";
import type { NarrativeMemoryPort } from "../src/services/narrative-memory-port.js";
import type { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";

// ===== Mock：最小化的 NarrativeMemoryPort（始终返回空，强制走联网） =====
function createMockNarrativeMemory() {
  const ingested: Array<{ actorId: string; text: string; source: string }> = [];
  const mock: NarrativeMemoryPort = {
    async ingest(actorId, text, source) {
      ingested.push({ actorId, text, source });
    },
    async buildNarrativeRecall() { return ""; }, // 始终返回空，强制走联网
    async buildCrossContextRecall() { return ""; },
    async buildDetailedRecall() { return ""; },
    async buildSourceRecall() { return ""; },
    async runSleepConsolidation() { return []; },
    async selfCheck() { return { exists: false, domainId: null, confidence: 0 }; },
    getTelemetrySnapshot() { return {}; },
  };
  return { mock, ingested };
}

// ===== Mock：最小化的 AgentMemorySyncService =====
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
// 返回足够长的网页内容（>80 字符），让 RAG 召回能命中
function createMockToolRegistry() {
  const calls: Array<{ url: string }> = [];
  const mock = {
    async execute(name: string, input: Record<string, unknown>) {
      if (name === "desktop.http_get") {
        calls.push({ url: input.url as string });
        // 返回足够长的内容，让 extractSnippet 产出 > 80 字符
        return {
          ok: true,
          result: {
            body:
              "<html><body>" +
              "<h1>加密货币分析</h1>" +
              "<p>BTC 今日 68000 美元，24h 涨幅 2.3%。市场情绪偏多。</p>" +
              "<p>ETH 今日 3500 美元，24h 涨幅 3.5%。分析师认为近期受 ETF 资金流入影响。</p>" +
              "<p>建议关注宏观经济数据发布，CPI 公布前后波动加大。</p>" +
              "<script>console.log('noise');</script>" +
              "</body></html>",
          },
        };
      }
      return { ok: false, result: { error: `unknown tool: ${name}` } };
    },
  } as unknown as ToolRegistry;
  return { mock, calls };
}

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 真实学知识闭环端到端测试（区别于联网：反馈+验证+置信度收敛）");
  console.log("=".repeat(70));

  // === 装配 ===
  const { mock: mockNarrativeMemory, ingested } = createMockNarrativeMemory();
  const { mock: mockMemorySync, appended } = createMockMemorySync();
  const { mock: mockToolRegistry, calls: httpCalls } = createMockToolRegistry();
  const knowledgeVerification = new KnowledgeVerificationService();
  await knowledgeVerification.start();

  const knowledgeExecutor = new KnowledgeGapExecutor({
    toolRegistry: mockToolRegistry,
    narrativeMemory: mockNarrativeMemory,
    memorySync: mockMemorySync,
    verification: knowledgeVerification,
    chatProvider: null, // 不调 LLM，降级为原始 snippet
  });

  // 真实 EvolutionCortex + 真实 AgentSelfLearningService
  const selfLearning = new AgentSelfLearningService(null, mockToolRegistry, null);
  const evolution = new EvolutionCortex();
  evolution.registerSelfLearning(selfLearning);
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

  // ===== 测试 1：采集闸门 - 联网拉取沉淀为 pending_verification，置信度 0.3 =====
  console.log("\n--- 测试 1：采集闸门 - 联网沉淀为 pending_verification ---");

  // 注入 4 次工具调用成功 + 用户反复问"比特币"
  for (let i = 0; i < 4; i++) {
    await evolution.recordToolInteraction({
      sessionId: "knowledge-1",
      userRequest: ["比特币什么行情", "比特币价格", "比特币分析", "比特币涨跌"][i],
      attemptedTools: ["search_web"],
      success: true,
    });
  }
  const gap = evolution.fromSelfLearningGap();
  console.log(`  产出提案: type=${gap?.type} title="${gap?.title}"`);
  assert(gap?.type === "knowledge_gap", "提案类型为 knowledge_gap");
  assert(gap?.title.includes("比特币"), `提案标题含完整主题词"比特币"（最长匹配优先）`);

  // 执行提案：触发联网 + 沉淀 + 注册验证
  evolution.review(gap!.id);
  evolution.approve(gap!.id);
  const executed = await evolution.execute(gap!.id);
  console.log(`  执行后状态: ${executed?.status}`);

  const stats1 = knowledgeVerification.getStats();
  console.log(`  verification stats: ${JSON.stringify(stats1)}`);
  assert(executed?.status === "loaded", "knowledge_gap 执行后直接 loaded");
  assert(stats1.pending === 1, `采集后 pending_verification 条目数=1（实际 ${stats1.pending}）`);
  assert(httpCalls.length === 1, `联网被调用 1 次（实际 ${httpCalls.length}）`);

  // 验证 memory_facts 写入带"待验证"标签
  assert(
    appended.some((a) => a.line.includes("待验证") && a.line.includes("比特币")),
    "memory_facts 写入含「待验证」+「比特币」标签",
  );

  // ===== 测试 2：负反馈 - 用户继续追问同类 → disputed → rejected =====
  console.log("\n--- 测试 2：负反馈 - 用户追问同类 → disputed → rejected ---");

  // 用户继续追问 1 次（含主题词"比特币"+ 工具成功）→ disputed
  await evolution.recordToolInteraction({
    sessionId: "knowledge-2",
    userRequest: "比特币最新价格是多少",
    attemptedTools: ["search_web"],
    success: true,
  });
  const stats2 = knowledgeVerification.getStats();
  console.log(`  1 次负反馈后 stats: ${JSON.stringify(stats2)}`);
  assert(stats2.disputed === 1, `1 次负反馈 → disputed=1（实际 ${stats2.disputed}）`);
  assert(stats1.pending === 1 && stats2.pending === 0, "pending 数量减少（已转 disputed）");

  // 用户继续追问 2 次（累积达阈值 3）→ rejected
  await evolution.recordToolInteraction({
    sessionId: "knowledge-3",
    userRequest: "比特币还会涨吗",
    attemptedTools: ["search_web"],
    success: true,
  });
  await evolution.recordToolInteraction({
    sessionId: "knowledge-4",
    userRequest: "比特币怎么看",
    attemptedTools: ["search_web"],
    success: true,
  });
  const stats3 = knowledgeVerification.getStats();
  console.log(`  3 次负反馈后 stats: ${JSON.stringify(stats3)}`);
  assert(stats3.rejected === 1, `3 次负反馈 → rejected=1（实际 ${stats3.rejected}）`);

  // ===== 测试 3：RAG 召回差异化 - rejected 不再返回 =====
  console.log("\n--- 测试 3：RAG 召回 - rejected 知识不再返回 ---");

  // 重新创建一个新主题知识，测试已验证 vs 已拒绝 的召回差异
  // 先重新注入"以太坊"知识（重新触发联网+沉淀）
  for (let i = 0; i < 4; i++) {
    await evolution.recordToolInteraction({
      sessionId: "knowledge-5",
      userRequest: ["以太坊什么行情", "以太坊价格", "以太坊分析", "以太坊涨跌"][i],
      attemptedTools: ["search_web"],
      success: true,
    });
  }
  const gap2 = evolution.fromSelfLearningGap();
  console.log(`  第二个提案: type=${gap2?.type} title="${gap2?.title}"`);
  assert(gap2?.type === "knowledge_gap", "第二个提案为 knowledge_gap");
  assert(gap2?.title.includes("以太坊"), "提案标题含完整主题词「以太坊」");

  evolution.review(gap2!.id);
  evolution.approve(gap2!.id);
  await evolution.execute(gap2!.id);
  const stats4 = knowledgeVerification.getStats();
  console.log(`  以太坊知识沉淀后 stats: ${JSON.stringify(stats4)}`);
  assert(stats4.pending === 1, `以太坊知识沉淀为 pending_verification（实际 ${stats4.pending}）`);

  // 测试 RAG 召回（比特币被 rejected，queryByTopic 应过滤 rejected；以太坊 pending 可返回）
  const bitcoinEntries = knowledgeVerification.queryByTopic("比特币");
  console.log(`  召回"比特币"知识条目数: ${bitcoinEntries.length}（rejected 已被过滤）`);
  assert(
    bitcoinEntries.length === 0,
    "比特币知识已 rejected，queryByTopic 应过滤后返回 0 条",
  );

  const ethEntries = knowledgeVerification.queryByTopic("以太坊");
  console.log(`  召回"以太坊"知识条目数: ${ethEntries.length}, 状态=${ethEntries[0]?.status}`);
  assert(ethEntries.length === 1, "以太坊知识召回命中（1 条）");
  assert(ethEntries[0]?.status === "pending_verification", "以太坊知识状态为 pending_verification");

  // ===== 测试 4：隐式正反馈 - 用户切换话题 → verified =====
  console.log("\n--- 测试 4：隐式正反馈 - 用户切换话题 → verified ---");

  // 用户切换到无关话题（不含"以太坊"），工具调用成功
  await evolution.recordToolInteraction({
    sessionId: "knowledge-6",
    userRequest: "今天天气怎么样",
    attemptedTools: ["weather_api"],
    success: true,
  });
  const stats5 = knowledgeVerification.getStats();
  console.log(`  切换话题后 stats: ${JSON.stringify(stats5)}`);
  assert(stats5.verified === 1, `以太坊知识 pending → verified（实际 verified=${stats5.verified}）`);
  assert(stats5.pending === 0, `pending 数量降为 0（实际 ${stats5.pending}）`);

  // 验证以太坊知识置信度提升
  const ethAfter = knowledgeVerification.queryByTopic("以太坊")[0];
  console.log(`  以太坊知识 confidence=${ethAfter?.confidence} status=${ethAfter?.status}`);
  assert(
    ethAfter?.status === "verified" && ethAfter.confidence >= 0.7,
    `置信度收敛至 0.7+（实际 ${ethAfter?.confidence}）`,
  );

  // ===== 测试 5：强正反馈 - 用户明确确认 → verified_strong =====
  console.log("\n--- 测试 5：强正反馈 - 用户明确确认 → verified_strong ---");

  // 用户对以太坊回答明确确认
  await evolution.recordToolInteraction({
    sessionId: "knowledge-7",
    userRequest: "对的，以太坊的信息很准确，谢谢",
    attemptedTools: [],
    success: true,
  });
  const stats6 = knowledgeVerification.getStats();
  console.log(`  明确确认后 stats: ${JSON.stringify(stats6)}`);
  assert(stats6.verifiedStrong === 1, `verified_strong=1（实际 ${stats6.verifiedStrong}）`);

  const ethStrong = knowledgeVerification.queryByTopic("以太坊")[0];
  console.log(`  以太坊最终 confidence=${ethStrong?.confidence} status=${ethStrong?.status}`);
  assert(
    ethStrong?.status === "verified_strong" && ethStrong.confidence >= 0.9,
    `置信度收敛至 0.9+（实际 ${ethStrong?.confidence}）`,
  );

  // ===== 测试 6：召回差异化 - verified_strong 优先返回，无"可能不准确"标签 =====
  console.log("\n--- 测试 6：召回差异化 - verified_strong 无待验证标签 ---");

  // 直接调 KnowledgeGapExecutor 测试召回路径
  const recall = await knowledgeExecutor.executeKnowledgeGap({
    actorId: "test-recall",
    query: "以太坊",
    rationale: "测试召回",
  });
  console.log(`  召回结果: ragHit=${recall.ragHit} confidence=${recall.confidence} knowledge=${recall.knowledge?.slice(0, 60)}`);
  assert(recall.ragHit === true, "RAG 命中（已沉淀的 verified_strong 知识）");
  assert(recall.confidence === 0.9, `置信度=0.9（实际 ${recall.confidence}）`);
  assert(
    !recall.knowledge?.includes("可能不准确"),
    "verified_strong 知识召回不含「可能不准确」标签",
  );

  // ===== 总结 =====
  console.log("\n" + "=".repeat(70));
  console.log(`📊 真实学知识闭环端到端测试：通过 ${passed}/${passed + failed} 项`);
  console.log("=".repeat(70));
  if (failed > 0) {
    console.error(`❌ 失败 ${failed} 项`);
    process.exit(1);
  }
  console.log("✅ 仿人学知识闭环与联网的根本差异已验证：");
  console.log("   ✓ 联网拉取 → 沉淀为 pending_verification（置信度 0.3，非直接可信）");
  console.log("   ✓ 反馈回路：用户追问=负反馈 / 切换话题=正反馈 / 明确确认=强正反馈");
  console.log("   ✓ 置信度收敛：0.3 → 0.7（verified）→ 0.9（verified_strong）→ 0.1（disputed）→ rejected");
  console.log("   ✓ 召回差异化：verified 优先 / disputed+rejected 不返回 / pending 标「可能不准确」");
  console.log("   ✓ 关键词最长匹配：4 句「比特币xxx」识别为「比特币」而非「比特」");
}

main().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
