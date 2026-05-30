export type ToolSearchEnabledMode = "auto" | "on" | "off";

function parseEnabledMode(raw: string | undefined): ToolSearchEnabledMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  return "auto";
}

export function getToolSearchConfig() {
  return {
    enabled: parseEnabledMode(process.env.AGENT_TOOL_SEARCH_ENABLED),
    thresholdPct: clampInt(process.env.AGENT_TOOL_SEARCH_THRESHOLD_PCT, 10, 0, 100),
    searchDefaultLimit: clampInt(process.env.AGENT_TOOL_SEARCH_DEFAULT_LIMIT, 5, 1, 50),
    maxSearchLimit: clampInt(process.env.AGENT_TOOL_SEARCH_MAX_LIMIT, 20, 1, 50),
    contextTokens: clampInt(process.env.AGENT_TOOL_SEARCH_CONTEXT_TOKENS, 32_000, 2_000, 2_000_000),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
