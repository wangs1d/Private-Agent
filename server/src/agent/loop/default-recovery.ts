/**
 * Loop Orchestrator - 默认恢复策略
 *
 * 确定性 fallback 链（零 LLM 调用）：
 *   attempts < 2 → retry（同工具重试，参数可能由 LLM 调整）
 *   有显式 alternatives → switch_tool（确定性换工具）
 *   同类有其他工具 → switch_tool（按 category 兜底）
 *   否则 → escalate（升级让更强 loop 接管）
 *
 * 与 buildToolFailureReminder 的分工：
 *   - buildRecoveryHint（tool-metadata.ts）：在 loop 内部每轮注入给 LLM 的提示（影响 LLM 下一轮决策）
 *   - DefaultRecoveryPolicy（本文件）：在编排器层做结构化决策（决定重试/换工具/升级）
 *
 * 详见 docs/loop-orchestrator-architecture.md §5 Phase 2
 */

import type { LlmExecutionMode } from "../task-router.js";
import type { RecoveryPolicy, RecoveryAction } from "./policies.js";
import type { SharedTaskContext, FailureRecord } from "./shared-task-context.js";
import {
  getToolMetadata,
  getToolAlternatives,
  getSameCategoryTools,
} from "./tool-metadata.js";

export interface DefaultRecoveryOptions {
  /** 同工具最多重试几次后才换工具，默认 2 */
  maxRetriesBeforeSwitch?: number;
  /** 升级目标 loop（默认 plan_execute） */
  escalateTo?: LlmExecutionMode;
}

/**
 * 重试前的指数退避延迟。
 * delay = min(200 * 2^attempts, 2000) ms —— 200ms 起步，指数增长，2s 封顶。
 *
 * 在编排器决定 retry 后、下一轮执行前调用，避免对瞬时故障的密集重试压垮下游。
 */
export async function applyRetryBackoff(attempts: number): Promise<void> {
  const delay = Math.min(200 * Math.pow(2, attempts), 2000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export class DefaultRecoveryPolicy implements RecoveryPolicy {
  private readonly maxRetriesBeforeSwitch: number;
  private readonly escalateTo: LlmExecutionMode;

  constructor(opts: DefaultRecoveryOptions = {}) {
    this.maxRetriesBeforeSwitch = opts.maxRetriesBeforeSwitch ?? 2;
    this.escalateTo = opts.escalateTo ?? "plan_execute";
  }

  onFailure(ctx: SharedTaskContext, failure: FailureRecord): RecoveryAction {
    // 1. 同工具失败次数 < 阈值 → 重试（让 LLM 自行调整参数）
    if (failure.attempts < this.maxRetriesBeforeSwitch) {
      return { type: "retry" };
    }

    // 2. 有显式 alternatives → 换工具
    const alts = getToolAlternatives(failure.toolName);
    if (alts.length > 0) {
      const alternativeTool = alts[0];
      return {
        type: "switch_tool",
        alternativeTool,
        injectHint: `已连续失败 ${failure.attempts} 次，自动切换到 \`${alternativeTool}\`。`,
      };
    }

    // 3. 同类有其他工具 → 按 category 兜底换工具
    const sameCategory = getSameCategoryTools(failure.toolName);
    if (sameCategory.length > 0) {
      const alternativeTool = sameCategory[0];
      return {
        type: "switch_tool",
        alternativeTool,
        injectHint: `\`${failure.toolName}\` 连续失败，建议换用同类工具 \`${alternativeTool}\`。`,
      };
    }

    // 4. 无替代 → 升级让更强 loop 接管
    return {
      type: "escalate",
      escalateTo: this.escalateTo,
      injectHint: `\`${failure.toolName}\` 连续失败且无替代工具，升级到 ${this.escalateTo} 模式。`,
    };
  }
}
