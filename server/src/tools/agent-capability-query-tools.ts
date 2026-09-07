import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { FeatureCatalog } from "../catalog/index.js";
import { LIFE_DOMAINS, LIFE_DOMAIN_LABELS, type LifeDomain } from "../catalog/index.js";

import {
  buildCoreCapabilitySections,
  buildAgentWorldPromptSection,
  CAPABILITY_DOMAINS,
  DOMAIN_LABELS,
  type CapabilityDomain,
} from "../agent/agent-capabilities.js";
import {
  buildAgentAccessModePromptLine,
  parseAgentAccessMode,
} from "../agent/agent-access-mode.js";
import { resolveActorId } from "../agent/actor-id.js";

const VALID_DOMAIN_VALUES = [...CAPABILITY_DOMAINS, "all"] as const;
type ParsedDomain = (typeof VALID_DOMAIN_VALUES)[number];

const ALL_DOMAINS = [...CAPABILITY_DOMAINS] as CapabilityDomain[];

function parseDomain(raw: unknown): ParsedDomain | LifeDomain {
  if (typeof raw === "string") {
    const normalized = raw.toLowerCase().trim();
    if (VALID_DOMAIN_VALUES.includes(normalized as ParsedDomain)) {
      return normalized as ParsedDomain;
    }
    if ((LIFE_DOMAINS as readonly string[]).includes(normalized)) {
      return normalized as LifeDomain;
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
    /** Feature Catalog（未装配时生活域查询返回提示） */
    featureCatalog?: FeatureCatalog | null;
  },
): void {
  toolRegistry.register("agent.query_capabilities", async (input, context) => {
    const actorId = resolveActorId(context);
    const { skillManager, worldService, virtualPhoneService, featureCatalog } = deps;
    const domain = parseDomain(input.domain);

    // ── 生活域查询（Feature Catalog 12 域）──
    if ((LIFE_DOMAINS as readonly string[]).includes(domain as string)) {
      const lifeDomain = domain as LifeDomain;
      if (!featureCatalog) {
        return {
          ok: false,
          error: `生活域（${lifeDomain}）查询需要 Feature Catalog 装配（启动日志检查 [FeatureCatalog]）`,
        };
      }
      const features = featureCatalog.byDomain(lifeDomain);
      const stat = featureCatalog.domainStats().find((s) => s.domain === lifeDomain);
      const parts: string[] = [
        `【能力域 · ${LIFE_DOMAIN_LABELS[lifeDomain]}】${stat?.description ?? ""}（共 ${features.length} 项）`,
        "",
      ];
      for (const f of features) {
        const desc = f.description ? ` —— ${f.description.slice(0, 80)}` : "";
        parts.push(`· ${f.name}（${f.surface}/${f.cls.action}/${f.cls.risk}）${desc}`);
      }
      return {
        ok: true,
        domain: lifeDomain,
        capabilities: parts.join("\n"),
        availableDomains: [...ALL_DOMAINS, ...LIFE_DOMAINS],
        message: `已返回「${LIFE_DOMAIN_LABELS[lifeDomain]}」生活域清单（来自 Feature Catalog）。`,
      };
    }

    const sections = buildCoreCapabilitySections(skillManager, virtualPhoneService, actorId);
    // domain 此处收窄为 CapabilityDomain | "all"
    const capDomain = domain as ParsedDomain;

    const parts: string[] = [];

    const filtered = capDomain === "all"
      ? sections
      : sections.filter((s) => s.domain === capDomain);

    if (filtered.length > 0) {
      const header = capDomain === "all"
        ? "【宿主能力清单】"
        : `【宿主能力 · ${DOMAIN_LABELS[capDomain] || capDomain}】`;
      parts.push(header);

      for (const section of filtered) {
        parts.push(...section.lines);
      }

      if (capDomain !== "all") {
        parts.push("", "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)。");
      } else {
        parts.push("", "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)，见下一节。");
      }
    }

    if (capDomain === "all" && worldService) {
      const worldCaps = buildAgentWorldPromptSection(actorId, worldService, skillManager);
      if (worldCaps) parts.push(worldCaps);
    }

    if (capDomain === "world" && worldService) {
      const worldCaps = buildAgentWorldPromptSection(actorId, worldService, skillManager);
      if (worldCaps) parts.push(worldCaps);
    }

    // 宿主域查询附带 12 生活域总览（all 时），让 agent 知道还有生活域视角
    if (capDomain === "all" && featureCatalog) {
      parts.push("", ...featureCatalog.toPromptLines());
    }

    const accessLine = buildAgentAccessModePromptLine(parseAgentAccessMode(context.agentAccessMode), {
      desktopBridgeOnline: context.desktopBridgeOnline,
      phoneBridgeOnline: context.phoneBridgeOnline,
    });
    if (accessLine) {
      parts.push("", accessLine);
    }

    const resultText = parts.join("\n");

    return {
      ok: true,
      domain: capDomain,
      capabilities: resultText,
      availableDomains: featureCatalog ? [...ALL_DOMAINS, ...LIFE_DOMAINS] : ALL_DOMAINS,
      message: capDomain === "all"
        ? "已返回完整能力清单（含本轮访问权限说明）。"
        : `已返回「${DOMAIN_LABELS[capDomain] || capDomain}」领域的能力描述。如需其他领域，可指定 domain 参数（支持生活域：travel/finance/self 等 12 域）。`,
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
