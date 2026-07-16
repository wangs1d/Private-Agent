/**
 * Loop Orchestrator - 默认进展评估器
 *
 * 低频 LLM 辅助评估（成本控制严格）：
 * - 每 K 轮（默认 3）才触发一次评估
 * - 仅在 consecutiveNoProgress >= 2 时才触发（任务卡住时）
 * - 用临时 session 调 provider.streamCompletion，不污染主会话
 * - 输入：goal + plan + completedSteps + 最近 toolHistory 摘要
 * - 输出：progressScore(0..1) + recommendation(continue/replan/escalate)
 *
 * 成本控制（对齐架构文档 §6）：
 * - 正常推进时不评估（consecutiveNoProgress=0 跳过）
 * - 评估用同一个 provider（无独立小模型时），但用临时 session + 无工具
 * - 失败时降级为规则评估（不阻塞主流程）
 *
 * 详见 docs/loop-orchestrator-architecture.md §5 Phase 3
 */

import type { ExternalChatProvider } from "../../external-model/types.js";
import type { ProgressTracker, ProgressAssessment } from "./policies.js";
import type { SharedTaskContext } from "./shared-task-context.js";

export interface DefaultProgressOptions {
  /** 每 K 轮才评估一次，默认 3 */
  assessEveryKRounds?: number;
  /** 仅在 consecutiveNoProgress >= N 时才触发 LLM 评估，默认 2 */
  minNoProgressToTrigger?: number;
  /** LLM 评估超时（ms），默认 4000 */
  llmTimeoutMs?: number;
}

export class DefaultProgressTracker implements ProgressTracker {
  private lastAssessedRound = -1;

  constructor(
    private readonly provider: ExternalChatProvider,
    private readonly opts: DefaultProgressOptions = {},
  ) {
    this.opts = opts;
  }

  async assess(ctx: SharedTaskContext): Promise<ProgressAssessment> {
    const assessEveryK = this.opts.assessEveryKRounds ?? 3;
    const minNoProgress = this.opts.minNoProgressToTrigger ?? 2;

    // 1. 频率控制：K 轮内不重复评估
    if (ctx.budget.roundsUsed - this.lastAssessedRound < assessEveryK) {
      return this.ruleBasedAssess(ctx);
    }

    // 2. 触发条件：仅卡住时才调 LLM
    if (ctx.progress.consecutiveNoProgress < minNoProgress) {
      return this.ruleBasedAssess(ctx);
    }

    this.lastAssessedRound = ctx.budget.roundsUsed;

    // 3. LLM 评估（失败降级为规则）
    try {
      return await this.llmAssess(ctx);
    } catch {
      return this.ruleBasedAssess(ctx);
    }
  }

  /** 规则评估（零 LLM）：基于 consecutiveNoProgress / failures 简单判定 */
  private ruleBasedAssess(ctx: SharedTaskContext): ProgressAssessment {
    const noProgress = ctx.progress.consecutiveNoProgress;
    const failures = ctx.progress.consecutiveFailures;

    if (noProgress >= 3 || failures >= 4) {
      return {
        onTrack: false,
        progressScore: 0.2,
        deviation: `连续 ${noProgress} 轮无进展，${failures} 次连续失败`,
        recommendation: "escalate",
      };
    }
    if (noProgress >= 2) {
      return {
        onTrack: false,
        progressScore: 0.4,
        deviation: `连续 ${noProgress} 轮无新进展`,
        recommendation: "replan",
      };
    }
    return { onTrack: true, progressScore: 0.7, recommendation: "continue" };
  }

  /** LLM 评估：构造评估 prompt，解析 JSON 结果 */
  private async llmAssess(ctx: SharedTaskContext): Promise<ProgressAssessment> {
    const prompt = this.buildAssessPrompt(ctx);
    const evalSessionId = `progress-eval-${ctx.taskId}-${Date.now()}`;

    const raw = await this.provider.streamCompletion(
      evalSessionId,
      { text: prompt },
      () => {}, // 不需要流式
      undefined, // 无工具
      undefined,
    );

    this.provider.clearSession?.(evalSessionId);

    return this.parseAssessResponse(raw);
  }

  private buildAssessPrompt(ctx: SharedTaskContext): string {
    const completed = ctx.progress.completedSteps.length;
    const total = ctx.plan?.steps.length ?? 0;
    const recentTools = ctx.toolHistory
      .slice(-5)
      .map((t) => `${t.ok ? "✓" : "✗"} ${t.name}`)
      .join("\n  ");

    return `你是任务进展评估器。请评估当前 agent 是否在正确轨道上。

【用户目标】${ctx.goal}

【计划】${ctx.plan ? `${completed}/${total} 步完成` : "无显式计划"}

【已完成步骤】${ctx.progress.completedSteps.join("、") || "无"}

【最近工具调用】
  ${recentTools || "无"}

【状态】连续 ${ctx.progress.consecutiveNoProgress} 轮无新进展，连续 ${ctx.progress.consecutiveFailures} 次失败

请只输出一个 JSON 对象（不要 markdown 代码块）：
{"onTrack": true/false, "progressScore": 0.0-1.0, "deviation": "若偏离则说明原因", "recommendation": "continue"|"replan"|"escalate"}`;
  }

  private parseAssessResponse(raw: string): ProgressAssessment {
    // 提取 JSON（容错：LLM 可能包裹 markdown）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 无 JSON → 抛错让 assess 降级为规则
      throw new Error("no JSON in assess response");
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const rec = parsed.recommendation;
    const validRec =
      rec === "continue" || rec === "replan" || rec === "escalate"
        ? rec
        : "continue";
    return {
      onTrack: Boolean(parsed.onTrack),
      progressScore: Math.min(1, Math.max(0, Number(parsed.progressScore) || 0.5)),
      deviation: typeof parsed.deviation === "string" ? parsed.deviation : undefined,
      recommendation: validRec,
    };
  }
}
