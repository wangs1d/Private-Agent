import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const standaloneDir = dirname(fileURLToPath(import.meta.url));
const webRootCandidates = [
  resolve(standaloneDir, "..", "web"),
  resolve(standaloneDir, "..", "..", "web"),
];
const webRoot =
  webRootCandidates.find((dir) => existsSync(join(dir, "index.html"))) ??
  webRootCandidates[0];
const assetsRoot = resolve(webRoot, "assets");

/** 同源观战 SPA：`/`、`/assets/*`（在 API 路由之后注册）。 */
export function registerStandaloneWebUi(app: FastifyInstance): void {
  app.get("/", async (_req, reply) => {
    void reply.type("text/html; charset=utf-8");
    return readFileSync(join(webRoot, "index.html"), "utf8");
  });

  app.get<{ Params: { file: string } }>("/assets/:file", async (req, reply) => {
    const raw = req.params.file;
    if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
      return reply.code(400).send("Invalid path");
    }
    const full = resolve(assetsRoot, raw);
    if (!full.startsWith(assetsRoot)) {
      return reply.code(400).send("Invalid path");
    }
    if (!existsSync(full)) {
      return reply.code(404).send("Not found");
    }
    const lower = raw.toLowerCase();
    if (lower.endsWith(".css")) void reply.type("text/css; charset=utf-8");
    else if (lower.endsWith(".js")) void reply.type("application/javascript; charset=utf-8");
    return readFileSync(full);
  });
}
