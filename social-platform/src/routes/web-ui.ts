import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const publicDir = join(process.cwd(), "public");

export function registerSocialWebUi(app: FastifyInstance): void {
  const indexPath = join(publicDir, "index.html");
  if (!existsSync(indexPath)) return;

  app.get("/", async (_req, reply) => {
    void reply.type("text/html; charset=utf-8");
    return readFileSync(indexPath, "utf8");
  });
}
