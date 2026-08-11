import type { BrainCenter } from "../../brain/index.js";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import { buildToolRankingHintFromProfile } from "../../services/evolution-tool-ranking.js";
import type { AgentStreamOptions } from "../../external-model/types.js";
import type { LlmExecutionMode } from "../task-router.js";

export type ToolPolicyResolverDeps = {
  agentMemorySyncService: AgentMemorySyncService | null;
  getBrainCenter: () => BrainCenter | null;
};

export class ToolPolicyResolver {
  constructor(private readonly deps: ToolPolicyResolverDeps) {}

  resolveExposureProfile(mode: LlmExecutionMode): AgentStreamOptions["toolExposureProfile"] {
    return mode === "complex" ? "delegate" : "contextual";
  }

  resolveRankingHint(actorId: string): AgentStreamOptions["toolRankingHint"] {
    // 兼容迁移：新 key evolution_profile 优先，旧 key hermes_profile 兜底（历史数据）
    const entries = this.deps.agentMemorySyncService?.getSnapshot(actorId, [
      "evolution_profile",
      "hermes_profile",
    ]).entries;
    const profile = entries?.evolution_profile ?? entries?.hermes_profile;
    const hint = buildToolRankingHintFromProfile(profile);
    const cautiousNamespaces = this.resolveCautiousNamespaces(actorId);
    if (cautiousNamespaces.length === 0) return hint;

    return {
      ...(hint ?? {}),
      cautiousNamespaces: [
        ...new Set([
          ...(hint?.cautiousNamespaces ?? []),
          ...cautiousNamespaces,
        ]),
      ],
    };
  }

  private resolveCautiousNamespaces(actorId: string): string[] {
    const snapshot = this.deps.getBrainCenter()?.getLearningSnapshot(actorId);
    if (!snapshot) return [];

    const namespaces = new Set<string>();
    for (const belief of snapshot.beliefs) {
      if (belief.status === "deprecated") continue;
      if (belief.failureCount <= belief.successCount) continue;
      if (!/tool|using|risky|failed|failure/i.test(belief.claim)) continue;

      const match = belief.claim.match(/\busing\s+(.+?)\s+is\s+risky\b/i);
      const rawTools = match?.[1] ?? "";
      for (const toolName of rawTools.split(",")) {
        const namespace = this.pickNamespace(toolName.trim());
        if (namespace) namespaces.add(namespace);
      }
      if (namespaces.size >= 4) break;
    }
    return [...namespaces];
  }

  private pickNamespace(toolName: string): string | null {
    if (!toolName) return null;
    const dotIndex = toolName.indexOf(".");
    if (dotIndex > 0) return toolName.slice(0, dotIndex);
    const underscoreIndex = toolName.indexOf("_");
    if (underscoreIndex > 0) return toolName.slice(0, underscoreIndex);
    return toolName === "unknown" ? null : "misc";
  }
}
