import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type {
  SocialOutreachService,
  SocialPostInput,
  SocialCommentInput,
} from "../../../services/social-outreach-service.js";

/**
 * social-outreach 工具 handler 工厂集合。
 *
 * 约定：
 *   - 失败统一返回 `{ ok: false, error, retryable? }`
 *   - 成功返回 `{ ok: true, ..., summary }`
 *   - handler 签名：`(input, context: ToolContext) => Promise<Record<string, unknown>>`
 *
 * 调用前 LLM 应已与用户确认平台 / 内容 / 目标帖子（社交主动出击属于「公开触达」，谨慎操作）。
 */

/** 把平台字符串规范化（trim + lowercase），不校验合法性（service 层会校验）。 */
function normalizePlatform(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

/** 把可选数字字段从 LLM 入参里安全解析出来。 */
function parseOptionalInt(input: unknown): number | undefined {
  if (input == null) return undefined;
  const n = Number(input);
  return Number.isFinite(n) ? n : undefined;
}

/** 把可选字符串字段安全解析为 trimmed string 或 undefined。 */
function parseOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const t = input.trim();
  return t.length > 0 ? t : undefined;
}

/** 把 images 字段安全解析为 string[]（仅保留非空字符串）。 */
function parseStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const arr = input
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
  return arr.length > 0 ? arr : undefined;
}

/** 把 platformOptions 字段安全解析为对象（仅保留非空对象）。 */
function parseObject(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/**
 * social.post 工具 handler。
 *
 * 跨平台发帖到 Twitter / 微博 / 小红书 / 朋友圈。
 */
export function createSocialPostHandler(service: SocialOutreachService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void resolveActorId(context); // 保留供后续审计

    const platform = normalizePlatform(input.platform);
    if (!platform) {
      return { ok: false, error: "缺少 platform（社交平台，可选：twitter / weibo / xiaohongshu / wechat_moments）", retryable: false };
    }
    const content = typeof input.content === "string" ? input.content : "";
    if (!content.trim()) {
      return { ok: false, error: "缺少 content（帖子正文）", retryable: false };
    }

    const payload: SocialPostInput = {
      content,
      images: parseStringArray(input.images),
      platformOptions: parseObject(input.platformOptions),
    };

    const result = await service.post(platform, payload);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      platform: result.platform,
      postId: result.postId,
      url: result.url,
      createdAt: result.createdAt,
      summary: result.summary,
    };
  };
}

/**
 * social.comment 工具 handler。
 *
 * 在指定平台评论某条帖子。
 */
export function createSocialCommentHandler(service: SocialOutreachService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void resolveActorId(context);

    const platform = normalizePlatform(input.platform);
    if (!platform) {
      return { ok: false, error: "缺少 platform（社交平台）", retryable: false };
    }
    const postId = parseOptionalString(input.postId);
    if (!postId) {
      return { ok: false, error: "缺少 postId（被评论的帖子 ID）", retryable: false };
    }
    const content = typeof input.content === "string" ? input.content : "";
    if (!content.trim()) {
      return { ok: false, error: "缺少 content（评论正文）", retryable: false };
    }

    const payload: SocialCommentInput = { postId, content };
    const result = await service.comment(platform, payload);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      platform: result.platform,
      commentId: result.commentId,
      postId: result.postId,
      createdAt: result.createdAt,
      summary: result.summary,
    };
  };
}

/**
 * social.repost 工具 handler。
 *
 * 转发 / 引用某条外部平台帖子。
 */
export function createSocialRepostHandler(service: SocialOutreachService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void resolveActorId(context);

    const platform = normalizePlatform(input.platform);
    if (!platform) {
      return { ok: false, error: "缺少 platform（社交平台）", retryable: false };
    }
    const postId = parseOptionalString(input.postId);
    if (!postId) {
      return { ok: false, error: "缺少 postId（被转发的帖子 ID）", retryable: false };
    }
    const quote = parseOptionalString(input.quote);

    const result = await service.repost(platform, postId, quote);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      platform: result.platform,
      repostId: result.repostId,
      originalPostId: result.originalPostId,
      url: result.url,
      createdAt: result.createdAt,
      summary: result.summary,
    };
  };
}

/**
 * social.like 工具 handler。
 *
 * 点赞某条帖子（微博用收藏代替）。
 */
export function createSocialLikeHandler(service: SocialOutreachService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void resolveActorId(context);

    const platform = normalizePlatform(input.platform);
    if (!platform) {
      return { ok: false, error: "缺少 platform（社交平台）", retryable: false };
    }
    const postId = parseOptionalString(input.postId);
    if (!postId) {
      return { ok: false, error: "缺少 postId（被点赞的帖子 ID）", retryable: false };
    }

    const result = await service.like(platform, postId);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      platform: result.platform,
      postId: result.postId,
      liked: result.liked,
      summary: result.summary,
    };
  };
}

/**
 * social.get_feed 工具 handler。
 *
 * 拉取指定平台的最新时间线。
 */
export function createSocialGetFeedHandler(service: SocialOutreachService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void resolveActorId(context);

    const platform = normalizePlatform(input.platform);
    if (!platform) {
      return { ok: false, error: "缺少 platform（社交平台）", retryable: false };
    }
    const cursor = parseOptionalString(input.cursor);
    const limit = parseOptionalInt(input.limit);

    const result = await service.getFeed(platform, cursor, limit);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      platform: result.platform,
      posts: result.posts,
      nextCursor: result.nextCursor,
      summary: result.summary,
    };
  };
}

/**
 * social.search_posts 工具 handler。
 *
 * 搜索话题 / 关键词下的帖子。
 */
export function createSocialSearchPostsHandler(service: SocialOutreachService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    void resolveActorId(context);

    const platform = normalizePlatform(input.platform);
    if (!platform) {
      return { ok: false, error: "缺少 platform（社交平台）", retryable: false };
    }
    const query = parseOptionalString(input.query);
    if (!query) {
      return { ok: false, error: "缺少 query（搜索关键词 / 话题）", retryable: false };
    }
    const cursor = parseOptionalString(input.cursor);
    const limit = parseOptionalInt(input.limit);

    const result = await service.searchPosts(platform, query, cursor, limit);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      platform: result.platform,
      query: result.query,
      posts: result.posts,
      nextCursor: result.nextCursor,
      summary: result.summary,
    };
  };
}
