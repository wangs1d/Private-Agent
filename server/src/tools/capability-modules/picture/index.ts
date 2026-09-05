/**
 * 图片能力模块(图库 + 美颜批图)统一出口。
 *
 * 数据源:`@private-ai-agent/picture` 的 PictureKit,
 * 存储根目录 data/pictures(assets/thumbs/index.json)。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { PictureKit } from "@private-ai-agent/picture";

import { PICTURE_CHAT_TOOLS } from "./chat-tools.js";
import { createPictureBeautifyHandler, createPictureGalleryHandler } from "./handlers.js";

export { PICTURE_CHAT_TOOLS } from "./chat-tools.js";
export { PICTURE_INTENT_RULES } from "./intent.js";

/** 注册 picture 工具到 ToolRegistry(调用方:create-app-services.ts 启动阶段) */
export function registerPictureModuleTools(
  registry: ToolRegistry,
  deps: { pictureKit: PictureKit },
): void {
  registry.register("picture.gallery", createPictureGalleryHandler(deps.pictureKit));
  registry.register("picture.beautify", createPictureBeautifyHandler(deps.pictureKit));
}
