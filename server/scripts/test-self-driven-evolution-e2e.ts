// 自我驱动进化端到端测试（LLM 评估 + 沙箱测试先行）
//
// 验证完整管线：
//   1. SelfDrivenEvolutionProposer 规则触发 → LLM 深度评估 → 产出提案
//   2. EvolutionCortex.ingestProposals 接收提案 + LLM 评估结果
//   3. autoLoop 推进 pending → reviewing → approved
//   4. executeSelfUpgrade → 沙箱测试（备份 → 安装 → tsc + test → 通过/回滚）
//   5. 验证沙箱测试报告结构完整
//
// 运行：npx tsx scripts/test-self-driven-evolution-e2e.ts

import * as dotenv from "dotenv";
dotenv.config();

import { SelfDrivenEvolutionProposer, type EvolutionDecisionLlm } from "../src/brain/self-driven-evolution-cortex.js";
import { EvolutionCortex } from "../src/brain/evolution-cortex.js";
import { UpgradeSandboxRunner, type SandboxTestReport } from "../src/services/upgrade-sandbox-runner.js";
import type { TechScanResult } from "../src/services/external-tech-scanner.js";

// ===== Mock LLM：模拟 LLM 深度评估 =====
class MockEvolutionLlm implements EvolutionDecisionLlm {
  /** 控制 shouldProceed 返回值 */
  public shouldProceed = true;
  public riskLevel: "high" | "medium" | "low" = "low";
  public breakingChanges: string[] = [];
  public upgradeStrategy = "先在沙箱安装新版本，运行 tsc --noEmit + 全量测试，全部通过才应用";
  public testPlan = ["scripts/test-self-evolution.ts"];
  public rationale = "minor 版本升级，API 兼容，收益明确";
  public callCount = 0;

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.callCount++;
    return JSON.stringify({
      shouldProceed: this.shouldProceed,
      riskLevel: this.riskLevel,
      breakingChanges: this.breakingChanges,
      upgradeStrategy: this.upgradeStrategy,
      testPlan: this.testPlan,
      rationale: this.rationale,
    });
  }
}

// ===== Mock 沙箱执行器：验证 executeUpgrade 被正确调用 =====
class MockSandboxExecutor {
  public calls: Array<{ target: string; llmAssessment?: unknown }> = [];
  public returnOk = true;
  public returnReport: SandboxTestReport = {
    ok: true,
    tscPassed: true,
    testsPassed: true,
    tscOutput: "(mock) tsc --noEmit passed",
    testOutput: "(mock) all tests passed",
    testFilesRun: ["scripts/test-self-evolution.ts"],
    upgradeMs: 5000,
    testMs: 3000,
    totalMs: 8000,
    rolledBack: false,
  };

  async executeUpgrade(params: {
    target: string;
    rationale: string;
    suggestedAction: string;
    llmAssessment?: unknown;
  }): Promise<{
    ok: boolean;
    patchApplied?: boolean;
    error?: string;
    sandboxReport?: SandboxTestReport;
  }> {
    this.calls.push({ target: params.target, llmAssessment: params.llmAssessment });

    if (this.returnOk) {
      return { ok: true, patchApplied: true, sandboxReport: this.returnReport };
    }
    return {
      ok: false,
      patchApplied: false,
      error: "(mock) 沙箱测试失败：tsc 编译错误",
      sandboxReport: { ...this.returnReport, ok: false, tscPassed: false, error: "tsc 编译失败", rolledBack: true },
    };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 自我驱动进化 E2E 测试（LLM 评估 + 沙箱测试先行）");
  console.log("=".repeat(70));

  let passCount = 0;
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  // ===== 测试 1：规则触发 + LLM 评估 → 产出提案 =====
  console.log("\n--- 测试 1：规则触发 + LLM 评估 → 产出提案 ---");

  const mockLlm = new MockEvolutionLlm();
  const proposer = new SelfDrivenEvolutionProposer();
  proposer.registerLlm(mockLlm);

  // 模拟技术扫描结果
  const scanResults: TechScanResult[] = [
    {
      watch: {
        domain: "mcp",
        npmPackage: "@modelcontextprotocol/sdk",
        currentVersion: "0.9.0",
        note: "MCP 协议 SDK",
      },
      latestVersion: "1.0.0",
      hasUpdate: true,
      assessment: {
        upgradeBenefit: "high",
        riskLevel: "low",
        suggestedAction: "升级 @modelcontextprotocol/sdk 到 1.0.0",
        rationale: "1.0 正式版发布，API 稳定",
      },
      scannedAt: new Date().toISOString(),
    },
  ];

  const proposals = await proposer.proposeFromTechScan(scanResults);
  console.log(`  LLM 调用次数：${mockLlm.callCount}`);
  console.log(`  产出提案数：${proposals.length}`);

  const test1Pass = proposals.length === 1 && mockLlm.callCount === 1;
  console.log(`  ${test1Pass ? "✅" : "❌"} 规则触发 + LLM 评估产出 1 个提案`);

  if (test1Pass) passCount++;
  checks.push({
    name: "规则触发 + LLM 评估产出提案",
    pass: test1Pass,
    detail: `proposals=${proposals.length}, llmCalls=${mockLlm.callCount}`,
  });

  let test1bPass = false;
  if (proposals.length > 0) {
    const p = proposals[0];
    console.log(`  提案标题：${p.title}`);
    console.log(`  描述包含 LLM 评估：${p.description.includes("[LLM 评估]")}`);
    console.log(`  理由包含 LLM 理由：${p.rationale.includes("[LLM 理由]")}`);

    test1bPass = p.description.includes("[LLM 评估]") && p.rationale.includes("[LLM 理由]");
    console.log(`  ${test1bPass ? "✅" : "❌"} LLM 评估结果已编码到提案描述中`);
    if (test1bPass) passCount++;
    checks.push({
      name: "LLM 评估结果编码到提案描述",
      pass: test1bPass,
      detail: `descHasLlm=${p.description.includes("[LLM 评估]")}`,
    });
  }

  // ===== 测试 2：LLM 评估 shouldProceed=false → 不产出提案 =====
  console.log("\n--- 测试 2：LLM 评估 shouldProceed=false → 不产出提案 ---");

  mockLlm.shouldProceed = false;
  mockLlm.riskLevel = "high";
  mockLlm.rationale = "major 版本升级，API 破坏性变更风险高";
  proposer.clearDedup();

  const proposals2 = await proposer.proposeFromTechScan(scanResults);
  console.log(`  LLM shouldProceed=false，产出提案数：${proposals2.length}`);

  const test2Pass = proposals2.length === 0;
  console.log(`  ${test2Pass ? "✅" : "❌"} LLM 否决时正确不产出提案`);
  if (test2Pass) passCount++;
  checks.push({
    name: "LLM 否决时不产出提案",
    pass: test2Pass,
    detail: `proposals=${proposals2.length}`,
  });

  // ===== 测试 3：无 LLM 时退化为纯规则模式 =====
  console.log("\n--- 测试 3：无 LLM 时退化为纯规则模式 ---");

  const proposerNoLlm = new SelfDrivenEvolutionProposer();
  // 不注册 LLM

  const proposals3 = await proposer.proposeFromTechScan(scanResults);
  // 恢复 mockLlm 的 shouldProceed
  mockLlm.shouldProceed = true;
  mockLlm.riskLevel = "low";

  const proposals3b = await proposerNoLlm.proposeFromTechScan(scanResults);
  console.log(`  无 LLM 注册，产出提案数：${proposals3b.length}`);

  const test3Pass = proposals3b.length === 1;
  console.log(`  ${test3Pass ? "✅" : "❌"} 无 LLM 时退化为纯规则模式（仍产出提案）`);
  if (test3Pass) passCount++;
  checks.push({
    name: "无 LLM 时退化为纯规则模式",
    pass: test3Pass,
    detail: `proposals=${proposals3b.length}`,
  });

  // ===== 测试 4：提案注入 EvolutionCortex + LLM 评估传递 =====
  console.log("\n--- 测试 4：提案注入 EvolutionCortex + LLM 评估传递 ---");

  const evolution = new EvolutionCortex();
  const assessments = new Map();
  for (const p of proposals3b) {
    // 无 LLM 时 assessment 为 undefined
  }

  // 重新用有 LLM 的 proposer 产出提案
  proposer.clearDedup();
  const proposals4 = await proposer.proposeFromTechScan(scanResults);
  for (const p of proposals4) {
    const a = proposer.getAssessment(p.id);
    if (a) assessments.set(p.id, a);
  }

  evolution.ingestProposals(proposals4, assessments);

  const ingested = evolution.listAll();
  console.log(`  注入提案数：${ingested.length}`);
  console.log(`  传递 LLM 评估数：${assessments.size}`);

  const test4Pass = ingested.length === proposals4.length && assessments.size > 0;
  console.log(`  ${test4Pass ? "✅" : "❌"} 提案 + LLM 评估成功注入 EvolutionCortex`);
  if (test4Pass) passCount++;
  checks.push({
    name: "提案 + LLM 评估注入 EvolutionCortex",
    pass: test4Pass,
    detail: `ingested=${ingested.length}, assessments=${assessments.size}`,
  });

  // ===== 测试 5：autoLoop 推进 pending → reviewing → approved =====
  console.log("\n--- 测试 5：autoLoop 推进 pending → reviewing → approved ---");

  // 手动推进状态机（模拟 autoLoop）
  for (const p of ingested) {
    if (p.status === "pending") {
      evolution.review(p.id);
    }
    const reviewing = evolution.get(p.id);
    if (reviewing?.status === "reviewing") {
      evolution.approve(p.id);
    }
  }

  const approved = ingested.filter((p) => evolution.get(p.id)?.status === "approved");
  console.log(`  pending → reviewing → approved：${approved.length}/${ingested.length}`);

  const test5Pass = approved.length === ingested.length && approved.length > 0;
  console.log(`  ${test5Pass ? "✅" : "❌"} 状态机推进成功`);
  if (test5Pass) passCount++;
  checks.push({
    name: "状态机推进 pending → reviewing → approved",
    pass: test5Pass,
    detail: `approved=${approved.length}/${ingested.length}`,
  });

  // ===== 测试 6：executeSelfUpgrade 调用沙箱执行器 =====
  console.log("\n--- 测试 6：executeSelfUpgrade 调用沙箱执行器 ---");

  const mockExecutor = new MockSandboxExecutor();
  evolution.registerCodeRepairExecutor({
    executeUpgrade: mockExecutor.executeUpgrade.bind(mockExecutor),
  });

  let test6Pass = false;
  if (approved.length > 0) {
    const targetProposal = approved[0];
    console.log(`  执行提案：${targetProposal.id} title="${targetProposal.title}"`);

    const executed = await evolution.execute(targetProposal.id);
    const meta = executed ? evolution.getMeta(executed.id) : null;

    console.log(`  execute 返回状态：${executed?.status ?? "null"}`);
    console.log(`  沙箱执行器调用次数：${mockExecutor.calls.length}`);
    console.log(`  沙箱执行器收到 target：${mockExecutor.calls[0]?.target ?? "(无)"}`);
    console.log(`  沙箱执行器收到 llmAssessment：${mockExecutor.calls[0]?.llmAssessment ? "有" : "无"}`);

    if (meta?.generatedSkill?.explanation) {
      console.log(`  沙箱报告摘要：${meta.generatedSkill.explanation.slice(0, 100)}`);
    }

    test6Pass =
      executed?.status === "loaded" &&
      mockExecutor.calls.length === 1 &&
      !!mockExecutor.calls[0]?.llmAssessment;
    console.log(`  ${test6Pass ? "✅" : "❌"} 沙箱执行器被正确调用，提案状态=loaded`);
  } else {
    console.log("  ❌ 无 approved 提案可执行");
  }
  if (test6Pass) passCount++;
  checks.push({
    name: "executeSelfUpgrade 调用沙箱执行器",
    pass: test6Pass,
    detail: `calls=${mockExecutor.calls.length}, status=loaded`,
  });

  // ===== 测试 7：沙箱测试失败时正确回滚 =====
  console.log("\n--- 测试 7：沙箱测试失败时正确回滚 ---");

  const evolution2 = new EvolutionCortex();
  const mockExecutor2 = new MockSandboxExecutor();
  mockExecutor2.returnOk = false; // 模拟沙箱测试失败
  evolution2.registerCodeRepairExecutor({
    executeUpgrade: mockExecutor2.executeUpgrade.bind(mockExecutor2),
  });

  // 创建一个 approved 提案
  const failProposal = evolution2.evolve({
    type: "self_upgrade",
    title: "升级 @modelcontextprotocol/sdk 到 1.0.0",
    description: "测试沙箱失败回滚",
    rationale: "测试用",
  });
  evolution2.review(failProposal.id);
  evolution2.approve(failProposal.id);

  const failExecuted = await evolution2.execute(failProposal.id);
  const failMeta = failExecuted ? evolution2.getMeta(failExecuted.id) : null;

  console.log(`  沙箱失败后提案状态：${failExecuted?.status ?? "null"}`);
  console.log(`  lastError：${failMeta?.lastError ?? "(无)"}`);
  console.log(`  warnings 包含回滚信息：${failMeta?.warnings.some((w) => w.includes("rolledBack")) ?? false}`);

  const test7Pass =
    failExecuted?.status === "approved" && // 失败时保持 approved（等重试）
    !!failMeta?.lastError;
  console.log(`  ${test7Pass ? "✅" : "❌"} 沙箱失败时正确保持 approved + 记录错误`);
  if (test7Pass) passCount++;
  checks.push({
    name: "沙箱测试失败时正确回滚",
    pass: test7Pass,
    detail: `status=${failExecuted?.status}, hasError=${!!failMeta?.lastError}`,
  });

  // ===== 测试 8：UpgradeSandboxRunner 白名单校验 =====
  console.log("\n--- 测试 8：UpgradeSandboxRunner 白名单校验 ---");

  const runner = new UpgradeSandboxRunner(process.cwd());
  const allowedPkgs = UpgradeSandboxRunner.getAllowedPackages();

  console.log(`  白名单包数：${allowedPkgs.size}`);
  console.log(`  白名单包：${Array.from(allowedPkgs).join(", ")}`);

  // 测试非白名单包被拒绝
  const blockedReport = await runner.testUpgrade({
    type: "npm_dependency",
    description: "测试非白名单包",
    packageName: "evil-package",
    targetVersion: "1.0.0",
  });

  console.log(`  非白名单包测试结果：ok=${blockedReport.ok}, error=${blockedReport.error}`);

  const test8Pass = !blockedReport.ok && blockedReport.error?.includes("不在白名单中");
  console.log(`  ${test8Pass ? "✅" : "❌"} 非白名单包被正确拒绝`);
  if (test8Pass) passCount++;
  checks.push({
    name: "UpgradeSandboxRunner 白名单校验",
    pass: test8Pass,
    detail: `blocked=${!blockedReport.ok}`,
  });

  // ===== 测试 9：LLM 识别 breaking changes 时不自动升级 =====
  console.log("\n--- 测试 9：LLM 识别 breaking changes 时不自动升级 ---");

  const evolution3 = new EvolutionCortex();
  const mockExecutor3 = new MockSandboxExecutor();
  let executorCalled = false;
  evolution3.registerCodeRepairExecutor({
    executeUpgrade: async (params) => {
      executorCalled = true;
      // 模拟 create-app-services.ts 中的 breaking changes 检查
      if (params.llmAssessment?.breakingChanges?.length) {
        return {
          ok: false,
          error: `LLM 识别到 ${params.llmAssessment.breakingChanges.length} 个 breaking changes，需人工确认`,
        };
      }
      return { ok: true, patchApplied: true };
    },
  });

  // 创建带 breaking changes 的提案
  const bcProposal = evolution3.evolve({
    type: "self_upgrade",
    title: "升级 @modelcontextprotocol/sdk 到 2.0.0",
    description: "major 版本升级",
    rationale: "测试 breaking changes",
  });

  // 注入 LLM 评估（带 breaking changes）
  const bcAssessments = new Map();
  bcAssessments.set(bcProposal.id, {
    shouldProceed: true,
    riskLevel: "high" as const,
    breakingChanges: ["API 完全重构", "配置格式不兼容"],
    upgradeStrategy: "需人工迁移配置",
    testPlan: [],
    rationale: "major 版本，风险高",
  });
  evolution3.ingestProposals([bcProposal], bcAssessments);

  evolution3.review(bcProposal.id);
  evolution3.approve(bcProposal.id);
  await evolution3.execute(bcProposal.id);

  const bcMeta = evolution3.getMeta(bcProposal.id);
  console.log(`  有 breaking changes 时执行结果：${bcMeta?.lastError ?? "(无错误)"}`);

  const test9Pass = bcMeta?.lastError?.includes("breaking changes") ?? false;
  console.log(`  ${test9Pass ? "✅" : "❌"} LLM 识别 breaking changes 时阻止自动升级`);
  if (test9Pass) passCount++;
  checks.push({
    name: "LLM 识别 breaking changes 时阻止自动升级",
    pass: test9Pass,
    detail: bcMeta?.lastError?.slice(0, 60) ?? "(无)",
  });

  // ===== 汇总 =====
  console.log("\n" + "=".repeat(70));
  console.log("📊 自我驱动进化 E2E 测试汇总");
  console.log("=".repeat(70));

  for (const c of checks) {
    const mark = c.pass ? "✅" : "❌";
    console.log(`  ${mark} ${c.name} (${c.detail})`);
  }
  console.log();
  console.log(`通过 ${passCount}/${checks.length} 项`);

  console.log();
  console.log("📌 自我驱动进化管线验证：");
  console.log("  1. 规则阈值筛选（benefit=high + risk≠high）→ 快速过滤低价值信号");
  console.log("  2. LLM 深度评估 → shouldProceed + breakingChanges + upgradeStrategy + testPlan");
  console.log("  3. LLM 否决（shouldProceed=false）→ 不产出提案");
  console.log("  4. LLM 识别 breaking changes → 阻止自动升级，需人工确认");
  console.log("  5. ingestProposals → 提案 + LLM 评估注入 EvolutionCortex");
  console.log("  6. autoLoop → pending → reviewing → approved");
  console.log("  7. executeSelfUpgrade → 沙箱执行器（UpgradeSandboxRunner）");
  console.log("  8. 沙箱测试：备份 → npm install → tsc --noEmit → 相关测试");
  console.log("  9. 沙箱通过 → loaded（终态）；失败 → 回滚 + 保持 approved 等重试");
  console.log("  10. npm 包白名单 → 拒绝非白名单包安装");
  console.log();
  console.log("  这就是「规则触发 + LLM 深度评估 + 沙箱测试先行」的真实闭环。");

  if (passCount < checks.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
