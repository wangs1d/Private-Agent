// Agent Body Center — 模块出口
//
// 与 brain/index.ts 对称：导出 BodyCenter / BodyBus / BodyGateway / 核心类型。
//
// HTTP 路由实现：server/src/routes/http/body.ts（registerBodyRoutes）
// LLM 工具实现：server/src/tools/body-tools.ts（registerBodyTools + BODY_CHAT_TOOLS）
// 装配阶段（Task 14）从上述两个文件直接 import 并注入 BodyCenter 实例。

export * from "./types.js";
export { BodyCenter } from "./body-center.js";
export { BodyBus } from "./body-bus.js";
export { BodyGateway, type BodyGatewayOptions } from "./body-gateway.js";
export type { BodyGatewayLike, ReflexArcLike, ToolRegistryLike } from "./body-gateway.js";
export { ReflexArc, type ReflexPattern } from "./reflex-arc.js";

// 透传 body.* LLM 工具 schema，供装配阶段统一从 body/ 入口拉取
export {
  BODY_CHAT_TOOLS,
  BODY_WHERE_AM_I_TOOL,
  BODY_STATE_TOOL,
  BODY_LIST_MODULES_TOOL,
  BODY_CALIBRATE_TOOL,
} from "../tools/body-tools.js";
