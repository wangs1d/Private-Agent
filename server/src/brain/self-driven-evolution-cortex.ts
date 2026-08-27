/**
 * 自我驱动进化提案器（Phase 5.2 — 重构版：规则触发 + LLM 深度评估）
 *
 * 设计原则：
 * - 规则前置筛选（阈值闸门）→ LLM 深度评估（分析 changelog / 兼容性 / 测试策略）
 * - 三个触发条件（任一命中规则阈值后，调 LLM 做深度评估）：
 *   1. ExternalTechScanner 发现 high benefit + low/medium risk 的升级
 *   2. AgentSelfLearningService 显示某能力失败率 > 30% 持续 3 天
 *   3. BenchmarkSelfAssessment 检测到性能回归 > 10%
 * - LLM 评估输出：shouldProceed / breakingChanges / upgradeStrategy / testPlan
 * - 只有 LLM 评估 shouldProceed=true 才产出 EvolutionProposal
 * - 提案的 description 包含 LLM 产出的升级策略 + 测试计划
 *
 * 降级开关：BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED=0 时所有 propose 方法返回空数组。
 * LLM 降级：未注册 LLM 时退化为纯规则模式（向后兼容）。
 */

import type { EvolutionProposal } from "./types.js";
import type { TechScanResult } from "../services/external-tech-scanner.js";

/** 是否启用自我驱动进化 */
export function isSelfDrivenEvolutionEnabled(): boolean {
  const raw = process.env.BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

// ---- LLM 接口 ---------------------------------------------------------

/**
 * 进化决策 LLM 外观。
 * 复用 CodeRepairCortex 的 LLM 调用模式（一次性非流式）。
 */
export interface EvolutionDecisionLlm {
  /**
   * 一次性 LLM 调用（非流式）。返回完整文本。
   */
  complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

/** LLM 深度评估结果 */
export interface EvolutionLlmAssessment {
  /** LLM 判定是否值得推进升级 */
  shouldProceed: boolean;
  /** 风险等级（LLM 重新评估，可能与规则层不同） */
  riskLevel: "high" | "medium" | "low";
  /** 潜在 breaking changes 列表 */
  breakingChanges: string[];
  /** 升级策略（如"先在沙箱安装新版本，跑 tsc + 全量 test，对比 benchmark"） */
  upgradeStrategy: string;
  /** 测试计划：需要运行的测试文件或 benchmark 脚本列表 */
  testPlan: string[];
  /** LLM 评估理由 */
  rationale: string;
}

// ---- 数据类型 ---------------------------------------------------------

/** 能力失败率统计（来自 AgentSelfLearningService） */
export interface CapabilityFailureStats {
  /** 能力标识 */
  capabilityId: string;
  /** 能力名称（人类可读） */
  capabilityName: string;
  /** 最近失败率（0-1） */
  failureRate: number;
  /** 持续天数（连续 N 天失败率超阈值） */
  consecutiveDaysAboveThreshold: number;
}

/** Benchmark 回归报告（来自 BenchmarkSelfAssessment） */
export interface BenchmarkRegressionReport {
  /** benchmark 名称 */
  benchmarkName: string;
  /** 当前值 */
  currentValue: number;
  /** 基线值 */
  baselineValue: number;
  /** 回归百分比（正数表示性能下降） */
  regressionPercent: number;
  /** 基线时间戳 */
  baselineAt: string;
}

// ---- LLM 评估辅助 -----------------------------------------------------

/** 从 LLM 输出文本中提取 JSON（容错处理 ```json 包裹 + 前后噪声） */
function extractJsonFromLlm(text: string): unknown | null {
  let t = text.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    t = fenceMatch[1].trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * 调用 LLM 做深度评估。
 *
 * LLM 收到：领域、当前版本、目标版本、扫描评估、失败统计 / benchmark 回归数据。
 * LLM 输出：shouldProceed + riskLevel + breakingChanges + upgradeStrategy + testPlan + rationale。
 *
 * LLM 未注册时返回 shouldProceed=true（退化为纯规则模式，向后兼容）。
 */
async function evaluateWithLlm(
  llm: EvolutionDecisionLlm | null,
  params: {
    scenario: "tech_scan" | "failure_rate" | "benchmark";
    domain: string;
    currentVersion?: string;
    latestVersion?: string;
    scanAssessment?: TechScanResult["assessment"];
    failureStats?: CapabilityFailureStats;
    regression?: BenchmarkRegressionReport;
  },
): Promise<EvolutionLlmAssessment | null> {
  if (!llm) return null;

  const systemPrompt = `你是技术升级评估专家。基于规则层已筛选出的升级候选，做深度评估。

严格输出 JSON：
{
  "shouldProceed": true|false,
  "riskLevel": "high"|"medium"|"low",
  "breakingChanges": ["潜在破坏性变更1", "潜在破坏性变更2"],
  "upgradeStrategy": "升级策略描述（如：先在沙箱安装新版本，运行 tsc --noEmit + 全量测试 + benchmark 对比，全部通过才应用）",
  "testPlan": ["需要运行的测试文件或脚本路径"],
  "rationale": "评估理由（2-3 句话）"
}

评估要点：
1. 分析版本号变化幅度（major/minor/patch），major 版本升级风险高
2. 结合领域知识判断可能的 API 破坏性变更
3. 升级策略必须包含"沙箱测试先行"原则
4. testPlan 应列出具体的测试脚本路径（如 scripts/test-self-evolution-e2e.ts）
5. 只有在收益明确大于风险时才 shouldProceed=true

不要输出 JSON 之外的任何内容。`;

  let scenarioDesc = "";
  if (params.scenario === "tech_scan") {
    scenarioDesc = `技术扫描发现新版本：
  领域：${params.domain}
  当前版本：${params.currentVersion ?? "(未安装)"}
  最新版本：${params.latestVersion}
  扫描评估：benefit=${params.scanAssessment?.upgradeBenefit}, risk=${params.scanAssessment?.riskLevel}
  建议操作：${params.scanAssessment?.suggestedAction ?? "(无)"}`;
  } else if (params.scenario === "failure_rate") {
    scenarioDesc = `能力失败率超阈值：
  能力：${params.failureStats?.capabilityName} (${params.failureStats?.capabilityId})
  失败率：${((params.failureStats?.failureRate ?? 0) * 100).toFixed(0)}%
  持续天数：${params.failureStats?.consecutiveDaysAboveThreshold}`;
  } else {
    scenarioDesc = `Benchmark 检测到性能回归：
  名称：${params.regression?.benchmarkName}
  当前值：${params.regression?.currentValue}
  基线值：${params.regression?.baselineValue}
  回归幅度：${params.regression?.regressionPercent.toFixed(1)}%`;
  }

  const userPrompt = `${scenarioDesc}

请做深度评估，判断是否值得推进升级，并给出升级策略和测试计划。`;

  try {
    const raw = await Promise.race([
      llm.complete(systemPrompt, userPrompt, { maxTokens: 1500, temperature: 0.2 }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("LLM 评估超时（60s）")), 60_000),
      ),
    ]);

    const parsed = extractJsonFromLlm(raw) as Partial<EvolutionLlmAssessment> | null;
    if (!parsed) return null;

    return {
      shouldProceed: typeof parsed.shouldProceed === "boolean" ? parsed.shouldProceed : true,
      riskLevel: (["high", "medium", "low"].includes(parsed.riskLevel as string)
        ? parsed.riskLevel : "medium") as "high" | "medium" | "low",
      breakingChanges: Array.isArray(parsed.breakingChanges)
        ? parsed.breakingChanges.filter((s) => typeof s === "string").slice(0, 10)
        : [],
      upgradeStrategy: typeof parsed.upgradeStrategy === "string"
        ? parsed.upgradeStrategy.slice(0, 500) : "",
      testPlan: Array.isArray(parsed.testPlan)
        ? parsed.testPlan.filter((s) => typeof s === "string").slice(0, 10)
        : [],
      rationale: typeof parsed.rationale === "string"
        ? parsed.rationale.slice(0, 300) : "",
    };
  } catch (err) {
    console.log("[SelfDrivenEvolution] LLM 评估失败，退化为纯规则模式:", err);
    return null;
  }
}

// ---- 提案器主体 -------------------------------------------------------

/**
 * 自我驱动进化提案器
 *
 * 两层架构：规则阈值筛选 → LLM 深度评估。
 * - 规则层：快速过滤低价值信号（阈值闸门）
 * - LLM 层：对规则筛选通过的候选做深度评估，输出 shouldProceed + 测试策略
 *
 * 去重：同一 target 24h 内不重复产出提案。
 * LLM 降级：未注册 LLM 时退化为纯规则模式（shouldProceed 默认 true）。
 */
export class SelfDrivenEvolutionProposer {
  /** target → 上次提案时间戳（ms），24h 去重 */
  private readonly proposedAt = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

  /** LLM 评估器（可选，未注册时退化为纯规则模式） */
  private llm: EvolutionDecisionLlm | null = null;

  /** LLM 评估结果缓存（proposalId → assessment），供下游 sandbox runner 使用 */
  private readonly assessments = new Map<string, EvolutionLlmAssessment>();

  /** 注册 LLM 评估器 */
  registerLlm(llm: EvolutionDecisionLlm): void {
    this.llm = llm;
    console.log("[SelfDrivenEvolution] 已注册 LLM 评估器");
  }

  /** 获取某个提案的 LLM 评估结果（供 sandbox runner 使用） */
  getAssessment(proposalId: string): EvolutionLlmAssessment | undefined {
    return this.assessments.get(proposalId);
  }

  /**
   * 从技术扫描结果产出 self_upgrade 提案
   *
   * 流程：规则筛选（benefit=high + risk≠high）→ LLM 深度评估 → shouldProceed 才产出
   */
  async proposeFromTechScan(results: TechScanResult[]): Promise<EvolutionProposal[]> {
    if (!isSelfDrivenEvolutionEnabled()) return [];

    const proposals: EvolutionProposal[] = [];
    const now = new Date().toISOString();

    for (const result of results) {
      if (!result.hasUpdate || !result.assessment) continue;

      const { upgradeBenefit, riskLevel, suggestedAction, rationale } = result.assessment;
      // 规则层：高收益 + 低/中风险才进入 LLM 评估
      if (upgradeBenefit !== "high") continue;
      if (riskLevel === "high") continue;

      const target = `${result.watch.domain}:${result.latestVersion}`;
      if (this.isRecentlyProposed(target)) continue;

      // self_upgrade 是纯后台自动能力，不依赖 LLM 评估：规则层（benefit=high + risk≠high）
      // 已筛出高收益低风险升级，直接交给沙箱测试执行器（ok → loaded / 失败 → 封顶重试后 rejected）。
      const proposalId = `self-upgrade-tech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const proposal: EvolutionProposal = {
        id: proposalId,
        type: "self_upgrade",
        title: `升级 ${result.watch.domain} 到 ${result.latestVersion}`,
        description: suggestedAction,
        rationale: `ExternalTechScanner 发现新版本。理由：${rationale}`,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      proposals.push(proposal);
      this.proposedAt.set(target, Date.now());
    }

    return proposals;
  }

  /**
   * 从能力失败率产出 self_upgrade 提案
   *
   * 流程：规则筛选（failureRate > 30% + 持续 3 天）→ LLM 评估优化策略 → shouldProceed 才产出
   */
  async proposeFromFailureRate(stats: CapabilityFailureStats[]): Promise<EvolutionProposal[]> {
    if (!isSelfDrivenEvolutionEnabled()) return [];

    const proposals: EvolutionProposal[] = [];
    const now = new Date().toISOString();

    for (const stat of stats) {
      // 规则层：失败率 > 30% 且持续 3 天以上
      if (stat.failureRate <= 0.3) continue;
      if (stat.consecutiveDaysAboveThreshold < 3) continue;

      const target = `failure:${stat.capabilityId}`;
      if (this.isRecentlyProposed(target)) continue;

      // 纯规则产出（不调 LLM）：失败率持续超阈值已达规则闸门，直接交给自我修复执行器
      const proposalId = `self-upgrade-failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const proposal: EvolutionProposal = {
        id: proposalId,
        type: "self_upgrade",
        title: `优化能力「${stat.capabilityName}」（失败率 ${(stat.failureRate * 100).toFixed(0)}% 持续 ${stat.consecutiveDaysAboveThreshold} 天）`,
        description: `能力失败率持续超阈值，需优化工具实现或补充知识`,
        rationale: `AgentSelfLearningService 显示 ${stat.capabilityId} 失败率 ${stat.failureRate.toFixed(2)} 持续 ${stat.consecutiveDaysAboveThreshold} 天`,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      proposals.push(proposal);
      this.proposedAt.set(target, Date.now());
    }

    return proposals;
  }

  /**
   * 从 benchmark 回归产出 self_upgrade 提案
   *
   * 流程：规则筛选（regressionPercent > 10%）→ LLM 评估回归原因 → shouldProceed 才产出
   */
  async proposeFromBenchmark(regressions: BenchmarkRegressionReport[]): Promise<EvolutionProposal[]> {
    if (!isSelfDrivenEvolutionEnabled()) return [];

    const proposals: EvolutionProposal[] = [];
    const now = new Date().toISOString();

    for (const regression of regressions) {
      // 规则层：回归 > 10% 才进入 LLM 评估
      if (regression.regressionPercent <= 10) continue;

      const target = `benchmark:${regression.benchmarkName}`;
      if (this.isRecentlyProposed(target)) continue;

      // 纯规则产出（不调 LLM）：回归幅度已达规则闸门，直接交给自我修复执行器
      const proposalId = `self-upgrade-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const proposal: EvolutionProposal = {
        id: proposalId,
        type: "self_upgrade",
        title: `修复性能回归：${regression.benchmarkName}（回归 ${regression.regressionPercent.toFixed(1)}%）`,
        description: `Benchmark 检测到性能回归，当前 ${regression.currentValue} vs 基线 ${regression.baselineValue}`,
        rationale: `BenchmarkSelfAssessment 检测到 ${regression.benchmarkName} 回归 ${regression.regressionPercent.toFixed(1)}%`,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      proposals.push(proposal);
      this.proposedAt.set(target, Date.now());
    }

    return proposals;
  }

  /** 检查 target 是否在 24h 内已提案（去重） */
  private isRecentlyProposed(target: string): boolean {
    const last = this.proposedAt.get(target);
    if (!last) return false;
    if (Date.now() - last > SelfDrivenEvolutionProposer.DEDUP_WINDOW_MS) {
      this.proposedAt.delete(target);
      return false;
    }
    return true;
  }

  /** 清空去重缓存（测试用） */
  clearDedup(): void {
    this.proposedAt.clear();
    this.assessments.clear();
  }
}
