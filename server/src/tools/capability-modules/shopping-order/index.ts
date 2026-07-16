/**
 * 购物/下单能力模块（capability-module）。
 *
 * 与 image-gen / code-sandbox 同结构，导出：
 *   - `SHOPPING_ORDER_CHAT_TOOLS`          LLM 工具 schema（4 个工具）
 *   - `SHOPPING_ORDER_INTENT_RULES`        意图元数据（接 BM25 调权）
 *   - `SHOPPING_ORDER_CATEGORY_MAPPING`    关键词分类映射
 *   - `registerShoppingOrderTools`         注册到 ToolRegistry
 *
 * 启动时由 `capability-modules/index.ts` 的 `buildCapabilityModules(deps)` 统一合并到
 * `CAPABILITY_MODULES` 数组，由 `registerAllCapabilityModules` /
 * `getCapabilityModuleChatTools` 等统一消费。
 *
 * 核心定位：在服务端后台启动 Playwright 无头浏览器，注入用户预先导入并授权的 Cookie，
 * 代用户完成搜索/下单/查单/取消。兼容所有支持 Cookie 登录的购物平台。
 */
import { SHOPPING_ORDER_CHAT_TOOLS } from "./chat-tools.js";
import { registerShoppingOrderTools } from "./handlers.js";
import type { ShoppingOrderModuleDeps } from "./handlers.js";
import { SHOPPING_ORDER_INTENT_RULES, SHOPPING_ORDER_CATEGORY_MAPPING } from "./intent.js";

export { SHOPPING_ORDER_CHAT_TOOLS } from "./chat-tools.js";
export { SHOPPING_ORDER_INTENT_RULES, SHOPPING_ORDER_CATEGORY_MAPPING } from "./intent.js";
export { registerShoppingOrderTools, type ShoppingOrderModuleDeps } from "./handlers.js";
