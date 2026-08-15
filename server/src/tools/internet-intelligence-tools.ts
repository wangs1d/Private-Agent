import type {
  InternetDepth,
  InternetIntelligenceService,
  InternetTimeWindow,
} from "../services/internet-intelligence-service.js";
import type { ToolRegistry } from "./tool-registry.js";

function depth(input: unknown): InternetDepth | undefined {
  return input === "quick" || input === "normal" || input === "deep" ? input : undefined;
}

function timeWindow(input: unknown): InternetTimeWindow | undefined {
  return input === "15m" || input === "1h" || input === "6h" || input === "24h" || input === "7d"
    ? input
    : undefined;
}

function boundedInt(input: unknown): number | undefined {
  const n = Number(input);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

function optionalNumber(input: unknown): number | undefined {
  const n = Number(input);
  return Number.isFinite(n) ? n : undefined;
}

export function registerInternetIntelligenceTools(
  registry: ToolRegistry,
  internet: InternetIntelligenceService,
): void {
  registry.register(
    "internet.research",
    async (input) =>
      internet.research({
        goal: String(input.goal ?? "").trim(),
        depth: depth(input.depth),
        timeWindow: timeWindow(input.timeWindow),
        maxEvidence: boundedInt(input.maxEvidence),
        fetchTopPages: typeof input.fetchTopPages === "boolean" ? input.fetchTopPages : undefined,
      }) as unknown as Record<string, unknown>,
    {
      category: "web",
      sideEffect: "read",
      riskLevel: "low",
      cachePolicy: { enabled: true, ttlMs: 90_000 },
      alternatives: ["search_web", "fetch_web"],
    },
  );

  registry.register(
    "internet.live_check",
    async (input, context) =>
      internet.liveCheck(
        {
          target: String(input.target ?? input.goal ?? "").trim(),
          goal: String(input.goal ?? input.target ?? "").trim(),
          locationName: input.locationName != null ? String(input.locationName).trim() : undefined,
          latitude: optionalNumber(input.latitude),
          longitude: optionalNumber(input.longitude),
          timezone: input.timezone != null ? String(input.timezone).trim() : undefined,
          depth: depth(input.depth),
          timeWindow: timeWindow(input.timeWindow),
          maxEvidence: boundedInt(input.maxEvidence),
        },
        context,
      ) as unknown as Record<string, unknown>,
    {
      category: "web",
      sideEffect: "read",
      riskLevel: "low",
      cachePolicy: { enabled: true, ttlMs: 45_000 },
      alternatives: ["weather.get_local", "search_web"],
    },
  );

  registry.register(
    "internet.verify",
    async (input) =>
      internet.verify({
        claim: String(input.claim ?? "").trim(),
        depth: depth(input.depth),
        maxEvidence: boundedInt(input.maxEvidence),
      }) as unknown as Record<string, unknown>,
    {
      category: "web",
      sideEffect: "read",
      riskLevel: "low",
      cachePolicy: { enabled: true, ttlMs: 90_000 },
      alternatives: ["search_web"],
    },
  );
}
