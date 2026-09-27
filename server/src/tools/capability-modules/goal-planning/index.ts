/**
 * 计划推进能力模块（capability-module）。
 *
 * 导出 goal.plan.* 六工具：create / list / advance / step / replan / abandon。
 * 执行体在 GoalPlanner（proactivity/goal-planner.ts），本模块只挂 schema + 注册。
 */
import { GOAL_PLANNING_CHAT_TOOLS } from "./chat-tools.js";
import { registerGoalPlanningTools, type GoalPlanningModuleDeps } from "./handlers.js";
import { GOAL_PLANNING_INTENT_RULES, GOAL_PLANNING_CATEGORY_MAPPING } from "./intent.js";

export { GOAL_PLANNING_CHAT_TOOLS } from "./chat-tools.js";
export { GOAL_PLANNING_INTENT_RULES, GOAL_PLANNING_CATEGORY_MAPPING } from "./intent.js";
export { registerGoalPlanningTools, type GoalPlanningModuleDeps } from "./handlers.js";

/** CapabilityModule 描述符组装（create-app-services 的 buildCapabilityModules 消费） */
export function buildGoalPlanningModule(deps: GoalPlanningModuleDeps) {
  return {
    domain: "goal_planning",
    label: "计划推进（长期目标拆步+自主推进+动态重排）",
    chatTools: GOAL_PLANNING_CHAT_TOOLS,
    intentRules: GOAL_PLANNING_INTENT_RULES,
    register: (registry: Parameters<typeof registerGoalPlanningTools>[0]) =>
      registerGoalPlanningTools(registry, deps),
    category: GOAL_PLANNING_CATEGORY_MAPPING,
  };
}
