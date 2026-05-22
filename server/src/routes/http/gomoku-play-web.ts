import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const routesDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(routesDir, "../../../web/gomoku");
const assetsRoot = join(webRoot, "assets");

/**
 * 用户与 Agent 五子棋对战页（非 Agent World 观战 SPA）。
 * playUrl：`/play/gomoku/{tableId}`
 */
export function registerGomokuPlayWeb(app: FastifyInstance): void {
  app.get<{ Params: { file: string } }>("/play/gomoku/assets/:file", async (req, reply) => {
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

  app.get("/play/gomoku", async (_req, reply) => {
    void reply.type("text/html; charset=utf-8");
    return readFileSync(join(webRoot, "index.html"), "utf8");
  });

  app.get<{ Params: { tableId: string } }>("/play/gomoku/:tableId", async (req, reply) => {
    const { tableId } = req.params;
    if (!/^gomoku_[a-f0-9]+$/i.test(tableId)) {
      return reply.code(404).send("Not found");
    }
    void reply.type("text/html; charset=utf-8");
    return readFileSync(join(webRoot, "index.html"), "utf8");
  });
}
