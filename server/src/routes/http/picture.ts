import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { PictureKit, ImageAsset, ThumbnailSize } from "@private-ai-agent/picture";
import { listBeautyStyles } from "@private-ai-agent/picture";

/**
 * 图片图库/美颜批图 HTTP 路由(供客户端图库页使用):
 *   - GET    /picture/assets                      资产列表(分页/标签筛选)
 *   - GET    /picture/assets/:id/thumbnail/:size  缩略图(small/medium/large, webp)
 *   - GET    /picture/assets/:id/file             原资产文件
 *   - POST   /picture/assets                      multipart 上传入库
 *   - POST   /picture/beautify                    一键美颜批图(产物存回图库)
 *   - GET    /picture/styles                      可用美颜风格列表
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

  app.post<{ Body: { assetIds?: string[]; style?: string; adjustments?: Record<string, number> } }>(
    "/picture/beautify",
    async (request, reply) => {
      const body = request.body ?? {};
      const style = typeof body.style === "string" && body.style ? body.style : undefined;
      const adjustments =
        body.adjustments && typeof body.adjustments === "object" ? body.adjustments : undefined;
      if (!style && !adjustments) {
        return reply.code(400).send({ ok: false, error: "请指定 style 或 adjustments" });
      }
      let assetIds = Array.isArray(body.assetIds) ? body.assetIds : [];
      if (assetIds.length === 0) {
        const latest = await pictureKit.store.query({ pageSize: 1 });
        assetIds = latest.items.map((asset) => asset.id);
        if (assetIds.length === 0) {
          return reply.code(400).send({ ok: false, error: "图库为空" });
        }
      }
      const sources = assetIds
        .map((id) => pictureKit.store.get(id))
        .filter((asset): asset is ImageAsset => asset !== null);
      if (sources.length === 0) {
        return reply.code(404).send({ ok: false, error: "照片不存在" });
      }
      try {
        const result = await pictureKit.batch.processPhotos({
          photoPaths: sources.map((asset) => asset.filePath),
          style,
          adjustments,
        });
        const photos: Array<Record<string, unknown>> = [];
        for (const [index, outputPath] of result.outputPaths.entries()) {
          const source = sources[index]!;
          const { asset } = await pictureKit.store.ingest(outputPath, {
            fileName: `beautified_${source.fileName.replace(/\.[^.]+$/, "")}.webp`,
            tags: ["beautified", ...(style ? [style] : [])],
            sceneType: source.sceneType ?? undefined,
          });
          photos.push({ sourceId: source.id, ...assetSummary(asset) });
        }
        return { ok: true, count: photos.length, style: style ?? "custom", appliedAdjustments: result.appliedAdjustments, photos };
      } catch (error) {
        return reply.code(500).send({
          ok: false,
          error: error instanceof Error ? error.message : "美颜处理失败",
        });
      }
    },
  );

  app.get("/picture/styles", async () => ({
    ok: true,
    styles: listBeautyStyles(),
  }));

  app.get("/picture", async () => ({
    domain: "picture",
    endpoints: [
      "GET /picture/assets?page=&pageSize=&tag=",
      "GET /picture/assets/:id/thumbnail/:size",
      "GET /picture/assets/:id/file",
      "POST /picture/assets (multipart: file)",
      "POST /picture/beautify {assetIds?, style?, adjustments?}",
      "GET /picture/styles",
    ],
  }));
}
