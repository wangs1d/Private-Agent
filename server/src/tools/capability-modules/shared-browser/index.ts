/**
 * 共用浏览器能力模块（capability-module）。
 *
 * 与 agent-browser 同结构，导出：
 *   - `SHARED_BROWSER_CHAT_TOOLS`          LLM 工具 schema（6 个工具）
 *   - `SHARED_BROWSER_INTENT_RULES`        意图元数据（接 BM25 调权）
 *   - `SHARED_BROWSER_CATEGORY_MAPPING`    关键词分类映射
 *   - `registerSharedBrowserTools`         注册到 ToolRegistry
 *
 * 核心定位：用户与 Agent 共用同一个客户端内嵌浏览器（WebView2）。
 * Agent 的操作经 WS 转发到客户端执行，用户实时可见、可随时接管；
 * 用户已登录站点的登录态天然可用，无需 Cookie 导入。
 * 与 agent-browser（服务端 Playwright 无头会话池，用户不可见）互补。
 */
import { SHARED_BROWSER_CHAT_TOOLS } from "./chat-tools.js";
import { registerSharedBrowserTools } from "./handlers.js";
import type { SharedBrowserModuleDeps } from "./handlers.js";
import { SHARED_BROWSER_INTENT_RULES, SHARED_BROWSER_CATEGORY_MAPPING } from "./intent.js";

export { SHARED_BROWSER_CHAT_TOOLS } from "./chat-tools.js";
export { SHARED_BROWSER_INTENT_RULES, SHARED_BROWSER_CATEGORY_MAPPING } from "./intent.js";
export { registerSharedBrowserTools, type SharedBrowserModuleDeps } from "./handlers.js";
