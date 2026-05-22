import { getAgentRuntimeConfig, type AgentRuntimeConfig } from "./agent-runtime-config.js";
import { isPlanExecuteLoopEnabled, shouldUsePlanExecuteLoop } from "./plan-execute-loop.js";
import { isSimpleDirectTask } from "./simple-task.js";

export type LlmExecutionMode =
  | "master_only"
  | "master_delegate"
  | "plan_execute"
  | "direct_llm";

export type RouteDecision = {
  mode: LlmExecutionMode;
  reasons: string[];
};

/**
 * 单点 LLM 执行策略路由（所有用户消息均经 Agent 分析，无关键词即时短路）。
 */
export function routeLlmExecution(
  message: string,
  config: AgentRuntimeConfig = getAgentRuntimeConfig(),
): RouteDecision {
  const t = message.trim();
  const reasons: string[] = [];

  if (config.masterDelegation.enabled) {
    if (isSimpleDirectTask(t)) {
      reasons.push("simple_direct_task");
      return { mode: "master_only", reasons };
    }
    reasons.push("delegate_via_tools");
    return { mode: "master_delegate", reasons };
  }

  if (shouldUsePlanExecuteLoop(t)) {
    reasons.push("plan_execute_heuristic");
    return { mode: "plan_execute", reasons };
  }

  if (isPlanExecuteLoopEnabled() && !isSimpleDirectTask(t)) {
    reasons.push("plan_execute_available_but_skipped");
  }

  reasons.push("default_direct_llm");
  return { mode: "direct_llm", reasons };
}
