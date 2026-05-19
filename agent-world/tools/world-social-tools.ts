import type { SocialFeedService } from "../services/social-feed-service.js";
import type { ToolRegistryLike } from "../host-types.js";

/**
 * Agent 在互动平台发帖、评论、点赞、上传媒体、删帖、举报；与 WebSocket `world.social.*` 语义一致。
 */
export function registerWorldSocialTools(registry: ToolRegistryLike, social: SocialFeedService): void {
  registry.register("world.social.get_feed", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    return social.getFeedForViewer(context.sessionId, limit);
  });

  registry.register("world.social.post", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const text = String(input.text ?? "");
    const mediaType = (input.mediaType === "image" || input.mediaType === "video" ? input.mediaType : "none") as
      | "none"
      | "image"
      | "video";
    const mediaUrl =
      input.mediaUrl === null || input.mediaUrl === undefined ? null : String(input.mediaUrl);
    const r = social.createPost(context.sessionId, text, mediaType, mediaUrl);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, post: r.post };
  });

  registry.register("world.social.comment", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const postId = String(input.postId ?? "").trim();
    const text = String(input.text ?? "");
    if (!postId) throw new Error("缺少 postId");
    const r = social.addComment(context.sessionId, postId, text);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, comment: r.comment };
  });

  registry.register("world.social.like_toggle", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const postId = String(input.postId ?? "").trim();
    if (!postId) throw new Error("缺少 postId");
    const r = social.toggleLike(context.sessionId, postId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, liked: r.liked, likeCount: r.likeCount };
  });

  registry.register("world.social.upload_media", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const mimeType = String(input.mimeType ?? "").trim();
    const dataBase64 = String(input.dataBase64 ?? "").trim();
    if (!mimeType) throw new Error("缺少 mimeType");
    if (!dataBase64) throw new Error("缺少 dataBase64");
    let buf: Buffer;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch {
      throw new Error("INVALID_BASE64");
    }
    const saved = await social.saveUploadedMedia(buf, mimeType);
    if (!saved.ok) throw new Error(saved.reason);
    return { ok: true, mediaUrl: saved.mediaUrl };
  });

  registry.register("world.social.delete_post", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const postId = String(input.postId ?? "").trim();
    if (!postId) throw new Error("缺少 postId");
    const r = social.deletePost(context.sessionId, postId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true };
  });

  registry.register("world.social.report", async (input, context) => {
    social.assertAgentWorldEntry(context.sessionId);
    const postId = String(input.postId ?? "").trim();
    if (!postId) throw new Error("缺少 postId");
    const reason = input.reason === undefined || input.reason === null ? undefined : String(input.reason);
    const r = social.reportPost(context.sessionId, postId, reason);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, duplicate: r.duplicate === true };
  });
}
