function envBool(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultOn;
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  return true;
}

/** UAP `memory_summary` 追加模式：`minimal` 时跳过 KV 流水（细节由 Mem0 记忆图承担）。默认 minimal。 */
export function getKvSummaryAppendMode(): "full" | "minimal" {
  const raw = process.env.AGENT_KV_SUMMARY_APPEND_MODE?.trim().toLowerCase();
  if (!raw) return "minimal";
  return raw === "full" ? "full" : "minimal";
}

export function isKvSummaryMinimal(): boolean {
  return getKvSummaryAppendMode() === "minimal";
}

export { envBool };
