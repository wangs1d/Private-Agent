import type { FastifyInstance } from "fastify";

import { FileProcessingService } from "../../services/file-processing-service.js";

/**
 * 用户文件静态拉流路由：
 *   - `GET /agent/files/:actorId/:fileName`  静态拉取 file.write_text / file.export_format 落盘的文件
 *
 * 与 voice-messages / image-files 路由同模式：
 *   - 文件名严格校验（仅字母/数字/下划线/连字符/点号）防穿越
 *   - 短缓存（用户文件可能被同名覆盖写）
 *   - Content-Type 按扩展名推断
 */
export function registerUserFileRoutes(
  app: FastifyInstance,
  deps: { fileProcessingService: FileProcessingService },
): void {
  app.get<{ Params: { actorId: string; fileName: string } }>(
    "/agent/files/:actorId/:fileName",
    async (request, reply) => {
      const { actorId, fileName } = request.params;
      const fullPath = deps.fileProcessingService.resolveFilePath(actorId, fileName);
      if (!fullPath) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      void reply.header("Content-Type", FileProcessingService.guessContentType(fileName));
      // 用户文件可能被同名覆盖写，使用短缓存 + must-revalidate
      void reply.header("Cache-Control", "public, max-age=60, must-revalidate");
      void reply.header("Accept-Ranges", "bytes");
      return reply.send(deps.fileProcessingService.createReadStream(fullPath));
    },
  );
}
