import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  getToolIntentMetadataState,
  reloadToolIntentMetadata,
} from "../../tools/tool-search/intent-metadata.js";

function adminToken(): string {
  return process.env.ADMIN_UPLOAD_TOKEN ?? "admin-upload-secret";
}

function checkAdmin(req: FastifyRequest): boolean {
  const token = req.headers["x-admin-token"] as string | undefined;
  return token === adminToken();
}

export function registerToolSearchAdminRoutes(app: FastifyInstance): void {
  app.get("/api/admin/tool-search/intent-metadata", async (req, reply) => {
    if (!checkAdmin(req)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    return reply.send({ ok: true, ...getToolIntentMetadataState() });
  });

  app.post("/api/admin/tool-search/intent-metadata/reload", async (req, reply) => {
    if (!checkAdmin(req)) {
      return reply.code(401).send("Unauthorized: invalid admin token");
    }
    return reply.send({ ok: true, ...reloadToolIntentMetadata() });
  });
}
