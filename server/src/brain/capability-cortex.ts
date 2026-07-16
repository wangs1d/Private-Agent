// Agent Brain Center — 能力皮层（CapabilityCortex）
// 维护 Agent 能力域注册表，提供自省 / 缺口识别 / 占位扩展能力。
// 规则驱动，不调用任何 LLM。

import type {
  CapabilityDescriptor,
  CapabilityGapReport,
} from "./types.js";
import {
  CAPABILITY_DOMAINS,
  DOMAIN_LABELS,
} from "../agent/agent-capabilities.js";

/**
 * 能力扩展提案：触发 expand() 时传入的最小信息。
 * 实际的 Skill 生成由 EvolutionCortex + SkillGenerator 完成，
 * 这里仅把它登记为 planned 状态的 descriptor。
 */
export type CapabilityExpansionProposal = {
  domain: string;
  label?: string;
  description?: string;
  tools?: string[];
  source?: "builtin" | "skill" | "dynamic";
  rationale?: string;
};

/**
 * 场景关键词 → 期望能力域映射。
 * 用于 identifyGap 的规则匹配：当用户场景文本命中关键词时，
 * 认为该场景期望对应能力域已就绪。
 */
const SCENARIO_KEYWORD_MAP: Array<{
  keywords: string[];
  domains: string[];
}> = [
  {
    keywords: ["旅游", "出行", "出去玩", "行程", "旅游攻略"],
    domains: ["travel_planning"],
  },
  {
    keywords: ["记账", "财务", "支出", "预算"],
    domains: ["finance_deep"],
  },
  {
    keywords: ["代码", "编程", "写脚本", "自动化"],
    domains: ["code_sandbox", "self_programming"],
  },
  {
    keywords: ["天气", "下雨", "气温"],
    domains: ["weather"],
  },
  {
    keywords: ["购物", "下单", "买东西", "淘宝", "京东"],
    domains: ["shopping_order"],
  },
  {
    keywords: ["提醒", "日程", "开会"],
    domains: ["calendar"],
  },
  {
    keywords: ["健康", "运动", "步数", "睡眠"],
    domains: ["health_fitness"],
  },
  {
    keywords: ["邮件", "短信", "发送消息"],
    domains: ["email_sms"],
  },
  {
    keywords: ["图片", "生成图", "画一张"],
    domains: ["image_gen"],
  },
  {
    keywords: ["智能家居", "开灯", "关灯", "空调"],
    domains: ["smart_home"],
  },
];

/**
 * 已知可走 self-programming 扩展的能力域集合。
 * travel_planning / 学习类(notes) / 自动化类(code_sandbox, self_programming)
 * 缺失这些域时，gap 报告会标记 expandable=true。
 */
const EXPANDABLE_DOMAINS = new Set<string>([
  "travel_planning",
  "notes",
  "code_sandbox",
  "self_programming",
]);

/**
 * 能力皮层 —— 维护 Agent 能力域注册表。
 *
 * - 启动时把 agent-capabilities.ts 的 CAPABILITY_DOMAINS / DOMAIN_LABELS
 *   作为初始种子载入内存 registry；
 * - 支持运行时 register / unregister；
 * - identifyGap 基于关键词规则识别场景缺失能力，不依赖 LLM；
 * - expand 仅登记为 planned 状态，真正的 Skill 生成交给 EvolutionCortex。
 */
export class CapabilityCortex {
  /** 能力域 → 描述符 */
  private registry = new Map<string, CapabilityDescriptor>();

  private started = false;

  constructor() {
    this.loadSeed();
  }

  // ---- 生命周期 ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    console.log(
      `[CapabilityCortex] 已启动，已注册能力域数: ${this.registry.size}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    console.log("[CapabilityCortex] 已停止");
  }

  // ---- CapabilityCortexLike 契约 ----------------------------------------

  /**
   * 自省：返回当前 actor 已注册的能力描述符列表。
   * 当前实现不区分 actor（能力域全局共享），直接返回全量快照。
   */
  introspect(actorId: string): CapabilityDescriptor[] {
    // actorId 暂未用于能力过滤，预留以匹配接口契约
    void actorId;
    return this.snapshot();
  }

  // ---- 扩展 API（供 BrainCenter 之外的工具/路由调用） -------------------

  /** 返回所有已注册能力描述符 */
  list(): CapabilityDescriptor[] {
    return Array.from(this.registry.values());
  }

  /** 判断指定能力域是否已注册 */
  has(domain: string): boolean {
    return this.registry.has(domain);
  }

  /** 运行时注册新能力 */
  register(desc: CapabilityDescriptor): void {
    this.registry.set(desc.domain, desc);
  }

  /** 注销能力域，返回是否成功移除 */
  unregister(domain: string): boolean {
    return this.registry.delete(domain);
  }

  /**
   * 快照：给 prompt builder / 工具查询用。
   * 与 list() 等价，可传 actorId（当前全局共享，预留参数）。
   */
  snapshot(actorId?: string): CapabilityDescriptor[] {
    void actorId;
    return this.list();
  }

  /**
   * 识别能力缺口（规则驱动，无 LLM）。
   *
   * 策略：把 scenario 与 SCENARIO_KEYWORD_MAP 逐条匹配，
   * 命中则收集期望能力域，再与现有 registry 对比，
   * 缺失的进 missingDomains，已存在的进 relatedExisting。
   */
  identifyGap(scenario: string): CapabilityGapReport {
    const text = scenario.toLowerCase();
    const expected = new Set<string>();

    for (const entry of SCENARIO_KEYWORD_MAP) {
      const hit = entry.keywords.some((kw) => text.includes(kw.toLowerCase()));
      if (hit) {
        for (const d of entry.domains) expected.add(d);
      }
    }

    const missingDomains: string[] = [];
    const relatedExisting: string[] = [];
    for (const d of expected) {
      if (this.registry.has(d)) {
        relatedExisting.push(d);
      } else {
        missingDomains.push(d);
      }
    }

    const expandable = missingDomains.some((d) => EXPANDABLE_DOMAINS.has(d));

    const rationaleParts: string[] = [];
    if (expected.size === 0) {
      rationaleParts.push("未命中任何已知场景关键词，无法判定期望能力域。");
    } else {
      rationaleParts.push(
        `场景命中期望能力域：${Array.from(expected).join("、")}。`,
      );
      if (missingDomains.length > 0) {
        rationaleParts.push(`缺失：${missingDomains.join("、")}。`);
      }
      if (relatedExisting.length > 0) {
        rationaleParts.push(`已就绪可复用：${relatedExisting.join("、")}。`);
      }
      if (expandable) {
        rationaleParts.push(
          "缺失域属可扩展场景，可走 self-programming 流程生成。",
        );
      }
    }

    return {
      scenario,
      missingDomains,
      relatedExisting,
      expandable,
      rationale: rationaleParts.join(""),
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * 扩展能力（占位实现）。
   *
   * 真正的 Skill 生成在 EvolutionCortex 里通过 SkillGenerator 完成；
   * 这里只把提案登记为 planned 状态的 descriptor 并返回，
   * 使其出现在后续 list / snapshot 中，便于 prompt 与工具查询感知到「规划中」能力。
   */
  expand(proposal: CapabilityExpansionProposal): CapabilityDescriptor {
    const now = new Date().toISOString();
    const descriptor: CapabilityDescriptor = {
      domain: proposal.domain,
      label: proposal.label ?? proposal.domain,
      description: proposal.description,
      tools: proposal.tools ?? [],
      status: "planned",
      source: proposal.source ?? "dynamic",
      registeredAt: now,
    };
    this.register(descriptor);
    return descriptor;
  }

  // ---- 内部工具 ----------------------------------------------------------

  /** 把 agent-capabilities.ts 的种子常量载入 registry */
  private loadSeed(): void {
    const now = new Date().toISOString();
    for (const domain of CAPABILITY_DOMAINS) {
      const label = DOMAIN_LABELS[domain] ?? domain;
      this.registry.set(domain, {
        domain,
        label,
        tools: [],
        status: "active",
        source: "builtin",
        registeredAt: now,
      });
    }
  }
}
