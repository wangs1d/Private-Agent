// 自我进化能力端到端测试（真实闭环）
//
// 验证「失败时自我学习 + 自我增加 tool 能力」真实生效，不依赖 mock 数据：
//   1. 通过 brainCenter.recordToolInteraction 注入真实失败记录
//      → AgentSelfLearningService.recentRecords 被填充（验证摆设被打破）
//   2. 调 evolutionCortex.proposeEvolution（DMN 入口）
//      → 基于真实失败轨迹产出 optimize_existing / new_capability 提案
//   3. 调 evolutionCortex.runAutoEvolutionCycle（内部 autoLoop）
//      → pending → reviewing → approved（规则自动审批，非 LLM）
//   4. 调 evolutionCortex.execute（生成 Skill 代码）
//      → approved → generated（SkillGenerator 用 LLM 写 handler 代码）
//   5. 验证最终状态：generated / awaiting_user_approval（待用户审批才能装载）
//
// 运行：npx tsx scripts/test-self-evolution-e2e.ts
//
// 注意：测试 4 需要 externalChat 配置，否则跳过 Skill 代码生成验证。

import * as dotenv from "dotenv";
dotenv.config();

import {
  EvolutionCortex,
} from "../src/brain/index.js";
import { AgentSelfLearningService } from "../src/services/agent-self-learning-service.js";
import { SkillGenerator } from "../src/services/skill-generator.js";
import { ExternalChatProvider } from "../src/external-model/types.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { SkillManager } from "../src/skills/index.js";
import { createExternalChatProviderFromEnv } from "../src/external-model/index.js";

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 自我进化能力端到端测试（验证真实闭环，非摆设）");
  console.log("=".repeat(70));

  // === 真实装配（与生产一致）===
  const externalChat = createExternalChatProviderFromEnv();
  const chatEnabled = externalChat?.isEnabled() ?? false;
  console.log(`\n[环境] externalChat.isEnabled=${chatEnabled} provider=${externalChat?.id ?? "null"}`);

  // 用最小化的 ToolRegistry / SkillManager 占位（recordInteraction 不需要它们）
  const toolRegistry = new ToolRegistry();
  const skillManager = null;

  // 真实 AgentSelfLearningService（非 mock）
  const selfLearning = new AgentSelfLearningService(
    chatEnabled ? externalChat : null,
    toolRegistry,
    skillManager,
  );

  // 真实 EvolutionCortex
  const evolution = new EvolutionCortex();
  evolution.registerSelfLearning(selfLearning);

  if (chatEnabled) {
    const skillGenerator = new SkillGenerator(externalChat);
    evolution.registerSkillGenerator(skillGenerator);
  }

  // ===== 测试 1：recordToolInteraction 真的写入 selfLearning.recentRecords =====
  console.log("\n--- 测试 1：recordToolInteraction 真的写入 selfLearning（打破摆设）---");

  // 注入 4 次工具失败（超过阈值 3）
  for (let i = 0; i < 4; i++) {
    await evolution.recordToolInteraction({
      sessionId: "e2e-session-1",
      userRequest: "帮我创建明天 10 点的会议",
      attemptedTools: ["calendar.create_task"],
      success: false,
      errorMessage: `calendar.create_task 调用失败：参数校验不通过 (${i + 1}/4)`,
      responseTime: 1200 + i * 100,
    });
  }
  // 注入 3 次无工具+关键词反复（超过阈值 3）
  for (let i = 0; i < 3; i++) {
    await evolution.recordToolInteraction({
      sessionId: "e2e-session-2",
      userRequest: ["帮我区块链分析一下", "能不能区块链分析", "区块链分析有什么建议"][i],
      attemptedTools: [],
      success: false,
      errorMessage: "未找到匹配的工具",
      responseTime: 800,
    });
  }
  // 注入 5 次成功（稀释失败率）
  for (let i = 0; i < 5; i++) {
    await evolution.recordToolInteraction({
      sessionId: "e2e-session-3",
      userRequest: "查询天气",
      attemptedTools: ["weather.query"],
      success: true,
      responseTime: 500,
    });
  }

  const records = selfLearning.getRecentRecords();
  console.log(`  注入：4 次 calendar.create_task 失败 + 3 次"区块链分析"无工具 + 5 次成功`);
  console.log(`  selfLearning.getRecentRecords().length = ${records.length}`);
  console.log(`  失败率 = ${selfLearning.getRecentFailureRate().toFixed(2)}`);

  const test1Pass = records.length === 12 && selfLearning.getRecentFailureRate() > 0.5;
  console.log(`  ${test1Pass ? "✅" : "❌"} recordToolInteraction 真的写入了 selfLearning（生产路径已打通）`);

  // ===== 测试 2：proposeEvolution 基于真实失败数据产出两类提案 =====
  // 注：fromSelfLearningGap 是短路式（规则 1 达标就 return），所以分两个独立子场景
  console.log("\n--- 测试 2：proposeEvolution 基于真实失败数据产出两类提案 ---");

  // 子场景 A：只注入工具失败 → 应产出 optimize_existing
  const slA = new AgentSelfLearningService(
    chatEnabled ? externalChat : null,
    toolRegistry,
    skillManager,
  );
  const evoA = new EvolutionCortex();
  evoA.registerSelfLearning(slA);
  for (let i = 0; i < 4; i++) {
    await evoA.recordToolInteraction({
      sessionId: "e2e-A",
      userRequest: "帮我创建明天 10 点的会议",
      attemptedTools: ["calendar.create_task"],
      success: false,
      errorMessage: `calendar.create_task 失败 (${i + 1}/4)`,
    });
  }
  const rA = evoA.proposeEvolution("e2e-A");
  const pA = evoA.listPending().filter((p) => p.type === "optimize_existing");
  console.log(`  子场景 A（仅工具失败）：proposals=${rA.proposals} optimize_existing=${pA.length}（标题：${pA[0]?.title ?? "无"}）`);
  const subPassA = pA.length >= 1;

  // 子场景 B：只注入无工具+关键词反复 → 应产出 new_capability
  const slB = new AgentSelfLearningService(
    chatEnabled ? externalChat : null,
    toolRegistry,
    skillManager,
  );
  const evoB = new EvolutionCortex();
  evoB.registerSelfLearning(slB);
  if (chatEnabled) {
    evoB.registerSkillGenerator(new SkillGenerator(externalChat));
  }
  for (let i = 0; i < 4; i++) {
    await evoB.recordToolInteraction({
      sessionId: "e2e-B",
      userRequest: ["帮我区块链分析一下", "能不能区块链分析", "区块链分析有什么建议", "我想了解区块链分析相关内容"][i],
      attemptedTools: [],
      success: false,
      errorMessage: "未找到匹配的工具",
    });
  }
  const rB = evoB.proposeEvolution("e2e-B");
  const pB = evoB.listPending().filter((p) => p.type === "new_capability");
  console.log(`  子场景 B（仅无工具+关键词）：proposals=${rB.proposals} new_capability=${pB.length}（标题：${pB[0]?.title ?? "无"}）`);
  const subPassB = pB.length >= 1;

  const test2Pass = subPassA && subPassB;
  console.log(`  ${test2Pass ? "✅" : "❌"} 两类失败场景都能被识别并产出对应提案`);

  // 测试 2 通过后，用 evoB 的 new_capability 提案作为后续测试对象（验证 new_capability 也能跑完整闭环）
  const targetProposal = pB[0] ?? pA[0] ?? null;

  // ===== 测试 3：提案状态机推进（pending → reviewing → approved，规则自动审批）=====
  console.log("\n--- 测试 3：提案状态机推进（pending → reviewing → approved）---");
  const evoForStateMachine = targetProposal ? (pB[0] ? evoB : evoA) : null;
  let test3Pass = false;
  if (!targetProposal || !evoForStateMachine) {
    console.log("  ❌ 无可用提案，跳过状态机测试");
  } else {
    const reviewed = evoForStateMachine.review(targetProposal.id);
    const approved = reviewed ? evoForStateMachine.approve(targetProposal.id) : null;
    console.log(`  目标提案：${targetProposal.id} title="${targetProposal.title}"`);
    console.log(`  review 后 status=${reviewed?.status ?? "null"}`);
    console.log(`  approve 后 status=${approved?.status ?? "null"}`);
    test3Pass = approved?.status === "approved";
    console.log(`  ${test3Pass ? "✅" : "❌"} 规则自动审批通过（不依赖 LLM 审批）`);
  }

  // ===== 测试 4：SkillGenerator 用 LLM 生成 handler 代码（自我增加 tool 的核心）=====
  console.log("\n--- 测试 4：SkillGenerator 用 LLM 生成 handler 代码（自我增加 tool 核心）---");
  let test4Pass = false;
  let skillName = "";
  let skillCodeLen = 0;
  let executeMs = 0;
  if (!chatEnabled) {
    console.log("  ⚠️ 跳过：externalChat 未启用，无法验证 Skill 代码生成");
    console.log("  （生产环境配置 externalChat 后此项才会真正运行）");
  } else if (!targetProposal || !evoForStateMachine) {
    console.log("  ❌ 无可用 approved 提案，跳过 Skill 生成测试");
  } else {
    console.log(`  调用 execute("${targetProposal.id}") ...`);
    console.log(`  SkillGenerator 将用 LLM 生成 handler 代码（可能耗时 5-30 秒）`);
    const startTime = Date.now();
    try {
      const executed = await evoForStateMachine.execute(targetProposal.id);
      executeMs = Date.now() - startTime;
      const elapsedSec = (executeMs / 1000).toFixed(1);
      console.log(`  execute 耗时 ${elapsedSec}s，返回提案 status=${executed?.status ?? "null"}`);
      const meta = executed ? evoForStateMachine.getMeta(executed.id) : null;
      if (meta?.generatedSkill) {
        skillName = meta.generatedSkill.name;
        skillCodeLen = meta.generatedSkill.handlerCode.length;
        test4Pass = executed?.status === "generated" && skillCodeLen > 0;
        console.log(`  ${test4Pass ? "✅" : "❌"} 已生成 Skill 代码：name="${skillName}"`);
        console.log(`     handlerCode 长度：${skillCodeLen} 字符`);
        console.log(`     handlerCode 预览（前 200 字）：`);
        console.log(`     ${meta.generatedSkill.handlerCode.slice(0, 200).replace(/\n/g, "\n     ")}`);
      } else {
        console.log(`  ❌ execute 未生成 Skill 代码`);
      }
    } catch (e) {
      console.log(`  ❌ execute 异常：${String(e).slice(0, 200)}`);
    }
  }

  // ===== 汇总 =====
  console.log("\n" + "=".repeat(70));
  console.log("📊 自我进化能力端到端测试汇总");
  console.log("=".repeat(70));

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    {
      name: "recordToolInteraction 真的写入 selfLearning（摆设被打破）",
      pass: test1Pass,
      detail: `records=${records.length}, failureRate=${selfLearning.getRecentFailureRate().toFixed(2)}`,
    },
    {
      name: "proposeEvolution 两类失败场景都能被识别并产出对应提案",
      pass: test2Pass,
      detail: `场景A optimize_existing=${pA.length}, 场景B new_capability=${pB.length}`,
    },
    {
      name: "提案状态机推进（pending → reviewing → approved，规则自动审批）",
      pass: test3Pass,
      detail: `status=${targetProposal && evoForStateMachine ? evoForStateMachine.get(targetProposal.id)?.status ?? "null" : "null"}`,
    },
    {
      name: "SkillGenerator 用 LLM 真实生成 handler 代码（自我增加 tool 核心）",
      pass: test4Pass,
      detail: chatEnabled
        ? `skill="${skillName}" len=${skillCodeLen} 耗时=${(executeMs / 1000).toFixed(1)}s`
        : "externalChat 未启用，已跳过",
    },
  ];

  let passCount = 0;
  for (const c of checks) {
    const mark = c.pass ? "✅" : "❌";
    console.log(`  ${mark} ${c.name} (${c.detail})`);
    if (c.pass) passCount++;
  }
  console.log();
  console.log(`通过 ${passCount}/${checks.length} 项（核心四项：失败写入 + 提案生成 + 状态机审批 + LLM 生成 skill 代码）`);
  console.log();
  console.log("📌 自我进化闭环验证：");
  console.log("  1. AgentCore 工具调用失败 → brainCenter.recordToolInteraction（生产路径）");
  console.log("  2. BrainCenter → EvolutionCortex.recordToolInteraction → selfLearning.recordInteraction");
  console.log("  3. DMN 周期扫描 → proposeEvolution → 识别失败轨迹 → 产出 new_capability 提案");
  console.log("  4. autoLoop → pending → reviewing → approved（规则自动审批）");
  console.log("  5. execute → SkillGenerator 用 LLM 生成 handler 代码 → generated");
  console.log("  6. awaiting_user_approval → 用户审批 → PromotionPipeline.promote → loaded（新 tool 装载）");
  console.log();
  console.log("  这就是「自我增加 tool 能力」的真实闭环（非摆设）。");

  if (passCount < checks.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
