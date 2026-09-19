/**
 * 能力模块统一接口约定（period-care）：
 *
 * 导出 3 项：
 *   - `PERIOD_CARE_CHAT_TOOLS: ChatCompletionTool[]`       LLM 工具 schema
 *   - `registerPeriodCareTools(registry, deps): void`      注册到 ToolRegistry
 *   - `PERIOD_CARE_INTENT_RULES: ToolIntentRule[]`         意图元数据（BM25 调权）
 *
 * 由 `capability-modules/index.ts` 在 `buildCapabilityModules(deps)` 中合并；
 * 主线程统一注入 `CapabilityModuleDeps.periodCareService`。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { PeriodCareService } from "../../../services/period-care-service.js";

import { PERIOD_CARE_CHAT_TOOLS } from "./chat-tools.js";
import {
  createPeriodHistoryHandler,
  createPeriodLogDailyHandler,
  createPeriodLogEndHandler,
  createPeriodLogStartHandler,
  createPeriodSetReminderHandler,
  createPeriodStatusHandler,
} from "./handlers.js";

export { PERIOD_CARE_CHAT_TOOLS } from "./chat-tools.js";
export { PERIOD_CARE_INTENT_RULES } from "./intent.js";

/**
 * 注册 period-care 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（经 `registerAllCapabilityModules`）。
 */
export function registerPeriodCareTools(
  registry: ToolRegistry,
  deps: { periodCareService: PeriodCareService },
): void {
  const service = deps.periodCareService;
  registry.register("period.log_start", createPeriodLogStartHandler(service));
  registry.register("period.log_end", createPeriodLogEndHandler(service));
  registry.register("period.log_daily", createPeriodLogDailyHandler(service));
  registry.register("period.status", createPeriodStatusHandler(service));
  registry.register("period.history", createPeriodHistoryHandler(service));
  registry.register("period.set_reminder", createPeriodSetReminderHandler(service));
}
