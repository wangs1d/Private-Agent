function envBool(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultOn;
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  return true;
}

export function isTokenJuiceEnabled(): boolean {
  return envBool("AGENT_TOKENJUICE_ENABLED", true);
}

export function getTokenJuiceMaxToolChars(): number {
  const raw = process.env.AGENT_TOKENJUICE_MAX_TOOL_CHARS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 4_000;
  return Number.isFinite(n) && n > 200 ? n : 4_000;
}
