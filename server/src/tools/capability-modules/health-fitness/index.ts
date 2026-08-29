/**
 * 能力模块统一接口约定（health-fitness）：
 *
 * 导出 3 项：
 *   - `HEALTH_FITNESS_CHAT_TOOLS: ChatCompletionTool[]`   LLM 工具 schema
 *   - `registerHealthFitnessTools(registry, deps): void`   注册到 ToolRegistry
 *   - `HEALTH_FITNESS_INTENT_RULES: ToolIntentRule[]`     意图元数据（接 BM25 调权）
 *
 * 由 `capability-modules/index.ts` 在 `buildCapabilityModules(deps)` 中合并；
 * 主线程统一注入 `CapabilityModuleDeps.healthFitnessService`。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { HealthFitnessService } from "../../../services/health-fitness-service.js";

import { HEALTH_FITNESS_CHAT_TOOLS } from "./chat-tools.js";
import {
  createHealthGetGoalsHandler,
  createHealthGetMetricsHandler,
  createHealthGetSummaryHandler,
  createHealthImportDataHandler,
  createHealthLogMetricHandler,
  createHealthQueryHandler,
  createHealthSetGoalHandler,
} from "./handlers.js";

export { HEALTH_FITNESS_CHAT_TOOLS } from "./chat-tools.js";
export { HEALTH_FITNESS_INTENT_RULES } from "./intent.js";

/**
 * 注册 health-fitness 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（经 `registerAllCapabilityModules`）。
 */
export function registerHealthFitnessTools(
  registry: ToolRegistry,
  deps: { healthFitnessService: HealthFitnessService },
): void {
  const service = deps.healthFitnessService;
  registry.register("health.log_metric", createHealthLogMetricHandler(service));
  registry.register("health.get_metrics", createHealthGetMetricsHandler(service));
  registry.register("health.get_summary", createHealthGetSummaryHandler(service));
  registry.register("health.query", createHealthQueryHandler(service));
  registry.register("health.set_goal", createHealthSetGoalHandler(service));
  registry.register("health.get_goals", createHealthGetGoalsHandler(service));
  registry.register("health.import_data", createHealthImportDataHandler(service));
}
