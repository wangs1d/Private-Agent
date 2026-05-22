import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const routesDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(routesDir, "../../../web/chat");

/** 浏览器 Accept 含 text/html 时返回聊天页 HTML（与 `GET /chat` JSON 元数据共用路径）。 */
export function prefersChatWebHtml(accept: string | undefined): boolean {
  if (!accept?.trim()) return false;
  const parts = accept.split(",").map((p) => p.trim().toLowerCase());
  let htmlQ = 0;
  let jsonQ = 0;
  for (const part of parts) {
    const [mime, ...params] = part.split(";").map((s) => s.trim());
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((s) => s.trim());
      if (key === "q" && value) {
        const parsed = Number.parseFloat(value);
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    if (mime === "text/html" || mime === "text/*") htmlQ = Math.max(htmlQ, q);
    if (mime === "application/json" || mime === "application/*") jsonQ = Math.max(jsonQ, q);
  }
  if (htmlQ <= 0) return false;
  return htmlQ >= jsonQ;
}

export function readChatWebIndexHtml(): string {
  return readFileSync(join(webRoot, "index.html"), "utf8");
}

/**
 * 浏览器聊天静态资源：`/chat/assets/*`（页面本体由 `GET /chat` 按 Accept 分流）。
 */
export function registerChatWeb(app: FastifyInstance): void {
  app.get<{ Params: { file: string } }>("/chat/assets/:file", async (req, reply) => {
    const raw = req.params.file;
    if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
      return reply.code(400).send("Invalid path");
    }
    const full = resolve(webRoot, raw);
    if (!full.startsWith(webRoot) || !existsSync(full)) {
      return reply.code(404).send("Not found");
    }
    const lower = raw.toLowerCase();
    if (lower.endsWith(".css")) void reply.type("text/css; charset=utf-8");
    else if (lower.endsWith(".js")) void reply.type("application/javascript; charset=utf-8");
    return readFileSync(full);
  });
}
