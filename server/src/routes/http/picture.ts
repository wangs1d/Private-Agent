import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { PictureKit, ImageAsset, ThumbnailSize } from "@private-ai-agent/picture";

/**
 * 图片图库 HTTP 路由(供客户端图库页使用):
 *   - GET    /picture/assets                      资产列表(分页/标签筛选)
 *   - GET    /picture/assets/:id/thumbnail/:size  缩略图(small/medium/large, webp)
 *   - GET    /picture/assets/:id/file             原资产文件
 *   - POST   /picture/assets                      multipart 上传入库
 *   - DELETE /picture/assets/:id                  删除照片(连源文件与缩略图)
 *
 * 资产路径均来自索引内存值,不存在路径穿越风险;缩略图命中即走长缓存。
 */
const MIME_BY_EXT: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".tiff": "image/tiff",
};

function assetSummary(asset: ImageAsset): Record<string, unknown> {
  return {
    id: asset.id,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    fileSize: asset.fileSize,
    tags: asset.tags,
    rating: asset.rating,
    sceneType: asset.sceneType,
    takenAt: asset.takenAt,
    createdAt: asset.createdAt,
    thumbnailUrl: `/picture/assets/${asset.id}/thumbnail/small`,
    previewUrl: `/picture/assets/${asset.id}/thumbnail/medium`,
    imageUrl: `/picture/assets/${asset.id}/file`,
  };
}

export function registerPictureRoutes(app: FastifyInstance, deps: { pictureKit: PictureKit }): void {
  const { pictureKit } = deps;

  app.get("/picture/assets", async (request) => {
    const query = request.query as Record<string, unknown>;
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const pageSize = Math.min(60, Math.max(1, Number(query.pageSize ?? 30) || 30));
    const tag = typeof query.tag === "string" && query.tag ? query.tag : undefined;
    const result = await pictureKit.store.query({
      filters: tag ? { tags: [tag] } : undefined,
      page,
      pageSize,
    });
    return {
      ok: true,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      photos: result.items.map(assetSummary),
    };
  });

  app.get<{ Params: { id: string; size: string } }>(
    "/picture/assets/:id/thumbnail/:size",
    async (request, reply) => {
      const { id, size } = request.params;
      if (size !== "small" && size !== "medium" && size !== "large") {
        return reply.code(400).send({ ok: false, reason: "INVALID_SIZE" });
      }
      const asset = pictureKit.store.get(id);
      if (!asset) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      const thumbPath = pictureKit.thumbnails.get(id, size as ThumbnailSize);
      if (!thumbPath) {
        return reply.code(404).send({ ok: false, reason: "NO_THUMBNAIL" });
      }
      void reply.header("Content-Type", "image/webp");
      void reply.header("Cache-Control", "public, max-age=604800");
      return reply.send(createReadStream(thumbPath));
    },
  );

  app.get<{ Params: { id: string } }>("/picture/assets/:id/file", async (request, reply) => {
    const { id } = request.params;
    const asset = pictureKit.store.get(id);
    if (!asset) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    const ext = asset.filePath.slice(asset.filePath.lastIndexOf(".")).toLowerCase();
    void reply.header("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
    void reply.header("Cache-Control", "public, max-age=604800");
    return reply.send(createReadStream(asset.filePath));
  });

  app.post("/picture/assets", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ ok: false, error: "缺少 multipart 文件字段 file" });
    }
    const buffer = await file.toBuffer();
    if (buffer.length === 0) {
      return reply.code(400).send({ ok: false, error: "文件为空" });
    }
    try {
      const { asset, deduplicated } = await pictureKit.store.ingest(buffer, {
        fileName: file.filename || undefined,
      });
      return { ok: true, deduplicated, photo: assetSummary(asset) };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "不支持的图片格式",
      });
    }
  });

  app.delete<{ Params: { id: string } }>("/picture/assets/:id", async (request, reply) => {
    const { id } = request.params;
    const asset = pictureKit.store.get(id);
    if (!asset) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    const removed = await pictureKit.store.remove(id, { deleteFiles: true });
    if (!removed) {
      return reply.code(500).send({ ok: false, reason: "REMOVE_FAILED" });
    }
    return { ok: true, id };
  });

  app.get("/picture", async () => ({
    domain: "picture",
    endpoints: [
      "GET /picture/assets?page=&pageSize=&tag=",
      "GET /picture/assets/:id/thumbnail/:size",
      "GET /picture/assets/:id/file",
      "POST /picture/assets (multipart: file)",
      "DELETE /picture/assets/:id",
    ],
  }));
}
