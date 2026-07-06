/**
 * 能力模块统一接口约定（与 image-gen / file-doc / email-sms 同结构）：
 *
 * 导出 3 项：
 *   - `SOCIAL_OUTREACH_CHAT_TOOLS: ChatCompletionTool[]`          LLM 工具 schema
 *   - `registerSocialOutreachTools(registry, deps): void`          注册到 ToolRegistry
 *   - `SOCIAL_OUTREACH_INTENT_RULES: ToolIntentRule[]`             意图元数据（接 BM25 调权）
 *
 * 启动时由 {@link registerAllCapabilityModules} 统一注册。
 *
 * ⚠️ 本模块文件不做 capability-modules/index.ts 合并、也不改 create-app-services.ts /
 *    agent-capabilities.ts；最终由主线程统一合并。
 *
 * 与 `world.social.*`（SocialFeedService，Agent 内部世界社交）严格区分：
 *   - world.social.*     = Agent 与人类共享的内部社交网页（游戏化世界内）
 *   - social.*（本模块） = 外部真实社交平台（Twitter / 微博 / 小红书 / 朋友圈）
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { SocialOutreachService } from "../../../services/social-outreach-service.js";

import { SOCIAL_OUTREACH_CHAT_TOOLS } from "./chat-tools.js";
import {
  createSocialPostHandler,
  createSocialCommentHandler,
  createSocialRepostHandler,
  createSocialLikeHandler,
  createSocialGetFeedHandler,
  createSocialSearchPostsHandler,
} from "./handlers.js";

export { SOCIAL_OUTREACH_CHAT_TOOLS } from "./chat-tools.js";
export { SOCIAL_OUTREACH_INTENT_RULES } from "./intent.js";

/**
 * 注册 social-outreach 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（通过 registerAllCapabilityModules 间接调用）。
 */
export function registerSocialOutreachTools(
  registry: ToolRegistry,
  deps: { socialOutreachService: SocialOutreachService },
): void {
  const { socialOutreachService } = deps;
  registry.register("social.post", createSocialPostHandler(socialOutreachService));
  registry.register("social.comment", createSocialCommentHandler(socialOutreachService));
  registry.register("social.repost", createSocialRepostHandler(socialOutreachService));
  registry.register("social.like", createSocialLikeHandler(socialOutreachService));
  registry.register("social.get_feed", createSocialGetFeedHandler(socialOutreachService));
  registry.register("social.search_posts", createSocialSearchPostsHandler(socialOutreachService));
}
