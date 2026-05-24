import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ToolRegistry } from "./tool-registry.js";

import {
  buildCoreCapabilitySections,
  buildAgentWorldPromptSection,
  CAPABILITY_DOMAINS,
  DOMAIN_LABELS,
  type CapabilityDomain,
} from "../agent/agent-capabilities.js";
import { resolveActorId } from "../agent/actor-id.js";

const VALID_DOMAIN_VALUES = [...CAPABILITY_DOMAINS, "all"] as const;
type ParsedDomain = (typeof VALID_DOMAIN_VALUES)[number];

const ALL_DOMAINS = [...CAPABILITY_DOMAINS] as CapabilityDomain[];

function parseDomain(raw: unknown): ParsedDomain {
  if (typeof raw === "string") {
    const normalized = raw.toLowerCase().trim();
    if (VALID_DOMAIN_VALUES.includes(normalized as ParsedDomain)) {
      return normalized as ParsedDomain;
    }
  }
  return "all";
}

export function registerCapabilityQueryTools(
  toolRegistry: ToolRegistry,
  deps: {
    skillManager: SkillManager;
    worldService: WorldService | null;
    virtualPhoneService?: VirtualPhoneService;
  },
): void {
  toolRegistry.register("agent.query_capabilities", async (input, context) => {
    const actorId = resolveActorId(context);
    const { skillManager, worldService, virtualPhoneService } = deps;
    const domain = parseDomain(input.domain);

    const sections = buildCoreCapabilitySections(skillManager, virtualPhoneService, actorId);

    const parts: string[] = [];

    const filtered = domain === "all"
      ? sections
      : sections.filter((s) => s.domain === domain);

    if (filtered.length > 0) {
      const header = domain === "all"
        ? "【宿主能力清单】"
        : `【宿主能力 · ${DOMAIN_LABELS[domain] || domain}】`;
      parts.push(header);

      for (const section of filtered) {
        parts.push(...section.lines);
      }

      if (domain !== "all") {
        parts.push("", "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)。");
      } else {
        parts.push("", "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)，见下一节。");
      }
    }

    if (domain === "all" && worldService) {
      const worldCaps = buildAgentWorldPromptSection(actorId, worldService, skillManager);
      if (worldCaps) parts.push(worldCaps);
    }

    if (domain === "world" && worldService) {
      const worldCaps = buildAgentWorldPromptSection(actorId, worldService, skillManager);
      if (worldCaps) parts.push(worldCaps);
    }

    const resultText = parts.join("\n");

    return {
      ok: true,
      domain,
      capabilities: resultText,
      availableDomains: ALL_DOMAINS,
      message: domain === "all"
        ? "已返回完整能力清单。"
        : `已返回「${DOMAIN_LABELS[domain] || domain}」领域的能力描述。如需其他领域，可指定 domain 参数。`,
    };
  });
}

export function buildScopedCapabilityPromptForSubAgent(
  skillManager: SkillManager,
  virtualPhoneService: VirtualPhoneService | undefined,
  actorId: string,
  relevantDomains: CapabilityDomain[],
): string {
  const sections = buildCoreCapabilitySections(skillManager, virtualPhoneService, actorId);
  const relevant = sections.filter((s) => relevantDomains.includes(s.domain));

  if (relevant.length === 0) return "";

  const lines: string[] = ["【你的相关能力】"];
  for (const section of relevant) {
    lines.push(...section.lines);
  }
  lines.push("其他能力请调用 agent.query_capabilities(domain=...) 查询。");
  return lines.join("\n");
}
