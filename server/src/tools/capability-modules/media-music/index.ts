/**
 * 能力模块统一接口约定：见 capability-modules/index.ts 顶部说明。
 *
 * 本模块导出 4 项：
 *   - MEDIA_MUSIC_CHAT_TOOLS: ChatCompletionTool[]          LLM 工具 schema
 *   - registerMediaMusicTools(registry, deps): void         注册到 ToolRegistry
 *   - MEDIA_MUSIC_INTENT_RULES: ToolIntentRule[]            意图元数据（接 BM25 调权）
 *   - （可选）MEDIA_MUSIC_CAPABILITY_SECTION —— 由主线程合并到 agent-capabilities.ts
 *
 * 启动时由 {@link registerAllCapabilityModules} 统一注册，
 * 由 {@link getCapabilityModuleChatTools} 统一合并 ChatCompletionTool。
 *
 * 不需要改动：
 *   - capability-modules/index.ts（主线程统一合并）
 *   - create-app-services.ts（主线程实例化 MediaMusicService + 传 deps）
 *   - agent-capabilities.ts（主线程加 media_music 域 system prompt）
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { MediaMusicService } from "../../../services/media-music-service.js";
import type { WsConnectionRegistry } from "../../../services/ws-connection-registry.js";

import {
  createMediaSearchHandler,
  createMediaPlayHandler,
  createMediaPauseHandler,
  createMediaResumeHandler,
  createMediaStopHandler,
  createMediaNowPlayingHandler,
} from "./handlers.js";

export { MEDIA_MUSIC_CHAT_TOOLS } from "./chat-tools.js";
export { MEDIA_MUSIC_INTENT_RULES } from "./intent.js";

/**
 * 注册 media-music 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（通过 capability-modules/index.ts 合并）。
 *
 * @param deps.mediaMusicService    媒体音乐服务（搜索 + WS 推送）
 * @param deps.wsConnectionRegistry WebSocket 连接注册表（已封装在 MediaMusicService 内部，
 *                                  此处保留入参以符合模块约定，便于未来扩展直推场景）
 */
export function registerMediaMusicTools(
  registry: ToolRegistry,
  deps: { mediaMusicService: MediaMusicService; wsConnectionRegistry: WsConnectionRegistry },
): void {
  // wsConnectionRegistry 已封装在 MediaMusicService 内部，这里仅访问 mediaMusicService。
  registry.register("media.search", createMediaSearchHandler(deps.mediaMusicService));
  registry.register("media.play", createMediaPlayHandler(deps.mediaMusicService));
  registry.register("media.pause", createMediaPauseHandler(deps.mediaMusicService));
  registry.register("media.resume", createMediaResumeHandler(deps.mediaMusicService));
  registry.register("media.stop", createMediaStopHandler(deps.mediaMusicService));
  registry.register("media.now_playing", createMediaNowPlayingHandler(deps.mediaMusicService));
}
