import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink, rename } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";

import { adminAudit, requireAdmin } from "./admin-auth.js";

/**
 * 下载文件存储目录。
 * 优先级：环境变量 DOWNLOADS_DIR → 容器内 /app/downloads → 开发时 ../downloads
 */
function downloadsDir(): string {
  if (process.env.DOWNLOADS_DIR) return resolve(process.env.DOWNLOADS_DIR);
  // Docker 容器内默认路径
  if (process.env.NODE_ENV === "production") return resolve("/app/downloads");
  return resolve(import.meta.dirname ?? __dirname, "../../../downloads");
}

/** 安全文件名 */
function safeName(raw: string): string {
  const base = basename(raw);
  // 只保留字母数字中文点和常用扩展名分隔符
  return base.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, "_").slice(0, 120);
}

export function registerDownloadRoutes(app: FastifyInstance): void {
  const dir = downloadsDir();

  /** GET /api/admin/downloads/list — 列出可下载文件 */
  app.get("/api/admin/downloads/list", { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      await mkdir(dir, { recursive: true });
      const entries = await readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile())
          .map(async (e) => {
            const s = await stat(join(dir, e.name));
            return {
              file: e.name,
              name: e.name,
              size: s.size,
              modified: s.mtime.toISOString().slice(0, 10),
            };
          }),
      );
      files.sort((a, b) => b.modified.localeCompare(a.modified));
      return reply.send(files);
    } catch (err) {
      app.log.error(err, "downloads list failed");
      return reply.code(500).send("Failed to list downloads");
    }
  });

  /** POST /api/admin/downloads/upload — 上传桌面应用文件 */
  app.post("/api/admin/downloads/upload", { preHandler: requireAdmin }, async (req, reply) => {
    const data = await req.file();
    if (!data) {
      return reply.code(400).send("No file provided");
    }

    // 允许的扩展名
    const allowedExt = [".exe", ".zip", ".dmg", ".msi", ".apk", ".app", ".tar.gz", ".deb", ".rpm"];
    const ext = data.filename.toLowerCase();
    const isAllowed = allowedExt.some((a) => ext.endsWith(a));
    if (!isAllowed) {
      return reply.code(400).send(`File type not allowed. Allowed: ${allowedExt.join(", ")}`);
    }

    try {
      await mkdir(dir, { recursive: true });

      // 使用 fields 中的 name 或原始文件名
      const displayName = (data.fields?.name as any)?.value as string | undefined;
      const baseName = displayName ? safeName(displayName) : safeName(data.filename);
      const finalName = baseName;

      const tempPath = join(dir, `.upload_${Date.now()}_${finalName}`);
      const targetPath = join(dir, finalName);

      await pipeline(data.file, createWriteStream(tempPath));

      // 如果目标文件已存在，先删除
      try {
        await unlink(targetPath);
      } catch {
        // 不存在则忽略
      }

      await rename(tempPath, targetPath);

      const size = (await stat(targetPath)).size;
      app.log.info(`download uploaded: ${finalName} (${size} bytes)`);
      await adminAudit("downloads.upload", { file: finalName, size }, req);
      return reply.send({ ok: true, file: finalName, url: `/downloads/${encodeURIComponent(finalName)}` });
    } catch (err) {
      app.log.error(err, "download upload failed");
      return reply.code(500).send("Upload failed");
    }
  });

  /** DELETE /api/admin/downloads/:file — 删除文件 */
  app.delete<{ Params: { file: string } }>(
    "/api/admin/downloads/:file",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const name = safeName(req.params.file);
      const path = join(dir, name);

      try {
        await unlink(path);
        app.log.info(`download deleted: ${name}`);
        await adminAudit("downloads.delete", { file: name }, req);
        return reply.send({ ok: true });
      } catch {
        return reply.code(404).send("File not found");
      }
    },
  );
}
