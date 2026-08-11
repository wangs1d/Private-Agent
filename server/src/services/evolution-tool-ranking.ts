import type { ToolRankingHint } from "../external-model/types.js";

type HermesNamespaceOutcome = {
  success: number;
  failure: number;
};

type HermesProfileLike = {
  toolNamespaces?: Record<string, unknown>;
  toolNamespaceOutcomes?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function parseNamespaceOutcomes(raw: unknown): Map<string, HermesNamespaceOutcome> {
  if (!isObject(raw)) return new Map();
  const outcomes = new Map<string, HermesNamespaceOutcome>();
  for (const [namespace, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const success = asCount(value.success);
    const failure = asCount(value.failure);
    if (success <= 0 && failure <= 0) continue;
    outcomes.set(namespace, { success, failure });
  }
  return outcomes;
}

function scoreNamespace(
  namespace: string,
  totalCalls: number,
  outcomes: Map<string, HermesNamespaceOutcome>,
): number {
  const outcome = outcomes.get(namespace);
  if (!outcome) return totalCalls;
  const attempts = outcome.success + outcome.failure;
  if (attempts <= 0) return totalCalls;
  const successRate = outcome.success / attempts;
  return outcome.success * 2 + totalCalls * 0.15 + successRate * 3 - outcome.failure * 0.5;
}

export function buildToolRankingHintFromHermesProfile(
  profile: unknown,
  maxNamespaces = 6,
): ToolRankingHint | undefined {
  if (!isObject(profile)) return undefined;
  const shaped = profile as HermesProfileLike;
  const namespacesRaw = isObject(shaped.toolNamespaces) ? shaped.toolNamespaces : {};
  const outcomes = parseNamespaceOutcomes(shaped.toolNamespaceOutcomes);

  const preferredNamespaces = Object.entries(namespacesRaw)
    .map(([name, count]) => ({
      name,
      totalCalls: asCount(count),
    }))
    .filter((entry) => entry.totalCalls > 0)
    .sort((a, b) => {
      const scoreDiff =
        scoreNamespace(b.name, b.totalCalls, outcomes) -
        scoreNamespace(a.name, a.totalCalls, outcomes);
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return b.totalCalls - a.totalCalls || a.name.localeCompare(b.name);
    })
    .slice(0, maxNamespaces)
    .map((entry) => entry.name);

  return preferredNamespaces.length > 0 ? { preferredNamespaces } : undefined;
}
