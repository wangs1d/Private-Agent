import type { FastifyInstance } from "fastify";

import type { ImageGenerationService } from "../../services/image-generation-service.js";

/**
 * 图像生成静态拉流路由：
 *   - `GET /agent/images/:actorId/:fileName`  静态拉取生成的图片（PNG）
 *
 * 与 voice-messages 路由同模式：
 *   - 文件名严格校验防穿越
 *   - 长缓存（生成的图片不可变）
 */
export function registerImageFileRoutes(
  app: FastifyInstance,
  deps: { imageGenerationService: ImageGenerationService },
): void {
  app.get<{ Params: { actorId: string; fileName: string } }>(
    "/agent/images/:actorId/:fileName",
    async (request, reply) => {
      const { actorId, fileName } = request.params;
      const fullPath = deps.imageGenerationService.resolveFilePath(actorId, fileName);
      if (!fullPath) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      const exists = await deps.imageGenerationService.fileExists(fullPath);
      if (!exists) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      void reply.header("Content-Type", "image/png");
      void reply.header("Cache-Control", "public, max-age=2592000, immutable");
      void reply.header("Accept-Ranges", "bytes");
      return reply.send(deps.imageGenerationService.createReadStream(fullPath));
    },
  );
}
