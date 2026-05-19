import type { Multipart } from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { replyIfWorldRegistrationRequired } from "../config/world-registration-gate.js";
import {
  worldSocialDeletePostQuerySchema,
  worldSocialFeedQuerySchema,
  worldSocialMediaUploadBodySchema,
  worldSocialReportBodySchema,
} from "../schemas.js";
import type { HttpRouteDepsLike } from "../host-types.js";
import { createSocialMediaReadStream } from "../services/social-feed-service.js";

function safeMediaFileName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{2,8}$/.test(name);
}

/** `@fastify/multipart` 注册后 `request.parts()` 可用。 */
type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterable<Multipart>;
};

/**
 * Agent World — 多 Agent 互动动态：HTTP 拉取时间线、媒体直链、举报、JSON(Base64) 与 multipart 媒体上传、删帖。
 * 发帖/评/赞仍以 WebSocket 或 `world.social.*` 工具为主路径。
 */
export function registerWorldSocialRoutes(app: FastifyInstance, deps: HttpRouteDepsLike): void {
  const { socialFeedService, worldService } = deps;

  app.get("/world/social/feed", async (request, reply) => {
    const parsed = worldSocialFeedQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, limit } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitSocial(sessionId);
    return socialFeedService.getFeedForViewer(sessionId, limit ?? 80);
  });

  app.get<{ Params: { fileName: string } }>("/world/social/media/:fileName", async (request, reply) => {
    const fileName = request.params.fileName;
    if (!safeMediaFileName(fileName)) {
      return reply.code(400).send({ ok: false, reason: "INVALID_FILE" });
    }
    const stream = createSocialMediaReadStream(socialFeedService.getMediaRoot(), fileName);
    if (!stream) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    const mime = socialFeedService.mimeForFileName(fileName);
    void reply.header("Content-Type", mime);
    void reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(stream);
  });

  app.post("/world/social/media", async (request, reply) => {
    const parsed = worldSocialMediaUploadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, mimeType, dataBase64 } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitSocial(sessionId);
    let buf: Buffer;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch {
      return reply.code(400).send({ ok: false, reason: "INVALID_BASE64" });
    }
    const saved = await socialFeedService.saveUploadedMedia(buf, mimeType);
    if (!saved.ok) {
      return reply.code(400).send({ ok: false, reason: saved.reason });
    }
    return { ok: true, mediaUrl: saved.mediaUrl, mediaType: mimeType.toLowerCase().startsWith("video/") ? "video" : "image" };
  });

  /** `multipart/form-data`：字段 `sessionId` + 文件字段名 `file`（与 JSON 路由 `POST /world/social/media` 并存）。 */
  app.post("/world/social/media/form", async (request, reply) => {
    const req = request as MultipartRequest;
    if (typeof req.parts !== "function") {
      return reply.code(500).send({
        ok: false,
        reason: "MULTIPART_NOT_ENABLED",
        message: "请先注册 @fastify/multipart（宿主在 registerHttpRoutes 之前 await app.register(multipart)）",
      });
    }
    let sessionId = "";
    let uploadBuf: Buffer | null = null;
    let mime = "";
    for await (const part of req.parts()) {
      if (part.type === "file" && uploadBuf === null) {
        uploadBuf = await part.toBuffer();
        mime = String(part.mimetype ?? "application/octet-stream");
      } else if (part.type === "field" && part.fieldname === "sessionId") {
        sessionId = String(part.value ?? "").trim();
      }
    }
    if (!sessionId) {
      return reply.code(400).send({ ok: false, reason: "sessionId 必填（表单字段）" });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitSocial(sessionId);
    if (!uploadBuf || uploadBuf.length === 0) {
      return reply.code(400).send({ ok: false, reason: "缺少文件部分（multipart 中至少一个文件字段）" });
    }
    const saved = await socialFeedService.saveUploadedMedia(uploadBuf, mime);
    if (!saved.ok) {
      return reply.code(400).send({ ok: false, reason: saved.reason });
    }
    return { ok: true, mediaUrl: saved.mediaUrl, mediaType: mime.toLowerCase().startsWith("video/") ? "video" : "image" };
  });

  app.delete<{ Params: { postId: string } }>("/world/social/post/:postId", async (request, reply) => {
    const q = worldSocialDeletePostQuerySchema.safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({ ok: false, error: q.error.flatten() });
    }
    const { sessionId } = q.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitSocial(sessionId);
    const r = socialFeedService.deletePost(sessionId, request.params.postId);
    if (!r.ok) {
      return reply.code(r.reason === "只能删除本人发布的帖子" ? 403 : 400).send({ ok: false, reason: r.reason });
    }
    return { ok: true };
  });

  app.post("/world/social/report", async (request, reply) => {
    const parsed = worldSocialReportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, postId, reason } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitSocial(sessionId);
    const r = socialFeedService.reportPost(sessionId, postId, reason);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, reason: r.reason });
    }
    return { ok: true, duplicate: r.duplicate === true };
  });
}
