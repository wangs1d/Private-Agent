/**
 * 电话代办能力模块（capability-module）。
 *
 * 与 shared-browser / code-sandbox 同结构，导出：
 *   - `PHONE_CALL_CHAT_TOOLS`          LLM 工具 schema
 *   - `PHONE_CALL_INTENT_RULES`        意图元数据（接 BM25 调权）
 *   - `PHONE_CALL_CATEGORY_MAPPING`    关键词分类映射
 *   - `registerPhoneCallTools`         注册到 ToolRegistry
 *   - `buildPhoneCallModule`           构造 `CapabilityModule` 对象
 *
 * 域：agent 代用户向第三方真人发起真实电话（预约/确认/咨询），含拨前
 * 确认门、手机端二次确认、频控/静默时段、挂断后结果回填（收件箱必达）。
 * 与虚拟电话（agent.phone.* / phone.call_user）是两个并行体系，命名空间
 * `phone_call.*` 完全隔离（docs/phone-call-architecture.md §〇）。
 */
import type { CapabilityModule } from "../index.js";
import type { ToolRegistry } from "../../tool-registry.js";
import type { PhoneCallCoordinator } from "../../../services/phone-call-coordinator.js";

import { PHONE_CALL_CHAT_TOOLS } from "./chat-tools.js";
import { registerPhoneCallTools } from "./handlers.js";
import type { PhoneCallModuleDeps } from "./handlers.js";
import { PHONE_CALL_INTENT_RULES, PHONE_CALL_CATEGORY_MAPPING } from "./intent.js";

export { PHONE_CALL_CHAT_TOOLS } from "./chat-tools.js";
export { PHONE_CALL_INTENT_RULES, PHONE_CALL_CATEGORY_MAPPING } from "./intent.js";
export { registerPhoneCallTools, type PhoneCallModuleDeps } from "./handlers.js";

/**
 * 构造 phone-call 能力模块描述符。
 *
 * PHONE_CALL_ENABLED=false（默认）时：chatTools 置空 + 不注册任何执行器——
 * 工具对 LLM 完全不可见，且不产生 schema↔执行器漂移告警（双向都为空）。
 */
export function buildPhoneCallModule(
  deps: PhoneCallModuleDeps,
): CapabilityModule {
  const enabled = deps.phoneCallCoordinator.isEnabled();
  return {
    domain: "phone_call",
    label: "电话代办（代拨真实电话：预约/确认/回电）",
    chatTools: enabled ? PHONE_CALL_CHAT_TOOLS : [],
    intentRules: enabled ? PHONE_CALL_INTENT_RULES : [],
    register: (registry: ToolRegistry) => {
      if (!deps.phoneCallCoordinator.isEnabled()) return;
      registerPhoneCallTools(registry, deps);
    },
    category: {
      name: PHONE_CALL_CATEGORY_MAPPING.name,
      keywords: PHONE_CALL_CATEGORY_MAPPING.keywords,
    },
  };
}
