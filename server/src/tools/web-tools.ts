import type { InfoHubService } from "../services/info-hub-service.js";
import type { UpstreamSearchService } from "../services/upstream-search-service.js";
import type { ToolRegistry } from "./tool-registry.js";

function toBoundedLimit(input: unknown, fallback: number): number {
  const limit = Number(input ?? fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(20, Math.floor(limit)));
}

export function registerWebTools(
  toolRegistry: ToolRegistry,
  infoHubService: InfoHubService,
  upstreamSearchService: UpstreamSearchService,
): void {
  toolRegistry.register("search_web", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 8);
    if (!query) return { provider: "none", items: [], notes: ["query 不能为空"] };
    return upstreamSearchService.searchWeb(query, limit);
  });

  toolRegistry.register("fetch_web", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", content: "", summary: "url 不能为空" };
    return infoHubService.readWebpage(url);
  });

  // Backward compatibility: keep historical aliases on built-in path.
  toolRegistry.register("info.search", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 8);
    if (!query) return { items: [] };
    const items = await infoHubService.search(query, limit);
    return { items };
  });

  toolRegistry.register("info.read_webpage", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", content: "", summary: "url 不能为空" };
    return infoHubService.readWebpage(url);
  });

  toolRegistry.register("info.inspect_webpage", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", summary: "url 不能为空", contentPreview: "", links: [], sameHostLinks: [] };
    return infoHubService.inspectWebpage(url);
  });

  toolRegistry.register("info.navigate_site", async (input) => {
    const startUrl = String(input.startUrl ?? "").trim();
    if (!startUrl) return { ok: false, error: "startUrl 不能为空" };
    const goalKeywords = Array.isArray(input.goalKeywords)
      ? input.goalKeywords.map((k) => String(k).trim()).filter(Boolean)
      : undefined;
    const maxDepth = Number(input.maxDepth);
    const maxPages = Number(input.maxPages);
    const sameHostOnly = input.sameHostOnly !== false;
    return infoHubService.navigateSite({
      startUrl,
      goalKeywords,
      maxDepth: Number.isFinite(maxDepth) ? maxDepth : undefined,
      maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
      sameHostOnly,
    });
  });
}
