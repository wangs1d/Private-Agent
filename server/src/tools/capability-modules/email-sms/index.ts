/**
 * 能力模块统一接口约定（与 image-gen / file-doc 同结构）：
 *
 * 导出 3 项：
 *   - `EMAIL_SMS_CHAT_TOOLS: ChatCompletionTool[]`              LLM 工具 schema
 *   - `registerEmailSmsTools(registry, deps): void`              注册到 ToolRegistry
 *   - `EMAIL_SMS_INTENT_RULES: ToolIntentRule[]`                 意图元数据（接 BM25 调权）
 *
 * 启动时由 {@link registerAllCapabilityModules} 统一注册。
 *
 * ⚠️ 本模块文件不做 capability-modules/index.ts 合并、也不改 create-app-services.ts /
 *    agent-capabilities.ts；最终由主线程统一合并。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { EmailSmsService } from "../../../services/email-sms-service.js";

import { EMAIL_SMS_CHAT_TOOLS } from "./chat-tools.js";
import { createEmailSendHandler, createSmsSendHandler } from "./handlers.js";

export { EMAIL_SMS_CHAT_TOOLS } from "./chat-tools.js";
export { EMAIL_SMS_INTENT_RULES } from "./intent.js";

/**
 * 注册 email-sms 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（通过 registerAllCapabilityModules 间接调用）。
 */
export function registerEmailSmsTools(
  registry: ToolRegistry,
  deps: { emailSmsService: EmailSmsService },
): void {
  const { emailSmsService } = deps;
  registry.register("email.send", createEmailSendHandler(emailSmsService));
  registry.register("sms.send", createSmsSendHandler(emailSmsService));
}
