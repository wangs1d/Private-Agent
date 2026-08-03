/**
 * Agent 自我驱动进化工具
 *
 * 让 Agent 在对话中能够调用自我进化能力：
 *   1. self_evolution.trigger_tech_scan     - 触发技术扫描 + LLM 评估 + 沙箱测试
 *   2. self_evolution.list_proposals        - 查看进化提案（pending/approved/...）
 *   3. self_evolution.execute_proposal      - 对已 approved 提案执行沙箱测试
 *   4. self_evolution.run_failure_rate_scan - 基于能力失败率生成 self_upgrade 提案
 *   5. self_evolution.check_dependencies    - 检查依赖升级并生成沙箱测试报告
 *
 * 接入路径（fast/complex 模式都能用，因为是工具调用）：
 *   - 用户说"自我进化" / "升级依赖" / "扫描新版本" → task-router 路由到 complex
 *   - Agent 调 self_evolution.trigger_tech_scan 触发完整 pipeline
 *   - 结果以 JSON 返回（LLM 可读） + 关键摘要推送给用户
 *
 * 安全约束：
 *   - 仅白名单内的 npm 包可升级（防任意包安装）
 *   - 沙箱测试必真实执行（tsc + test + 回滚）
 *   - LLM 识别 breaking changes → 阻止自动升级，需用户确认
 */

import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import { SelfDrivenEvolutionProposer, type EvolutionLlmAssessment } from "../brain/self-driven-evolution-cortex.js";
import { EvolutionCortex } from "../brain/evolution-cortex.js";
import { UpgradeSandboxRunner, type SandboxTestReport } from "../services/upgrade-sandbox-runner.js";
import type { ExternalTechScanner } from "../services/external-tech-scanner.js";
import type { BenchmarkSelfAssessment } from "../services/benchmark-self-assessment.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import { getModelOverrideForTask, TaskTier } from "../config/model-routing.js";

export interface SelfEvolutionToolDeps {
  evolutionCortex: EvolutionCortex;
  externalChat: ExternalChatProvider | null;
  techScanner: ExternalTechScanner;
  benchmarkAssessment?: BenchmarkSelfAssessment;
  proposer: SelfDrivenEvolutionProposer;
  sandboxRunner: UpgradeSandboxRunner;
}

/**
 * 注册自我驱动进化工具到 ToolRegistry
 */
export function registerSelfEvolutionTools(
  registry: ToolRegistry,
  deps: SelfEvolutionToolDeps,
): void {
  const { evolutionCortex, externalChat, techScanner, proposer, sandboxRunner } = deps;

  // ========== 1. 触发技术扫描 + LLM 评估 + 沙箱测试 ==========
  registry.register("self_evolution.trigger_tech_scan", async (input, context) => {
    void context;
    const start = Date.now();
    try {
      const forceExecute = input.forceExecute === true;
      console.log("[self_evolution] 触发技术扫描 → LLM 评估 → 沙箱测试");

      // 步骤 1：技术扫描
      const scanResults = await techScanner.scan();
      const hasUpdates = scanResults.filter((r) => r.hasUpdate);

      if (hasUpdates.length === 0) {
        return {
          ok: true,
          message: "无新版本可升级",
          scanResults: scanResults.length,
          newVersions: 0,
        };
      }

      // 步骤 2：LLM 评估（真实调用 LLM，已在 create-app-services 中注册）
      const proposals = await proposer.proposeFromTechScan(hasUpdates);
      if (proposals.length === 0) {
        return {
          ok: true,
          message: "扫描到新版本，但 LLM 评估后无可推进的升级",
          scanResults: hasUpdates.length,
          newVersions: hasUpdates.length,
          proposals: 0,
        };
      }

      // 步骤 3：注入 EvolutionCortex
      const assessments = new Map<string, EvolutionLlmAssessment>();
      for (const p of proposals) {
        const a = proposer.getAssessment(p.id);
        if (a) assessments.set(p.id, a);
      }
      evolutionCortex.ingestProposals(proposals, assessments);

      // 步骤 4：自动推进 pending → reviewing → approved
      const advancedProposals: string[] = [];
      for (const p of proposals) {
        if (evolutionCortex.get(p.id)?.status === "pending") {
          evolutionCortex.review(p.id);
        }
        if (evolutionCortex.get(p.id)?.status === "reviewing") {
          evolutionCortex.approve(p.id);
          advancedProposals.push(p.id);
        }
      }

      // 步骤 5：如果 forceExecute，对 approved 提案执行沙箱测试
      const sandboxReports: Array<{ proposalId: string; title: string; report: SandboxTestReport }> = [];
      if (forceExecute) {
        for (const p of proposals) {
          if (evolutionCortex.get(p.id)?.status !== "approved") continue;
          const executed = await evolutionCortex.execute(p.id);
          const meta = evolutionCortex.getMeta(p.id);
          if (meta?.sandboxReport) {
            sandboxReports.push({
              proposalId: p.id,
              title: p.title,
              report: meta.sandboxReport,
            });
          }
          void executed;
        }
      }

      const totalMs = Date.now() - start;
      return {
        ok: true,
        message: forceExecute
          ? `完成 ${proposals.length} 个升级提案的沙箱测试`
          : `生成 ${proposals.length} 个升级提案（已注入 EvolutionCortex）`,
        scanResults: hasUpdates.length,
        proposals: proposals.length,
        advancedToApproved: advancedProposals.length,
        sandboxTestsRun: sandboxReports.length,
        sandboxReports: sandboxReports.map((s) => ({
          title: s.title,
          ok: s.report.ok,
          tscPassed: s.report.tscPassed,
          testsPassed: s.report.testsPassed,
          rolledBack: s.report.rolledBack,
          totalMs: s.report.totalMs,
          error: s.report.error,
        })),
        durationMs: totalMs,
        note: forceExecute
          ? "已对 approved 提案执行真实沙箱测试（tsc + npm test + 回滚）"
          : "使用 self_evolution.execute_proposal 工具对指定提案执行沙箱测试，或设置 forceExecute=true 自动执行",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `自我进化失败: ${msg}`, durationMs: Date.now() - start };
    }
  });

  // ========== 2. 查看进化提案 ==========
  registry.register("self_evolution.list_proposals", async (input, context) => {
    void context;
    try {
      const filterStatus = input.status as string | undefined;
      const all = evolutionCortex.listAll();
      const filtered = filterStatus ? all.filter((p) => p.status === filterStatus) : all;

      return {
        ok: true,
        total: all.length,
        filtered: filtered.length,
        proposals: filtered.map((p) => {
          const meta = evolutionCortex.getMeta(p.id);
          return {
            id: p.id,
            type: p.type,
            title: p.title,
            status: p.status,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            lastError: meta?.lastError,
            hasLlmAssessment: !!meta?.llmAssessment,
            riskLevel: meta?.llmAssessment?.riskLevel,
            breakingChangesCount: meta?.llmAssessment?.breakingChanges.length ?? 0,
          };
        }),
        summary: {
          pending: all.filter((p) => p.status === "pending").length,
          reviewing: all.filter((p) => p.status === "reviewing").length,
          approved: all.filter((p) => p.status === "approved").length,
          loaded: all.filter((p) => p.status === "loaded").length,
          rejected: all.filter((p) => p.status === "rejected").length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `查看提案失败: ${msg}` };
    }
  });

  // ========== 3. 对指定提案执行沙箱测试 ==========
  registry.register("self_evolution.execute_proposal", async (input, context) => {
    void context;
    try {
      const proposalId = String(input.proposalId ?? "").trim();
      if (!proposalId) {
        return { ok: false, error: "需要提供 proposalId" };
      }

      const proposal = evolutionCortex.get(proposalId);
      if (!proposal) {
        return { ok: false, error: `提案 ${proposalId} 不存在` };
      }

      // 检查状态（必须是 approved 才能执行）
      if (proposal.status !== "approved") {
        return {
          ok: false,
          error: `提案状态为 ${proposal.status}，需要先推进到 approved`,
          currentStatus: proposal.status,
        };
      }

      // 检查是否为 self_upgrade 类型
      if (proposal.type !== "self_upgrade") {
        return {
          ok: false,
          error: `提案类型 ${proposal.type} 不支持沙箱测试（仅支持 self_upgrade）`,
        };
      }

      // 执行（EvolutionCortex 内部已注册 executeUpgrade → sandboxRunner）
      const start = Date.now();
      const executed = await evolutionCortex.execute(proposalId);
      const meta = evolutionCortex.getMeta(proposalId);

      if (!executed) {
        return { ok: false, error: "执行返回空" };
      }

      return {
        ok: true,
        proposalId,
        title: proposal.title,
        finalStatus: executed.status,
        lastError: meta?.lastError,
        sandboxReport: meta?.sandboxReport ?? null,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `执行沙箱测试失败: ${msg}` };
    }
  });

  // ========== 4. 基于失败率生成 self_upgrade 提案 ==========
  registry.register("self_evolution.run_failure_rate_scan", async (input, context) => {
    void context;
    try {
      const stats = (input.stats as Array<{
        capabilityId: string;
        capabilityName: string;
        failureRate: number;
        consecutiveDaysAboveThreshold: number;
      }>) ?? [];

      if (stats.length === 0) {
        return { ok: false, error: "需要提供 stats 数组" };
      }

      const proposals = await proposer.proposeFromFailureRate(
        stats.map((s) => ({
          capabilityId: s.capabilityId,
          capabilityName: s.capabilityName,
          failureRate: s.failureRate,
          consecutiveDaysAboveThreshold: s.consecutiveDaysAboveThreshold,
        })),
      );

      if (proposals.length > 0) {
        const assessments = new Map<string, EvolutionLlmAssessment>();
        for (const p of proposals) {
          const a = proposer.getAssessment(p.id);
          if (a) assessments.set(p.id, a);
        }
        evolutionCortex.ingestProposals(proposals, assessments);
      }

      return {
        ok: true,
        message: `基于失败率扫描生成 ${proposals.length} 个 self_upgrade 提案`,
        proposals: proposals.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
        })),
        injectedToEvolution: proposals.length > 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `失败率扫描失败: ${msg}` };
    }
  });

  // ========== 5. 检查依赖升级 ==========
  registry.register("self_evolution.check_dependencies", async (input, context) => {
    void context;
    try {
      const packageName = String(input.packageName ?? "").trim();
      const targetVersion = String(input.targetVersion ?? "").trim();

      if (!packageName || !targetVersion) {
        return { ok: false, error: "需要提供 packageName 和 targetVersion" };
      }

      // 校验白名单
      const allowed = UpgradeSandboxRunner.getAllowedPackages();
      if (!allowed.has(packageName)) {
        return {
          ok: false,
          error: `npm 包 "${packageName}" 不在白名单中。允许的包: ${Array.from(allowed).join(", ")}`,
        };
      }

      console.log(`[self_evolution] 检查依赖升级: ${packageName}@${targetVersion}`);

      // 真实沙箱测试
      const report = await sandboxRunner.testUpgrade({
        type: "npm_dependency",
        description: `升级 ${packageName} 到 ${targetVersion}`,
        packageName,
        targetVersion,
      });

      return {
        ok: report.ok,
        packageName,
        targetVersion,
        tscPassed: report.tscPassed,
        testsPassed: report.testsPassed,
        rolledBack: report.rolledBack,
        upgradeMs: report.upgradeMs,
        testMs: report.testMs,
        totalMs: report.totalMs,
        error: report.error,
        tscOutput: report.tscOutput.slice(0, 500),
        testFilesRun: report.testFilesRun,
        recommendation: report.ok
          ? `✅ ${packageName}@${targetVersion} 沙箱测试通过，可以安全升级`
          : `❌ ${packageName}@${targetVersion} 沙箱测试失败${report.rolledBack ? "（已回滚）" : ""}：${report.error}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `依赖检查失败: ${msg}` };
    }
  });

  console.log("[self_evolution] 已注册 5 个工具: trigger_tech_scan / list_proposals / execute_proposal / run_failure_rate_scan / check_dependencies");
}
