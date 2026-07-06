/**
 * 能力模块统一接口约定（与 image-gen 同结构）：
 *
 * 导出 4 项：
 *   - `FILE_DOC_CHAT_TOOLS: ChatCompletionTool[]`                LLM 工具 schema
 *   - `registerFileDocTools(registry, deps): void`                注册到 ToolRegistry
 *   - `FILE_DOC_INTENT_RULES: ToolIntentRule[]`                  意图元数据（接 BM25 调权）
 *   - （可选）capability section 由 agent-capabilities.ts 静态拼装
 *
 * 启动时由 `registerAllCapabilityModules` 统一注册。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { FileProcessingService } from "../../../services/file-processing-service.js";

import { FILE_DOC_CHAT_TOOLS } from "./chat-tools.js";
import {
  createFileReadTextHandler,
  createFileWriteTextHandler,
  createFileParsePdfHandler,
  createFileParseOfficeHandler,
  createFileExportFormatHandler,
} from "./handlers.js";

export { FILE_DOC_CHAT_TOOLS } from "./chat-tools.js";
export { FILE_DOC_INTENT_RULES } from "./intent.js";

/**
 * 注册 file-doc 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（通过 registerAllCapabilityModules 间接调用）。
 */
export function registerFileDocTools(
  registry: ToolRegistry,
  deps: { fileProcessingService: FileProcessingService },
): void {
  const { fileProcessingService } = deps;
  registry.register("file.read_text", createFileReadTextHandler(fileProcessingService));
  registry.register("file.write_text", createFileWriteTextHandler(fileProcessingService));
  registry.register("file.parse_pdf", createFileParsePdfHandler(fileProcessingService));
  registry.register("file.parse_office", createFileParseOfficeHandler(fileProcessingService));
  registry.register("file.export_format", createFileExportFormatHandler(fileProcessingService));
}
