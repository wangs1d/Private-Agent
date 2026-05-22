import { getAgentRuntimeConfig } from "./agent-runtime-config.js";

function envTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "0" || v === "off" || v === "false" || v === "no") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Whether the master Agent sub-agent delegation coordinator is enabled. */
export function isMasterAgentDelegationEnabled(): boolean {
  return getAgentRuntimeConfig().masterDelegation.enabled;
}

/** Whether master Agent delegation emits verbose diagnostics. */
export function isMasterAgentDelegationVerbose(): boolean {
  return getAgentRuntimeConfig().masterDelegation.verbose;
}

export function envTruthyHelper(raw: string | undefined): boolean {
  return envTruthy(raw);
}
