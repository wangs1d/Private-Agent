/**
 * 代码执行沙盒能力模块（capability-module）。
 *
 * 与 image-gen / file-doc 同结构，导出：
 *   - `CODE_SANDBOX_CHAT_TOOLS`          LLM 工具 schema
 *   - `CODE_SANDBOX_INTENT_RULES`        意图元数据（接 BM25 调权）
 *   - `CODE_SANDBOX_CATEGORY_MAPPING`    关键词分类映射
 *   - `registerCodeSandboxTools`         注册到 ToolRegistry
 *   - `buildCodeSandboxModule`          构造 `CapabilityModule` 对象
 *
 * 启动时由 `capability-modules/index.ts` 的 `buildCapabilityModules` 调用
 * `buildCodeSandboxModule(deps)`，统一合并到 `CAPABILITY_MODULES` 数组。
 *
 * ⚠️ 本模块未在 `capability-modules/index.ts` 注册前，`CodeSandboxService` 会有
 * 「未使用」警告 —— 这是预期的（主线程在 c99 阶段统一注入）。
 */
import type { CapabilityModule } from "../index.js";
import type { ToolRegistry } from "../../tool-registry.js";
import type { CodeSandboxService } from "../../../services/code-sandbox-service.js";

import { CODE_SANDBOX_CHAT_TOOLS } from "./chat-tools.js";
import { registerCodeSandboxTools } from "./handlers.js";
import type { CodeSandboxModuleDeps } from "./handlers.js";
import { CODE_SANDBOX_INTENT_RULES, CODE_SANDBOX_CATEGORY_MAPPING } from "./intent.js";

export { CODE_SANDBOX_CHAT_TOOLS } from "./chat-tools.js";
export { CODE_SANDBOX_INTENT_RULES, CODE_SANDBOX_CATEGORY_MAPPING } from "./intent.js";
export { registerCodeSandboxTools, type CodeSandboxModuleDeps } from "./handlers.js";

/**
 * 构造 code-sandbox 能力模块描述符。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules(deps)`，
 * 传入包含 `codeSandboxService` 的依赖后返回 {@link CapabilityModule} 对象，
 * 由 `registerAllCapabilityModules` / `getCapabilityModuleChatTools` 等统一消费。
 */
export function buildCodeSandboxModule(
  deps: CodeSandboxModuleDeps,
): CapabilityModule {
  return {
    domain: "code_sandbox",
    label: "代码执行沙盒（python / node）",
    chatTools: CODE_SANDBOX_CHAT_TOOLS,
    intentRules: CODE_SANDBOX_INTENT_RULES,
    register: (registry: ToolRegistry) => registerCodeSandboxTools(registry, deps),
    category: CODE_SANDBOX_CATEGORY_MAPPING,
  };
}
