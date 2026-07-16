/**
 * 子 Agent 能力注册中心（配置驱动 + 运行时可注册）
 *
 * 设计目标：
 * 1. 减少硬编码：把原本散落在多处的 per-type 配置合并为单一数据源
 *    - initializeSubAgentCapabilities() 里的元数据（name/description/keywords/tools/capabilities）
 *    - SUB_AGENT_MAX_ROUNDS（Record<SubAgentType, number>）
 *    - getSubAgentSystemPrompt 的 switch
 *    - getSubAgentModelConfig 的 env 查询
 *    现在全部收敛到 SubAgentDefinition 一处。
 *
 * 2. 可维护性：新增 / 修改子 Agent 只需改这一处配置，无需触碰 coordinator。
 *
 * 3. 运行时可注册（适配层）：外部项目可通过 registerCapability() 注入或覆盖子 Agent，
 *    无需改动本项目源码。本项目内置 life/tech/info 作为默认配置。
 *
 * 4. 不破坏现有 allowlist 模块：工具白名单仍由 subagent-chat-tool-allowlists.ts 提供，
 *    registry 仅持有引用；这样 allowlist 的 helper 函数保持不变。
 */
import type { SubAgentCapability, SubAgentType } from "../services/master-agent-types.js";
import { SUB_AGENT_TOOL_ALLOWLISTS } from "../services/subagent-chat-tool-allowlists.js";
import {
  buildLifeSystemPrompt,
  buildTechSystemPrompt,
  buildInfoSystemPrompt,
  getSubAgentModelConfig,
  type SubAgentModelConfig,
} from "./subagent-system-prompts.js";

/** system prompt 构造器签名 */
export type SystemPromptBuilder = (capability: SubAgentCapability) => string;

/**
 * 一个完整的子 Agent 定义 — 把所有 per-type 配置打包在一起
 */
export interface SubAgentDefinition {
  /** 基础能力元数据（type/name/description/keywords/tools/capabilities） */
  readonly capability: SubAgentCapability;
  /** 工具循环最大轮次（覆盖动态推断） */
  readonly maxRounds: number;
  /** system prompt 构造器 */
  readonly systemPromptBuilder: SystemPromptBuilder;
  /** 模型配置（可选；不填则回退到环境变量 SUBAGENT_<TYPE>_MODEL） */
  readonly modelConfig?: SubAgentModelConfig;
}

/**
 * 工具名解析器：根据关键词从 toolRegistry 中匹配出工具注册名
 * （life 的 tools 字段是动态解析的，因为钱包/视觉工具集可能随部署变化）
 */
export type ToolNameResolver = (...keywords: string[]) => string[];

/**
 * 子 Agent 能力注册中心
 *
 * 用法：
 * - 内置默认配置：`createDefaultSubAgentRegistry(resolver)`
 * - 运行时注册：`registry.registerCapability(def)`（覆盖同名类型）
 * - 查询：`registry.get(type)` / `registry.getMaxRounds(type)` / `registry.getSystemPrompt(type)`
 */
export class SubAgentCapabilityRegistry {
  private readonly definitions = new Map<SubAgentType, SubAgentDefinition>();

  /** 注册（或覆盖）一个子 Agent 定义 */
  registerCapability(def: SubAgentDefinition): void {
    this.definitions.set(def.capability.type, def);
  }

  /** 获取某个类型的完整定义 */
  get(type: SubAgentType): SubAgentDefinition | undefined {
    return this.definitions.get(type);
  }

  /** 是否已注册某类型 */
  has(type: SubAgentType): boolean {
    return this.definitions.has(type);
  }

  /** 列出所有已注册定义 */
  list(): SubAgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  /** 列出所有已注册类型 */
  types(): SubAgentType[] {
    return Array.from(this.definitions.keys());
  }

  /** 返回 capability 元数据 Map（兼容旧接口） */
  capabilityMap(): Map<SubAgentType, SubAgentCapability> {
    const m = new Map<SubAgentType, SubAgentCapability>();
    for (const def of this.definitions.values()) {
      m.set(def.capability.type, def.capability);
    }
    return m;
  }

  /** 获取某类型的最大工具循环轮次 */
  getMaxRounds(type: SubAgentType, fallback = 12): number {
    return this.definitions.get(type)?.maxRounds ?? fallback;
  }

  /** 获取某类型的 system prompt（已渲染） */
  getSystemPrompt(type: SubAgentType): string | undefined {
    const def = this.definitions.get(type);
    if (!def) return undefined;
    return def.systemPromptBuilder(def.capability);
  }

  /** 获取某类型的 system prompt 构造器（未渲染，便于外部定制） */
  getSystemPromptBuilder(type: SubAgentType): SystemPromptBuilder | undefined {
    return this.definitions.get(type)?.systemPromptBuilder;
  }

  /**
   * 获取某类型的模型配置
   * 优先级：definition.modelConfig > capability.modelConfig > 环境变量 SUBAGENT_<TYPE>_MODEL
   */
  getModelConfig(type: SubAgentType): SubAgentModelConfig {
    const def = this.definitions.get(type);
    if (def?.modelConfig) return def.modelConfig;
    if (def?.capability.modelConfig) return def.capability.modelConfig;
    return getSubAgentModelConfig(type);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内置默认子 Agent 定义（life / tech / info）
//
// 描述文本较大，集中在此处便于维护。新增子 Agent 只需追加一个 buildXxxDefinition。
// ──────────────────────────────────────────────────────────────────────────

/** life 子 Agent 的工具集需要从 toolRegistry 动态解析（钱包/视觉工具随部署变化） */
function buildLifeTools(resolver: ToolNameResolver): string[] {
  return [
    ...resolver("wallet", "fund", "market", "shop", "purchase", "a2a", "trade"),
    ...resolver("desktop", "visual", "vision"),
  ];
}

/** life 子 Agent 定义 */
function buildLifeDefinition(resolver: ToolNameResolver): SubAgentDefinition {
  return {
    capability: {
      type: "life",
      name: "生活全能助手",
      description: [
        "【生活全能 — 处理复杂生活操作】",
        "",
        "主 agent 能做的（不需要委派给我）：",
        "- 查天气、查日程、查余额、看流水",
        "- 管理好友、发送消息、设提醒",
        "- 搜索信息、比价查询",
        "",
        "我只处理主 agent 做不到的复杂操作：",
        "",
        "💰 钱包写操作：",
        "- wallet.transfer：向好友转账（需好友关系验证）",
        "- wallet.recharge：充值",
        "- wallet.purchase：**全场景消费**，支持50+类别：",
        "  🍱 外卖点餐 · 🍽️ 到店餐饮 · 🏨 酒店预订",
        "  🚕 打车出行 · ✈️ 机票火车票 · 🎬 电影票",
        "  🛒 网购购物 · 📱 各类缴费 · 💊 药品医疗",
        "  🎁 礼品鲜花 · 🧹 家政维修",
        "  ...以及所有其他可购买的服务和商品",
        "",
        "🖥️ 视觉操控（主 agent 无此能力）：",
        "- 需要真实操作网站/App时使用",
        "- 打开携程订酒店、淘宝下单、操作任何网站/软件",
        "- 像人一样看屏幕、操作鼠标键盘",
      ].join("\n"),
      keywords: [
        "买", "购", "订", "预订", "下单", "支付", "花钱", "消费",
        "外卖", "吃饭", "点餐", "美团", "饿了么",
        "酒店", "民宿", "携程", "Booking", "Airbnb",
        "打车", "滴滴", "网约车", "高德",
        "机票", "火车票", "高铁", "12306", "飞机",
        "电影票", "演唱会", "演出", "展览", "门票",
        "网购", "淘宝", "京东", "拼多多", "购物",
        "缴费", "话费", "电费", "水费", "燃气", "宽带",
        "转账", "汇款", "充值", "红包",
        "礼物", "礼品", "鲜花", "捐赠", "捐款",
        "健康", "医疗", "药品", "健身", "体检",
        "宠物", "猫粮", "狗粮", "宠物医院",
        "家政", "保洁", "维修", "搬家",
        "美妆", "SPA", "按摩", "美发", "理发",
        "保险", "理财", "基金", "股票", "投资",
        "教育", "课程", "培训", "图书",
        "办公", "打印", "复印", "快递", "寄件",
        "帮我买", "帮我订",
        "在电脑上", "打开网站", "操作电脑",
      ],
      tools: buildLifeTools(resolver),
      capabilities: ["wallet", "purchase"],
    },
    maxRounds: 8,
    systemPromptBuilder: buildLifeSystemPrompt,
  };
}

/** tech 子 Agent 定义 */
function buildTechDefinition(): SubAgentDefinition {
  return {
    capability: {
      type: "tech",
      name: "技术操控助手",
      description: [
        "【技术操控 — 深度RPA自动化 + 开发运维】",
        "",
        "🔧 深度RPA（Robotic Process Automation，机器人流程自动化）：",
        "- 与 life 偶尔用视觉操控不同，tech 专门用它做**复杂多步流程**",
        "- 区别：",
        "  普通视觉操控（life也用）: 单次任务，如'订一张电影票'（10-40步）",
        "  深度RPA（tech专精）: 复杂流程，如：",
        "    - 批量处理100张发票并录入系统（200+步）",
        "    - 自动监控10个商品价格，降价就下单（持续运行）",
        "    - 跨多个网站采集数据并汇总到Excel",
        "    - 自动化测试整个网站的注册→登录→购买流程",
        "- 支持指定 region(屏幕区域)、maxSteps(最大步数可达120步)",
        "",
        "💻 代码开发：",
        "- 代码编写、调试、重构、审查、脚本开发",
        "",
        "⚙️ 系统运维：",
        "- 服务器管理、服务部署、API调试、环境搭建、云服务管理",
        "",
        "🖥️ 视觉操控（通用基础设施工具）：tech 同样可以使用",
        "- 只是使用得更深、更复杂、更持久",
      ].join("\n"),
      keywords: [
        "写代码", "编程", "debug", "调试", "开发", "重构",
        "脚本", "自动化", "RPA", "批量", "爬虫", "数据采集",
        "服务器", "部署", "运维", "Docker", "容器",
        "API", "接口", "调试接口", "Postman",
        "安装软件", "配置环境", "搭建环境",
        "云服务", "阿里云", "AWS", "服务器",
        "数据库", "SQL", "MongoDB", "Redis",
        "Git", "版本控制", "CI/CD",
        "帮我写个", "帮我做个", "帮我部署",
        "监控", "定时任务", "cron",
        "截图", "录屏", "屏幕监控",
      ],
      tools: [...(SUB_AGENT_TOOL_ALLOWLISTS.tech ?? [])],
      capabilities: ["deep_rpa", "code_dev", "system_ops"],
    },
    maxRounds: 12,
    systemPromptBuilder: buildTechSystemPrompt,
  };
}

/** info 子 Agent 定义 */
function buildInfoDefinition(): SubAgentDefinition {
  return {
    capability: {
      type: "info",
      name: "信息助手",
      description: [
        "【信息检索 — 只查不买】",
        "- 商品比价、搜索评价、查找优惠活动",
        "- 翻译、知识问答、资料收集整理",
        "- 新闻资讯、实时信息查询",
        "- 工具：search_web / fetch_web / info.inspect_webpage / info.navigate_site / shopping.suggest",
        "- 电商/OTA 实价：用户导入 Cookie 并授权后使用 browser.fetch_page（须完全访问）；或 desktop.visual 操控本机已登录浏览器",
        "- 为其他子Agent提供决策依据，但本身不执行购买或支付操作",
      ].join("\n"),
      keywords: ["搜索", "查询", "比价", "评价", "优惠", "折扣", "促销", "翻译", "新闻", "资料", "攻略", "哪个好", "推荐", "对比"],
      tools: [...(SUB_AGENT_TOOL_ALLOWLISTS.info ?? [])],
      capabilities: ["search_info"],
    },
    maxRounds: 2,
    systemPromptBuilder: buildInfoSystemPrompt,
  };
}

/**
 * 创建预装了 life/tech/info 默认配置的注册中心
 *
 * @param toolResolver 工具名解析器（从 toolRegistry.list() 按关键词匹配）；
 *                     仅 life 需要它来动态解析钱包/视觉工具集
 */
export function createDefaultSubAgentRegistry(toolResolver: ToolNameResolver): SubAgentCapabilityRegistry {
  const registry = new SubAgentCapabilityRegistry();
  registry.registerCapability(buildLifeDefinition(toolResolver));
  registry.registerCapability(buildTechDefinition());
  registry.registerCapability(buildInfoDefinition());
  return registry;
}
