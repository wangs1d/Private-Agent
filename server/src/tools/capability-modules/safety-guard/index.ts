/**
 * 能力模块统一接口约定（safety-guard）：
 *
 * 导出 3 项：
 *   - `SAFETY_GUARD_CHAT_TOOLS: ChatCompletionTool[]`       LLM 工具 schema
 *   - `registerSafetyGuardTools(registry, deps): void`      注册到 ToolRegistry
 *   - `SAFETY_GUARD_INTENT_RULES: ToolIntentRule[]`         意图元数据（BM25 调权）
 *
 * 由 `capability-modules/index.ts` 在 `buildCapabilityModules(deps)` 中合并；
 * 主线程统一注入 `CapabilityModuleDeps.safetyGuardService`。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { SafetyGuardService } from "../../../services/safety-guard-service.js";

import { SAFETY_GUARD_CHAT_TOOLS } from "./chat-tools.js";
import {
  createSafetyFakeCallHandler,
  createSafetyGetContactsHandler,
  createSafetyRemoveContactHandler,
  createSafetySetContactHandler,
  createSafetySosHandler,
} from "./handlers.js";

export { SAFETY_GUARD_CHAT_TOOLS } from "./chat-tools.js";
export { SAFETY_GUARD_INTENT_RULES } from "./intent.js";

/**
 * 注册 safety-guard 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（经 `registerAllCapabilityModules`）。
 */
export function registerSafetyGuardTools(
  registry: ToolRegistry,
  deps: { safetyGuardService: SafetyGuardService },
): void {
  const service = deps.safetyGuardService;
  registry.register("safety.set_contact", createSafetySetContactHandler(service));
  registry.register("safety.get_contacts", createSafetyGetContactsHandler(service));
  registry.register("safety.remove_contact", createSafetyRemoveContactHandler(service));
  registry.register("safety.sos", createSafetySosHandler(service));
  registry.register("safety.fake_call", createSafetyFakeCallHandler(service));
}
