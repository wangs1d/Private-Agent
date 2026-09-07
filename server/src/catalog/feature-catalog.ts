import type { SkillManager } from "../skills/index.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { McpClientService } from "../services/mcp-client-service.js";
import { classifyFeatureByName, classifyMcpTool, isClassifiedByRule, FALLBACK_CLASS } from "./class-map.js";
import {
  LIFE_DOMAINS,
  LIFE_DOMAIN_DESCRIPTIONS,
  LIFE_DOMAIN_LABELS,
  type FeatureSurface,
  type LifeDomain,
  type UnifiedFeature,
} from "./types.js";

/**
 * Feature Catalog —— 能力分类目录（分类视图，不注册能力）。
 *
 * 启动时从三个既有注册表汇聚：
 *   - tool-registry.listMetadata()（已合并 skill 名单）
 *   - skillManager（补 skill 描述）
 *   - mcp-client-service.listTools()（MCP 动态工具）
 * 每个能力打上四维分类标签；未命中映射表的名字记入 unclassified，
 * build() 时 warn（新能力落地漏分类的强制提醒）。
 *
 * 消费方：agent-capabilities（12 域总览）、agent-task-safety（spend/outbound
 * 高危纳管）、tool-search（域级意图规则）、HTTP /api/catalog/*、文档生成。
 */
export class FeatureCatalog {
  private features: UnifiedFeature[] = [];
  private readonly unclassified = new Set<string>();
  private builtAt: string | null = null;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly skillManager?: SkillManager | null,
    private readonly mcpClientService?: McpClientService | null,
  ) {}

  /** 汇聚 + 打标 + 校验（幂等，可重复调用刷新）。 */
  build(): void {
    const merged = new Map<string, UnifiedFeature>();

    // ① tool-registry（list() 已合并启用中的 skill 名单）
    for (const meta of this.toolRegistry.listMetadata()) {
      const name = meta.name;
      if (!name) continue;
      const surface: FeatureSurface = this.skillManager?.get?.(name) != null ? "skill" : "tool";
      merged.set(name, { name, surface, description: this.skillDescription(name) ?? "", cls: classifyFeatureByName(name), classifiedBy: "rule" });
    }

    // ② skill-manager 中未进注册表的 procedural/停用技能也纳入（可见性完整）
    if (this.skillManager) {
      try {
        for (const manifest of this.skillManager.list(false)) {
          const existing = merged.get(manifest.name);
          if (existing) {
            if (!existing.description) existing.description = manifest.description ?? "";
            continue;
          }
          merged.set(manifest.name, {
            name: manifest.name,
            surface: "skill",
            description: manifest.description ?? "",
            cls: classifyFeatureByName(manifest.name),
            classifiedBy: "rule",
          });
        }
      } catch {
        // skillManager 异常不阻断目录构建
      }
    }

    // ③ MCP 动态工具（按 server alias 分类）
    if (this.mcpClientService) {
      try {
        for (const tool of this.mcpClientService.listTools()) {
          merged.set(tool.name, {
            name: tool.name,
            surface: "mcp",
            description: tool.description ?? "",
            cls: classifyMcpTool(tool.name, tool.serverAlias),
            classifiedBy: "rule",
          });
        }
      } catch {
        // MCP 未就绪不阻断
      }
    }

    this.features = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));

    // ④ 校验：未命中映射表的名单独暴露（兜底分类不算已分类）
    this.unclassified.clear();
    for (const feature of this.features) {
      if (feature.surface === "mcp") continue; // MCP alias 表已覆盖，未登记 alias 落 system 属预期
      if (!isClassifiedByRule(feature.name)) {
        this.unclassified.add(feature.name);
        feature.classifiedBy = "fallback";
        feature.cls = { ...FALLBACK_CLASS };
      }
    }
    this.builtAt = new Date().toISOString();

    if (this.unclassified.size > 0) {
      console.warn(
        `[FeatureCatalog] ${this.unclassified.size} 个能力未命中分类映射表（catalog/class-map.ts 需补规则）：\n  ` +
          [...this.unclassified].sort().join("\n  "),
      );
    } else {
      console.log(`[FeatureCatalog] 已分类 ${this.features.length} 个能力（12 域全覆盖，无遗漏）`);
    }
  }

  // ------------------------------------------------------------------ //
  // 查询 API
  // ------------------------------------------------------------------ //

  all(): UnifiedFeature[] {
    return [...this.features];
  }

  byDomain(domain: LifeDomain): UnifiedFeature[] {
    return this.features.filter((f) => f.cls.domain === domain);
  }

  classify(name: string): UnifiedFeature | null {
    return this.features.find((f) => f.name === name) ?? null;
  }

  getUnclassified(): string[] {
    return [...this.unclassified].sort();
  }

  getBuiltAt(): string | null {
    return this.builtAt;
  }

  /** skill 描述（清单里有 handler 被剥掉，原始 description 存在 metadata 面）。 */
  private skillDescription(name: string): string | null {
    if (!this.skillManager) return null;
    try {
      return this.skillManager.get(name)?.description ?? null;
    } catch {
      return null;
    }
  }

  /** 域统计（客户端面板 / query_capabilities 用）。 */
  domainStats(): Array<{ domain: LifeDomain; label: string; description: string; count: number; examples: string[] }> {
    return LIFE_DOMAINS.map((domain) => {
      const features = this.byDomain(domain);
      return {
        domain,
        label: LIFE_DOMAIN_LABELS[domain],
        description: LIFE_DOMAIN_DESCRIPTIONS[domain],
        count: features.length,
        examples: features.slice(0, 5).map((f) => f.name),
      };
    });
  }

  // ------------------------------------------------------------------ //
  // 文本视图（prompt 注入 / 文档生成）
  // ------------------------------------------------------------------ //

  /** prompt 能力总览块：每域一行（域 label + 数量 + 代表工具）。 */
  toPromptLines(): string[] {
    const lines: string[] = ["【能力域总览（生活 12 域 · 自动生成）】"];
    for (const stat of this.domainStats()) {
      if (stat.count === 0) continue;
      const examples = this.byDomain(stat.domain)
        .filter((f) => f.surface !== "mcp")
        .slice(0, 5)
        .map((f) => f.name)
        .join("、");
      lines.push(`· ${stat.label}（${stat.count} 项）：${examples}${stat.count > 5 ? " …" : ""}`);
    }
    lines.push("需要某域完整清单时调用 agent.query_capabilities(domain='<生活域>')。");
    return lines;
  }

  /** Markdown 能力地图（docs/CAPABILITY_MAP.md，CATALOG_WRITE_DOCS=1 时落盘）。 */
  toMarkdown(): string {
    const lines: string[] = [
      "# 能力地图（Feature Catalog 自动生成）",
      "",
      `> 由 \`server/src/catalog\` 在启动时汇聚 tool-registry / skill-manager / MCP 生成；`,
      `> 本文件由 \`CATALOG_WRITE_DOCS=1\` 触发落盘，勿手改。生成时间：${this.builtAt ?? "-"}，共 ${this.features.length} 项能力。`,
      "",
    ];
    for (const stat of this.domainStats()) {
      lines.push(`## ${stat.label}（${stat.domain}）—— ${stat.count} 项`, "");
      lines.push(stat.description, "");
      if (stat.count === 0) {
        lines.push("（暂无能力）", "");
        continue;
      }
      lines.push("| 能力 | 形态 | 动作 | 触发 | 风险 |", "|---|---|---|---|---|");
      for (const f of this.byDomain(stat.domain)) {
        lines.push(`| ${f.name} | ${f.surface} | ${f.cls.action} | ${f.cls.trigger} | ${f.cls.risk} |`);
      }
      lines.push("");
    }
    const unclassified = this.getUnclassified();
    if (unclassified.length > 0) {
      lines.push("## ⚠️ 未分类（需在 catalog/class-map.ts 补规则）", "", ...unclassified.map((n) => `- ${n}`), "");
    }
    return lines.join("\n");
  }
}
