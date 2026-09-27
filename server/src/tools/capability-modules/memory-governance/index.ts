/**
 * 记忆治理能力模块（capability-module）。
 *
 * memory.forget（用户侧定向遗忘统一入口）+ activity.timeline（行为审计只读视图）。
 */
import { MEMORY_GOVERNANCE_CHAT_TOOLS } from "./chat-tools.js";
import { registerMemoryGovernanceTools, type MemoryGovernanceModuleDeps } from "./handlers.js";
import { MEMORY_GOVERNANCE_INTENT_RULES, MEMORY_GOVERNANCE_CATEGORY_MAPPING } from "./intent.js";

export { MEMORY_GOVERNANCE_CHAT_TOOLS } from "./chat-tools.js";
export { MEMORY_GOVERNANCE_INTENT_RULES, MEMORY_GOVERNANCE_CATEGORY_MAPPING } from "./intent.js";
export { registerMemoryGovernanceTools, type MemoryGovernanceModuleDeps } from "./handlers.js";

/** CapabilityModule 描述符组装（create-app-services 的 buildCapabilityModules 消费） */
export function buildMemoryGovernanceModule(deps: MemoryGovernanceModuleDeps) {
  return {
    domain: "memory_governance",
    label: "记忆治理（定向遗忘 + 行为审计时间线）",
    chatTools: MEMORY_GOVERNANCE_CHAT_TOOLS,
    intentRules: MEMORY_GOVERNANCE_INTENT_RULES,
    register: (registry: Parameters<typeof registerMemoryGovernanceTools>[0]) =>
      registerMemoryGovernanceTools(registry, deps),
    category: MEMORY_GOVERNANCE_CATEGORY_MAPPING,
  };
}
