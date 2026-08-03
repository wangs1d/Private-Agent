// 自我进化能力测试脚本
// 通过模拟注入失败轨迹到 AgentSelfLearningService，
// 验证 EvolutionCortex.proposeEvolution 是否能基于规则产出真实进化提案
//
// 测试两类进化场景：
//   1. 工具反复失败 → 应产出 optimize_existing 提案
//   2. 用户请求反复出现但无工具匹配 → 应产出 new_capability 提案
//
// 运行：npx tsx scripts/test-self-evolution.ts

import {
  EvolutionCortex,
} from "../src/brain/index.js";
import type { LearningRecord } from "../src/services/agent-self-learning-service.js";

// ===== Mock SelfLearningService：可注入测试失败轨迹 =====
class MockSelfLearningService {
  public records: LearningRecord[] = [];

  getRecentRecords(): LearningRecord[] {
    return this.records;
  }

  /** 注入 N 条「某工具反复失败」轨迹 */
  injectToolFailures(toolName: string, count: number, userRequest: string): void {
    for (let i = 0; i < count; i++) {
      this.records.push({
        timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        sessionId: `test-session-${i}`,
        userRequest,
        attemptedTools: [toolName],
        success: false,
        errorMessage: `${toolName} 调用失败：参数校验不通过 (${i + 1}/${count})`,
        responseTime: 1200 + i * 100,
      });
    }
  }

  /** 注入 N 条「无工具匹配 + 关键词反复出现」轨迹 */
  injectNoToolFailures(keyword: string, count: number): void {
    const templates = [
      `帮我${keyword}一下`,
      `能不能${keyword}`,
      `${keyword}有什么建议`,
      `我想了解${keyword}相关内容`,
      `${keyword}怎么办`,
    ];
    for (let i = 0; i < count; i++) {
      this.records.push({
        timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        sessionId: `test-session-${i}`,
        userRequest: templates[i % templates.length],
        attemptedTools: [],  // 空工具列表
        success: false,
        errorMessage: "未找到匹配的工具",
        responseTime: 800,
      });
    }
  }

  /** 注入成功轨迹（用于稀释失败比例） */
  injectSuccess(count: number): void {
    for (let i = 0; i < count; i++) {
      this.records.push({
        timestamp: new Date(Date.now() - i * 60_000).toISOString(),
        sessionId: `success-session-${i}`,
        userRequest: "查询天气",
        attemptedTools: ["weather.query"],
        success: true,
        responseTime: 500,
      });
    }
  }

  reset(): void {
    this.records = [];
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 自我进化能力测试：基于失败轨迹的进化提案生成");
  console.log("=".repeat(70));

  const evolution = new EvolutionCortex();
  const mockSelfLearning = new MockSelfLearningService();
  evolution.registerSelfLearning(mockSelfLearning as unknown as Parameters<typeof evolution.registerSelfLearning>[0]);

  // ===== 测试 1：工具反复失败 → optimize_existing 提案 =====
  console.log("\n--- 测试 1：工具反复失败 → optimize_existing 提案 ---");
  mockSelfLearning.reset();
  mockSelfLearning.injectSuccess(5);
  mockSelfLearning.injectToolFailures("calendar.create_task", 4, "帮我创建明天 10 点的会议");

  const result1 = evolution.proposeEvolution("user-1");
  console.log(`  注入数据：5 条成功 + 4 条失败（calendar.create_task 反复失败）`);
  console.log(`  proposeEvolution 结果：`);
  console.log(`    proposals=${result1.proposals}`);
  console.log(`    reason=${result1.reason}`);

  // 验证：应产出 optimize_existing 提案
  const pendingProposals1 = evolution.listPending?.() ?? [];
  const optimizeProposal = pendingProposals1.find((p) => p.type === "optimize_existing");
  if (optimizeProposal) {
    console.log(`  ✅ 已生成 optimize_existing 提案：`);
    console.log(`     标题：${optimizeProposal.title}`);
    console.log(`     描述：${optimizeProposal.description}`);
    console.log(`     依据：${optimizeProposal.rationale}`);
  } else {
    console.log(`  ❌ 未生成 optimize_existing 提案`);
  }

  // ===== 测试 2：无工具匹配 + 关键词反复 → new_capability 提案 =====
  console.log("\n--- 测试 2：无工具匹配 + 关键词反复 → new_capability 提案 ---");
  // 重新创建 evolution 实例避免测试 1 的 pending 提案干扰
  const evolution2 = new EvolutionCortex();
  const mockSelfLearning2 = new MockSelfLearningService();
  evolution2.registerSelfLearning(mockSelfLearning2 as unknown as Parameters<typeof evolution2.registerSelfLearning>[0]);

  mockSelfLearning2.injectSuccess(3);
  mockSelfLearning2.injectNoToolFailures("区块链分析", 4);

  const result2 = evolution2.proposeEvolution("user-2");
  console.log(`  注入数据：3 条成功 + 4 条失败（"区块链分析"关键词反复出现，无工具匹配）`);
  console.log(`  proposeEvolution 结果：`);
  console.log(`    proposals=${result2.proposals}`);
  console.log(`    reason=${result2.reason}`);

  const pendingProposals2 = evolution2.listPending?.() ?? [];
  const newCapProposal = pendingProposals2.find((p) => p.type === "new_capability");
  if (newCapProposal) {
    console.log(`  ✅ 已生成 new_capability 提案：`);
    console.log(`     标题：${newCapProposal.title}`);
    console.log(`     描述：${newCapProposal.description}`);
    console.log(`     依据：${newCapProposal.rationale}`);
  } else {
    console.log(`  ❌ 未生成 new_capability 提案`);
  }

  // ===== 测试 3：成功为主，无失败 → 无提案 =====
  console.log("\n--- 测试 3：成功为主，无失败 → 无提案 ---");
  const evolution3 = new EvolutionCortex();
  const mockSelfLearning3 = new MockSelfLearningService();
  evolution3.registerSelfLearning(mockSelfLearning3 as unknown as Parameters<typeof evolution3.registerSelfLearning>[0]);
  mockSelfLearning3.injectSuccess(10);

  const result3 = evolution3.proposeEvolution("user-3");
  console.log(`  注入数据：10 条成功，0 条失败`);
  console.log(`  proposeEvolution 结果：proposals=${result3.proposals} reason=${result3.reason}`);

  if (result3.proposals === 0) {
    console.log(`  ✅ 正确未生成提案（无失败轨迹）`);
  } else {
    console.log(`  ❌ 不应生成提案，但实际 proposals=${result3.proposals}`);
  }

  // ===== 测试 4：阈值边界（仅 2 次失败，未达阈值 3） → 无提案 =====
  console.log("\n--- 测试 4：阈值边界（仅 2 次失败，未达阈值 3） → 无提案 ---");
  const evolution4 = new EvolutionCortex();
  const mockSelfLearning4 = new MockSelfLearningService();
  evolution4.registerSelfLearning(mockSelfLearning4 as unknown as Parameters<typeof evolution4.registerSelfLearning>[0]);
  mockSelfLearning4.injectToolFailures("some_tool", 2, "测试请求");

  const result4 = evolution4.proposeEvolution("user-4");
  console.log(`  注入数据：2 条失败（未达阈值 3）`);
  console.log(`  proposeEvolution 结果：proposals=${result4.proposals} reason=${result4.reason}`);

  if (result4.proposals === 0) {
    console.log(`  ✅ 正确未生成提案（未达阈值）`);
  } else {
    console.log(`  ❌ 阈值边界失效：2 次失败不应触发提案`);
  }

  // ===== 测试 5：DMN 调用 proposeEvolution 的完整流程（模拟 DMN 触发）=====
  console.log("\n--- 测试 5：模拟 DMN 空闲时触发自我进化 ---");
  console.log("  场景：用户离开 5 分钟，DMN 启动，发现 selfLearning 有失败轨迹 → 产出进化提案");

  const evolution5 = new EvolutionCortex();
  const mockSelfLearning5 = new MockSelfLearningService();
  evolution5.registerSelfLearning(mockSelfLearning5 as unknown as Parameters<typeof evolution5.registerSelfLearning>[0]);

  // 模拟用户日间活动累积的失败记录
  mockSelfLearning5.injectSuccess(8);
  mockSelfLearning5.injectToolFailures("weather.query", 5, "查北京天气");
  mockSelfLearning5.injectNoToolFailures("比特币行情", 3);

  console.log(`  注入数据：8 条成功 + 5 条 weather.query 失败 + 3 条"比特币行情"无工具匹配`);

  // 模拟 DMN 第一次触发
  const dmnResult1 = evolution5.proposeEvolution("user-real");
  console.log(`  DMN 第 1 次触发：proposals=${dmnResult1.proposals} reason=${dmnResult1.reason}`);

  // 模拟 DMN 第二次触发（提案已存在，应统计 pending）
  const dmnResult2 = evolution5.proposeEvolution("user-real");
  console.log(`  DMN 第 2 次触发：proposals=${dmnResult2.proposals} reason=${dmnResult2.reason}`);

  // ===== 汇总 =====
  console.log("\n" + "=".repeat(70));
  console.log("📊 自我进化能力测试汇总");
  console.log("=".repeat(70));

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    {
      name: "工具反复失败 → 生成 optimize_existing 提案",
      pass: !!optimizeProposal,
      detail: optimizeProposal ? `标题="${optimizeProposal.title}"` : "未生成",
    },
    {
      name: "无工具匹配 + 关键词反复 → 生成 new_capability 提案",
      pass: !!newCapProposal,
      detail: newCapProposal ? `标题="${newCapProposal.title}"` : "未生成",
    },
    {
      name: "无失败轨迹 → 不生成提案",
      pass: result3.proposals === 0,
      detail: `proposals=${result3.proposals}`,
    },
    {
      name: "未达阈值（2 次失败） → 不生成提案",
      pass: result4.proposals === 0,
      detail: `proposals=${result4.proposals}`,
    },
    {
      name: "DMN 触发时能识别已存在 pending 提案",
      pass: dmnResult2.proposals >= 1,
      detail: `proposals=${dmnResult2.proposals}`,
    },
  ];

  let passCount = 0;
  for (const c of checks) {
    const mark = c.pass ? "✅" : "❌";
    console.log(`  ${mark} ${c.name} (${c.detail})`);
    if (c.pass) passCount++;
  }
  console.log();
  console.log(`通过 ${passCount}/${checks.length} 项`);

  if (passCount < checks.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
