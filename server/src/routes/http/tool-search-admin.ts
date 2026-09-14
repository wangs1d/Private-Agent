import type { FastifyInstance } from "fastify";

import { adminAudit, requireAdmin } from "./admin-auth.js";
import {
  getToolIntentMetadataState,
  reloadToolIntentMetadata,
} from "../../tools/tool-search/intent-metadata.js";

export function registerToolSearchAdminRoutes(app: FastifyInstance): void {
  app.get("/api/admin/tool-search/intent-metadata", { preHandler: requireAdmin }, async () => {
    return { ok: true, ...getToolIntentMetadataState() };
  });

  app.post("/api/admin/tool-search/intent-metadata/reload", { preHandler: requireAdmin }, async (req) => {
    await adminAudit("tool_search.reload_intent_metadata", {}, req);
    return { ok: true, ...reloadToolIntentMetadata() };
  });
}
