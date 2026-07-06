/**
 * 能力模块统一接口约定：
 *
 * 每个能力模块（capability-module）导出 4 项：
 *   - `<DOMAIN>_CHAT_TOOLS: ChatCompletionTool[]`          LLM 工具 schema
 *   - `register<Domain>Tools(registry, deps): void`          注册到 ToolRegistry
 *   - `<DOMAIN>_INTENT_RULES: ToolIntentRule[]`              意图元数据（接 BM25 调权）
 *   - `<DOMAIN>_CAPABILITY_SECTION?: CapabilitySection`     system prompt 能力说明（可选）
 *
 * 启动时由 {@link registerAllCapabilityModules} 统一注册，
 * 由 {@link getCapabilityModuleChatTools} 统一合并 ChatCompletionTool。
 *
 * 这样新增一个能力域时，只需在 `capability-modules/<name>/` 下加文件，
 * 再到 `capability-modules/index.ts` 里 import + 合并即可，不改动其他位置。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { ImageGenerationService } from "../../../services/image-generation-service.js";

import { IMAGE_GEN_CHAT_TOOLS } from "./chat-tools.js";
import { createImageGenerateHandler } from "./handlers.js";

export { IMAGE_GEN_CHAT_TOOLS } from "./chat-tools.js";
export { IMAGE_GEN_INTENT_RULES } from "./intent.js";

/**
 * 注册 image-gen 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段。
 */
export function registerImageGenTools(
  registry: ToolRegistry,
  deps: { imageGenerationService: ImageGenerationService },
): void {
  registry.register("image.generate", createImageGenerateHandler(deps.imageGenerationService));
}
