/**
 * Master Agent coordinator.
 * The only sub-agent path is dynamic function-calling delegation via
 * `master_invoke_sub_agent`.
 */

import { randomUUID } from "node:crypto";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { isMasterAgentDelegationVerbose } from "../agent/master-agent-delegate-env.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import type { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { PersonalizationPromptSlice } from "./user-personalization/user-personalization-service.js";
import { routeLlmExecution } from "../agent/task-router.js";
import { getMemoryManagerService } from "./memory-manager-service.js";
import {
  pickSubAgentDoneLine,
  USER_VISIBLE_PROGRESS_MARKER,
} from "../agent/delegate-status.js";
import { parseSubAgentType } from "../agent/master-subagent-delegate-tools.js";
import { resolveUserLocationPrompt } from "./user-location-service.js";
import type {
  InterAgentMessage,
  SubAgentCapability,
  SubAgentResult,
  SubAgentType,
  SubTask,
} from "./master-agent-types.js";
import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import { resolveActorId } from "../agent/actor-id.js";
import { masterChatSessionId } from "../agent/master-chat-session.js";
import type { ToolContext } from "../tools/tool-registry.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  ToolExecutedInfo,
  ToolExecuteStartInfo,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { buildMasterAgentChatTools } from "./master-agent-tool-filter.js";
import { SUB_AGENT_TOOL_ALLOWLISTS } from "./subagent-chat-tool-allowlists.js";

export type { SubAgentCapability, SubAgentResult, SubAgentType, SubTask } from "./master-agent-types.ts";

type SubAgentInvokeContext = {
  userMessage: string;
  priorResults: SubAgentResult[];
};

type TurnDelegationState = {
  reports: SubAgentResult[];
  seenFingerprints: Map<string, SubAgentResult>;
  interAgentMessages: InterAgentMessage[];
  retryAttempts: Map<string, number>;
};

export type OrchestrateTaskOptions = {
  chatUserMessageId?: string;
  userId?: string;
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  userLocation?: string;
  visionFrames?: VisionFrame[];
  interruptedContext?: string;
  narrativeRecall?: string;
  personalization?: PersonalizationPromptSlice;
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  agentAccessMode?: import("../agent/agent-access-mode.js").AgentAccessMode;
};

export interface MasterAgentConfig {
  enableSubAgents: boolean;
  maxParallelTasks: number;
  taskTimeoutMs: number;
  techSubtaskTimeoutMs: number;
  allowFallback: boolean;
  verbose: boolean;
  enableMetrics: boolean;
}

export interface PerformanceMetrics {
  totalTasks: number;
  sequentialExecutions: number;
  fallbackCount: number;
  avgExecutionTime: number;
  successRate: number;
  lastUpdated: string;
}

export interface SubAgentPerformanceMetrics {
  invocations: number;
  failures: number;
  timeouts: number;
  avgExecutionTime: number;
  lastExecutionTime?: number;
}

export class MasterAgentCoordinator {
  private readonly config: MasterAgentConfig;
  private readonly subAgentCapabilities: Map<SubAgentType, SubAgentCapability>;
  private readonly metrics: PerformanceMetrics;
  private readonly executionHistory: Array<{
    timestamp: string;
    taskId: string;
    duration: number;
    success: boolean;
    strategy: string;
    subTaskCount: number;
  }> = [];

  private readonly turnDelegationStates = new Map<string, TurnDelegationState>();
  private readonly subAgentMetrics = new Map<SubAgentType, SubAgentPerformanceMetrics>();
  private currentTurnUserMessage: string | null = null;
  private currentTurnOrchestrateOpts: OrchestrateTaskOptions | null = null;

  constructor(
    private readonly masterProvider: ExternalChatProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly promptContextBuilder: PromptContextBuilder | null = null,
    config?: Partial<MasterAgentConfig>,
  ) {
    this.config = {
      enableSubAgents: true,
      maxParallelTasks: 1,
      taskTimeoutMs: 60_000,
      techSubtaskTimeoutMs: 120_000,
      allowFallback: true,
      verbose: isMasterAgentDelegationVerbose(),
      enableMetrics: true,
      ...config,
    };
    const rtConfig = getAgentRuntimeConfig();
    this.config.maxParallelTasks = rtConfig.masterDelegation.maxParallelSubAgents;

    this.subAgentCapabilities = this.initializeSubAgentCapabilities();
    this.metrics = {
      totalTasks: 0,
      sequentialExecutions: 0,
      fallbackCount: 0,
      avgExecutionTime: 0,
      successRate: 100,
      lastUpdated: new Date().toISOString(),
    };

    this.registerDelegateTools();
    this.log("MasterAgentCoordinator initialized", {
      enableSubAgents: this.config.enableSubAgents,
      maxParallelTasks: this.config.maxParallelTasks,
      verbose: this.config.verbose,
    });
  }

  private registerDelegateTools(): void {
    this.toolRegistry.register("master.invoke_sub_agent", async (input, context) =>
      this.handleInvokeSubAgentTool(input, context),
    );
    this.toolRegistry.register("master.list_sub_agents", async (_input, context) =>
      this.handleListSubAgentsTool(context),
    );
  }

  /** 供验收测试 / 监控读取子 Agent 能力表。 */
  getSubAgentCapabilities(): ReadonlyMap<SubAgentType, SubAgentCapability> {
    return this.subAgentCapabilities;
  }

  /**
   * 初始化 4 个核心子 Agent（按能力维度划分）
   *
   * 设计理念：
   * - life  → 生活全能：钱包全操作 + 社交 + 日常 + 娱乐 + 视觉操控(通用)
   * - tech  → 技术操控：深度RPA自动化 + 代码开发 + 系统运维 + 视觉操控(通用)
   * - info  → 信息检索：搜索比价调研（只查不买）
   * - general → 兜底
   *
   * 视觉操控（desktop.visual.run_task）是通用基础设施：
   * 所有拥有 desktop/visual 工具白名单的子Agent都能使用。
   * 区别仅在于使用的场景：
   * - life: 偶尔用（订酒店时顺手操作网站）
   * - tech: 深度用（复杂自动化流程、批量操作、长时间运行）
   */
  private initializeSubAgentCapabilities(): Map<SubAgentType, SubAgentCapability> {
    const allTools = this.toolRegistry.list();
    const by = (...parts: string[]) => allTools.filter((t) => parts.some((p) => t.includes(p)));
    const map = new Map<SubAgentType, SubAgentCapability>();

    // ──────────────────────────────────────────────
    // 🏠 life 生活全能助手（合并原 life + finance + entertainment + social + work）
    //
    // 这是用户最常用的子Agent，具备：
    // 💰 钱包全部操作（转账/消费50+类别/充值/查询）
    // 🖥️ 视觉操控电脑（可直接操作网站完成真实预订）
    // 💬 社交互动（好友/消息/红包）
    // ⏰ 日常生活（天气/日程/提醒）
    // 🎮 娱乐休闲（游戏对局）
    //
    // 用户说任何消费/生活相关的事 → life 直接处理
    // 不需要判断"这是哪个category"→ Agent 自己决定用什么工具
    // ──────────────────────────────────────────────
    map.set("life", {
      type: "life",
      name: "生活全能助手",
      description: [
        "【生活全能 — 一个Agent搞定所有日常事务】",
        "",
        "💰 钱包能力（wallet.* 全部工具）：",
        "- wallet.get_balance / wallet.get_transactions：查余额、看流水",
        "- wallet.transfer：向好友转账（需好友关系验证）",
        "- wallet.recharge：充值",
        "- wallet.purchase：**全场景消费**，支持50+类别，包括但不限于：",
        "  🍱 外卖点餐(美团/饿了么) · 🍽️ 到店餐饮",
        "  🏨 酒店预订(携程/Booking) · 🚕 打车出行(滴滴)",
        "  ✈️ 机票火车票(12306/航司) · 🎬 电影票(猫眼/淘票票)",
        "  🎤 演唱会/体育赛事门票 · 🛒 网购购物(淘宝/京东)",
        "  📱 话费/电费/水费/燃气/宽带缴费",
        "  💊 药品/医疗 · 🐾 宠物用品医疗 · 🧹 家政保洁维修",
        "  🎁 礼品鲜花 · 🧧 红包转账 · ❤️‍🩹 公益捐赠",
        "  💄 美妆SPA美发 · 🎮 游戏充值 · ⭐ 会员订阅",
        "  🛡️ 保险理财投资 · 📚 教育课程图书",
        "  ...以及所有其他可购买的服务和商品",
        "",
        "🖥️ 视觉操控（通用基础设施工具）：",
        "- desktop.visual.run_task 是通用能力，life 可以在需要时使用",
        "- 典型场景：需要真实操作网站/App时（打开携程订酒店、淘宝下单等）",
        "- 像人一样看屏幕、操作鼠标键盘完成任务",
        "",
        "💬 社交能力：好友消息、动态、红包",
        "⏰ 日常能力：天气查询、日程管理、提醒闹钟",
        "🎮 娱乐能力：五子棋、斗地主、炸金花等游戏对局",
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
        "转账", "汇款", "充值", "红包", "余额",
        "礼物", "礼品", "鲜花", "捐赠", "捐款",
        "健康", "医疗", "药品", "健身", "体检",
        "宠物", "猫粮", "狗粮", "宠物医院",
        "家政", "保洁", "维修", "搬家",
        "美妆", "SPA", "按摩", "美发", "理发",
        "游戏", "游戏充值", "会员", "VIP", "订阅",
        "保险", "理财", "基金", "股票", "投资",
        "教育", "课程", "培训", "图书",
        "办公", "打印", "复印", "快递", "寄件",
        "帮我买", "帮我订", "帮我看下", "多少钱",
        "在电脑上", "打开网站", "操作电脑",
        "朋友", "社交", "消息", "聊天",
        "天气", "日程", "提醒", "闹钟",
        "五子棋", "斗地主", "炸金花",
      ],
      tools: [
        ...by("wallet", "fund", "market", "shop", "purchase", "a2a", "trade"),
        ...by("desktop", "visual", "vision"),
        ...by("social", "relay", "message", "chat", "friend"),
        ...allTools.filter((t) => t.startsWith("clock.")),
        ...by("calendar", "schedule", "weather", "reminder", "alarm"),
        ...by("gomoku", "music", "video", "doudizhu", "zhajinhua"),
      ],
      capabilities: [
        "wallet",
        "purchase",
        "social",
        "daily_life",
        "entertainment",
      ],
    });

    // ──────────────────────────────────────────────
    // 💻 tech 技术操控助手
    //
    // 专注于：
    // 1. 深度RPA自动化（复杂多步视觉操控流程）
    // 2. 代码开发与调试
    // 3. 系统运维与管理
    //
    // 与 life 的区别：
    // - life = "帮我买个东西"（简单消费指令）
    // - tech = "帮我写个脚本自动监控价格" / "部署这个服务"
    // ──────────────────────────────────────────────
    map.set("tech", {
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
      capabilities: [
        "deep_rpa",
        "code_dev",
        "system_ops",
      ],
    });

    // ──────────────────────────────────────────────
    // 🔍 info 信息助手（只查不买）
    // ──────────────────────────────────────────────
    map.set("info", {
      type: "info",
      name: "信息助手",
      description: [
        "【信息检索 — 只查不买】",
        "- 商品比价、搜索评价、查找优惠活动",
        "- 翻译、知识问答、资料收集整理",
        "- 新闻资讯、实时信息查询",
        "- 工具：search_web / fetch_web / info.inspect_webpage / info.navigate_site / shopping.suggest",
        "- 电商动态价格可尝试 fetch_web 抓页面，或 desktop.visual 截图读价（需完全访问模式）",
        "- 为其他子Agent提供决策依据，但本身不执行购买或支付操作",
      ].join("\n"),
      keywords: ["搜索", "查询", "比价", "评价", "优惠", "折扣", "促销", "翻译", "新闻", "资料", "攻略", "哪个好", "推荐", "对比"],
      tools: [...(SUB_AGENT_TOOL_ALLOWLISTS.info ?? [])],
      capabilities: ["search_info"],
    });

    // ──────────────────────────────────────────────
    // ✨ creative 创意内容助手
    //
    // 专注于：
    // 1. 文案撰写（营销文案、产品描述、社媒内容）
    // 2. 创意写作（故事、邮件、演讲稿、创意方案）
    // 3. 内容策划（PPT大纲、活动策划、内容策略）
    // 4. 翻译润色（中英互译、文本优化、风格调整）
    //
    // 与其他Agent的区别：
    // - life = 执行购买操作（不写文案）
    // - tech = 写代码/技术文档
    // - creative = 纯内容创作，不涉及代码和金钱操作
    // ──────────────────────────────────────────────
    map.set("creative", {
      type: "creative",
      name: "创意内容助手",
      description: [
        "【创意内容 — 文案·策划·写作·润色】",
        "",
        "✍️ 文案撰写：",
        "- 营销文案、产品描述、广告语、品牌故事",
        "- 社交媒体内容（朋友圈/小红书/抖音脚本）",
        "- 邮件撰写（商务邮件、邀请函、感谢信）",
        "",
        "📋 创意策划：",
        "- PPT 大纲与结构设计",
        "- 活动策划方案、营销策略",
        "- 内容日历与发布计划",
        "",
        "🎨 创意写作：",
        "- 故事创作、小说开头、剧本对白",
        "- 演讲稿、致辞、发言稿",
        "- 创意命名、Slogan 设计",
        "",
        "🌐 翻译润色：",
        "- 中英互译、多语言翻译",
        "- 文本优化、风格调整、语气改写",
        "- 校对纠错、语法检查",
      ].join("\n"),
      keywords: [
        "写文案", "写文章", "写邮件", "写策划", "写方案",
        "做PPT", "PPT大纲", "演示文稿",
        "创意", "创作", "写故事", "写小说",
        "翻译", "润色", "校对", "改写",
        "营销文案", "广告语", "Slogan", "品牌",
        "社媒", "小红书", "朋友圈", "抖音",
        "演讲稿", "致辞", "邀请函", "感谢信",
        "帮我写个", "帮我做个方案", "帮我构思",
        "取名", "命名", "口号",
      ],
      tools: [...(SUB_AGENT_TOOL_ALLOWLISTS.creative ?? [])],
      capabilities: ["content_creation"],
    });

    // ──────────────────────────────────────────────
    // 🛡️ security 安全审计助手
    //
    // 专注于：
    // 1. 操作风险检测（大额转账、敏感操作预检）
    // 2. 权限审批（二次确认机制）
    // 3. 异常行为检测（偏离用户习惯的操作）
    // 4. 安全策略执行（规则引擎 + LLM 判断）
    //
    // 工作模式：
    // - Master 先委派 security 审批 → 通过后委派 life/tech 执行
    // - security 本身不执行购买/转账，只做判断和建议
    // ──────────────────────────────────────────────
    map.set("security", {
      type: "security",
      name: "安全审计助手",
      description: [
        "【安全审计 — 风险检测 · 权限审批 · 异常拦截】",
        "",
        "🔒 操作风险检测：",
        "- 大额转账/消费预警（可配置阈值，默认单笔>1000元触发审核）",
        "- 敏感操作识别（删除账号、修改密码、授权第三方）",
        "- 新收款人/新商户首次交易风险提示",
        "",
        "✅ 权限审批流程：",
        "- 对高风险操作进行二次确认评估",
        "- 输出：APPROVED / REJECTED / NEED_CONFIRM 三级判定",
        "- 给出具体风险理由和缓解建议",
        "",
        "⚠️ 异常行为检测：",
        "- 偏离用户历史操作模式的行为标记",
        "- 非常规时间/非常规金额/非常规频率的异常识别",
        "- 可疑的连续多次小额试探性操作检测",
        "",
        "📊 审计报告输出格式：",
        "```",
        "【安全审计结果】",
        "判定: APPROVED / REJECTED / NEED_CONFIRM",
        "风险等级: LOW / MEDIUM / HIGH / CRITICAL",
        "原因: <具体分析>",
        "建议: <操作建议>",
        "```",
        "",
        "注意：security 只做风险评估和审批判断，不直接执行任何钱包或系统操作。",
      ].join("\n"),
      keywords: [
        "大额", "转账", "金额", "审批", "确认", "安全",
        "风险", "异常", "可疑", "权限", "验证",
        "敏感操作", "密码", "账号", "授权", "删除",
        "防盗", "防骗", "诈骗", "钓鱼",
        "安全检查", "审计", "合规",
      ],
      tools: [...(SUB_AGENT_TOOL_ALLOWLISTS.security ?? [])],
      capabilities: ["security_audit"],
    });

    // ──────────────────────────────────────────────
    // 🤖 general 通用助手（兜底）
    // ──────────────────────────────────────────────
    map.set("general", {
      type: "general",
      name: "通用助手",
      description: "处理其他未分类任务和兜底所有无法归类的场景。拥有全部工具权限。",
      keywords: [],
      tools: allTools,
      capabilities: [],
    });
    return map;
  }

  private turnReportKey(actorId: string, chatUserMessageId?: string): string {
    return `${actorId}:${chatUserMessageId ?? "no-message-id"}`;
  }

  private resetTurnReports(actorId: string, chatUserMessageId?: string): void {
    this.turnDelegationStates.set(this.turnReportKey(actorId, chatUserMessageId), {
      reports: [],
      seenFingerprints: new Map(),
      interAgentMessages: [],
      retryAttempts: new Map(),
    });
  }

  private getTurnDelegationState(actorId: string, chatUserMessageId?: string): TurnDelegationState {
    const key = this.turnReportKey(actorId, chatUserMessageId);
    let state = this.turnDelegationStates.get(key);
    if (!state) {
      state = { reports: [], seenFingerprints: new Map(), interAgentMessages: [], retryAttempts: new Map() };
      this.turnDelegationStates.set(key, state);
    }
    return state;
  }

  private buildDelegationFingerprint(agentType: SubAgentType, taskDescription: string, priorContext: string): string {
    const normalized = `${taskDescription}\n${priorContext}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    return `${agentType}:${normalized}`;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1),
    );
  }

  private computeSemanticSimilarity(a: string, b: string): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    const intersection = new Set([...tokensA].filter((x) => tokensB.has(x)));
    const union = new Set([...tokensA, ...tokensB]);
    return intersection.size / union.size;
  }

  private findSimilarExistingFingerprint(
    turnState: TurnDelegationState,
    agentType: SubAgentType,
    taskDescription: string,
    priorContext: string,
    threshold: number,
  ): SubAgentResult | null {
    const rtConfig = getAgentRuntimeConfig();
    const effectiveThreshold = rtConfig.masterDelegation.semanticDedupEnabled ? (rtConfig.masterDelegation.semanticDedupThreshold || threshold) : 1.0;
    if (effectiveThreshold >= 1.0) return null;

    const candidate = `${taskDescription}\n${priorContext}`.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 1000);
    for (const [fp, result] of turnState.seenFingerprints) {
      if (!fp.startsWith(`${agentType}:`)) continue;
      const existingText = fp.slice(`${agentType}:`.length);
      if (this.computeSemanticSimilarity(candidate, existingText) >= effectiveThreshold) {
        return result;
      }
    }
    return null;
  }

  private sendInterAgentMessage(
    turnState: TurnDelegationState,
    from: SubAgentType,
    to: SubAgentType,
    content: string,
    relatedTaskId?: string,
  ): InterAgentMessage {
    const msg: InterAgentMessage = {
      id: randomUUID(),
      fromAgent: from,
      toAgent: to,
      content,
      timestamp: Date.now(),
      relatedTaskId,
    };
    turnState.interAgentMessages.push(msg);
    return msg;
  }

  private getInterAgentMessagesForAgent(turnState: TurnDelegationState, agentType: SubAgentType): InterAgentMessage[] {
    return turnState.interAgentMessages.filter((m) => m.toAgent === agentType);
  }

  private formatInterAgentMessagesForPrompt(messages: InterAgentMessage[]): string {
    if (messages.length === 0) return "";
    return (
      "\n\n【来自其他子Agent的消息】\n" +
        messages
          .map(
            (m) =>
              `- 来自 ${m.fromAgent} Agent（${new Date(m.timestamp).toLocaleTimeString("zh-CN")}）：\n  ${m.content}`,
          )
          .join("\n\n")
    );
  }

  private buildRetryHint(errorMsg: string, attempt: number, agentType: SubAgentType): string {
    const isTimeout = errorMsg.includes("timed out");
    if (isTimeout) {
      return `[重试提示 #${attempt}] 上次执行超时。请简化操作步骤，聚焦核心目标，减少不必要的工具调用。如果任务过于复杂，请分阶段汇报中间结果。`;
    }
    if (errorMsg.toLowerCase().includes("error") || errorMsg.toLowerCase().includes("fail")) {
      return `[重试提示 #${attempt}] 上次执行失败：${errorMsg.slice(0, 200)}。请调整策略后重试，考虑使用替代工具或简化任务范围。`;
    }
    return `[重试提示 #${attempt}] 上次执行异常，请换一种方式完成任务。`;
  }

  async handleInvokeSubAgentTool(input: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const actorId = resolveActorId(context);
    const agentType = parseSubAgentType(input.agentType);
    const taskDescription = String(input.taskDescription ?? "").trim();
    const priorContext = String(input.priorContext ?? "").trim();
    const targetAgent = String(input.forwardToAgent ?? "").trim();

    if (!agentType) return { ok: false, error: "Invalid agentType. Use master_list_sub_agents to inspect options." };
    if (!taskDescription) return { ok: false, error: "taskDescription is required." };

    const capability = this.subAgentCapabilities.get(agentType);
    if (!capability) return { ok: false, error: `Unknown sub-agent type: ${agentType}` };

    const rtConfig = getAgentRuntimeConfig();
    const turnState = this.getTurnDelegationState(actorId, context.chatUserMessageId);
    const maxInvocations = Math.max(1, rtConfig.masterDelegation.maxSubAgentInvocationsPerTurn);
    if (turnState.reports.length >= maxInvocations) {
      return {
        ok: false,
        agentType,
        agentName: capability.name,
        error: `Sub-agent delegation limit reached for this turn (${maxInvocations}). Synthesize from prior reports instead of delegating again.`,
        priorInvocationsInTurn: turnState.reports.length,
      };
    }

    const fingerprint = this.buildDelegationFingerprint(agentType, taskDescription, priorContext);

    const exactPrevious = turnState.seenFingerprints.get(fingerprint);
    if (exactPrevious) {
      return {
        ok: exactPrevious.success,
        agentType,
        agentName: capability.name,
        taskId: exactPrevious.taskId,
        report: exactPrevious.result,
        deduplicated: true,
        priorInvocationsInTurn: turnState.reports.length,
        message: "Duplicate sub-agent delegation skipped; reuse the existing report.",
      };
    }

    const similarPrevious = this.findSimilarExistingFingerprint(turnState, agentType, taskDescription, priorContext, 0.75);
    if (similarPrevious) {
      return {
        ok: similarPrevious.success,
        agentType,
        agentName: capability.name,
        taskId: similarPrevious.taskId,
        report: similarPrevious.result,
        deduplicated: true,
        semanticallyDeduplicated: true,
        priorInvocationsInTurn: turnState.reports.length,
        message: "Semantically similar sub-agent delegation skipped; reuse the existing report.",
      };
    }

    if (targetAgent) {
      const targetType = parseSubAgentType(targetAgent);
      if (targetType && targetType !== agentType) {
        this.sendInterAgentMessage(
          turnState,
          agentType,
          targetType,
          taskDescription + (priorContext ? `\n背景：${priorContext}` : ""),
        );
        return {
          ok: true,
          agentType,
          agentName: capability.name,
          message: `消息已转发给 ${targetType} Agent。`,
          forwardedTo: targetType,
        };
      }
    }

    const task: SubTask = {
      id: `delegate-${randomUUID()}`,
      description: priorContext ? `${taskDescription}\n\n补充背景：${priorContext}` : taskDescription,
      assignedAgent: agentType,
      priority: 5,
      dependencies: [],
      estimatedComplexity: "medium",
    };

    const maxRetries = rtConfig.masterDelegation.retryEnabled ? Math.min(rtConfig.masterDelegation.maxRetryAttempts, 3) : 0;
    let lastError = "";
    let report: string | null = null;
    let success = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const invokeCtx: SubAgentInvokeContext = {
        userMessage: this.currentTurnUserMessage?.trim() || taskDescription,
        priorResults: [...turnState.reports],
      };

      if (attempt > 0) {
        const hint = this.buildRetryHint(lastError, attempt, agentType);
        task.description = `${taskDescription}\n\n${hint}${priorContext ? `\n补充背景：${priorContext}` : ""}`;
        invokeCtx.priorResults = [...turnState.reports];
        this.log(`Retry attempt ${attempt}/${maxRetries} for ${agentType}`, { taskId: task.id });
      }

      const started = Date.now();
      const timeoutMs = this.resolveSubAgentTimeout(agentType);
      try {
        const result = await this.withSubTaskTimeout(
          this.executeTaskWithTools(
            actorId,
            task,
            capability,
            invokeCtx,
            parseAgentAccessMode(context.agentAccessMode ?? this.currentTurnOrchestrateOpts?.agentAccessMode),
          ),
          timeoutMs,
          task.id,
        );
        const executionTime = Date.now() - started;
        report = result;
        success = true;

        const subResult: SubAgentResult = {
          taskId: task.id,
          agentType,
          success: true,
          result: report,
          executionTime,
        };
        turnState.reports.push(subResult);
        turnState.seenFingerprints.set(fingerprint, subResult);
        this.metrics.sequentialExecutions += 1;
        this.recordSubAgentMetrics(agentType, true, executionTime, false);

        const uiDoneLine = pickSubAgentDoneLine(report);
        return {
          ok: true,
          agentType,
          agentName: capability.name,
          taskId: task.id,
          report,
          ...(attempt > 0 ? { retryAttempt: attempt } : {}),
          priorInvocationsInTurn: turnState.reports.length,
          ...(uiDoneLine ? { uiDoneLine } : {}),
          message: `${capability.name} completed${attempt > 0 ? ` (retry #${attempt})` : ""}; read the report field.`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const executionTime = Date.now() - started;
        lastError = msg;
        const timedOut = msg.includes("timed out");
        this.recordSubAgentMetrics(agentType, false, executionTime, timedOut);

        if (attempt < maxRetries) {
          this.log(`Sub-agent ${agentType} failed, will retry (${attempt + 1}/${maxRetries})`, { error: msg });
          continue;
        }

        const failResult: SubAgentResult = {
          taskId: task.id,
          agentType,
          success: false,
          result: msg,
          executionTime,
        };
        turnState.reports.push(failResult);
        turnState.seenFingerprints.set(fingerprint, failResult);
        return {
          ok: false,
          agentType,
          agentName: capability.name,
          error: msg,
          retriesExhausted: maxRetries > 0,
          retryAttempts: attempt,
          priorInvocationsInTurn: turnState.reports.length,
        };
      }
    }

    return { ok: false, agentType, agentName: capability.name, error: "Unexpected exit from retry loop." };
  }

  async handleListSubAgentsTool(_context: ToolContext): Promise<Record<string, unknown>> {
    const agents = [...this.subAgentCapabilities.values()].map((c) => ({
      type: c.type,
      name: c.name,
      description: c.description,
      keywords: c.keywords,
      capabilities: c.capabilities,
      toolCount: c.tools.length,
    }));
    return { ok: true, agents, hint: "Use master_invoke_sub_agent for one distinct sub-task at a time." };
  }

  async orchestrateTask(
    actorId: string,
    userMessage: string,
    onProgress?: (message: string) => void,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
  ): Promise<string> {
    const started = Date.now();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.metrics.totalTasks += 1;

    const userLocation =
      opts?.userLocation ??
      (await resolveUserLocationPrompt({
        clientIp: opts?.clientIp,
        clientLocation: opts?.clientLocation,
      }));
    const enrichedOpts: OrchestrateTaskOptions = { ...opts, userLocation };

    this.currentTurnUserMessage = userMessage;
    this.currentTurnOrchestrateOpts = enrichedOpts;
    this.resetTurnReports(actorId, enrichedOpts.chatUserMessageId);

    try {
      const route = routeLlmExecution(userMessage);
      this.log("Route selected", { taskId, mode: route.mode, reasons: route.reasons });

      if (!this.config.enableSubAgents || route.mode === "master_only") {
        if (!this.config.enableSubAgents) {
          onProgress?.("🔄 切换至单 Agent 模式处理…");
          this.metrics.fallbackCount += 1;
        } else {
          onProgress?.("💭 正在思考，分析你的需求…");
        }
        return await this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta, enrichedOpts);
      }

      onProgress?.("🧠 主 Agent 分析中，准备委派任务…");
      return await this.executeWithMasterDelegateTools(actorId, userMessage, onAssistantDelta, enrichedOpts);
    } catch (error) {
      this.executionHistory.push({
        timestamp: new Date().toISOString(),
        taskId,
        duration: Date.now() - started,
        success: false,
        strategy: "fallback",
        subTaskCount: 0,
      });
      this.metrics.successRate = this.calculateSuccessRate();

      if (this.config.allowFallback) {
        this.metrics.fallbackCount += 1;
        onProgress?.("⚠️ 委派异常，切换至单 Agent 模式继续处理…");
        return await this.executeWithMasterOnly(actorId, userMessage, onAssistantDelta, enrichedOpts);
      }
      throw error;
    } finally {
      const memoryManager = getMemoryManagerService();
      if (memoryManager) {
        memoryManager.onTurnCompleted(actorId, userMessage, "");
      }
      this.currentTurnUserMessage = null;
      this.currentTurnOrchestrateOpts = null;
      if (this.executionHistory.length > 100) this.executionHistory.shift();
    }
  }

  private buildToolContext(actorId: string, opts?: OrchestrateTaskOptions): ChatToolExecutionContext {
    return {
      executeTool: (name, args) =>
        this.toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: opts?.userId,
          chatUserMessageId: opts?.chatUserMessageId,
          clientIp: opts?.clientIp,
          clientLocation: opts?.clientLocation,
          agentAccessMode: opts?.agentAccessMode,
        }),
      onToolExecuteStart: opts?.onToolExecuteStart,
      onToolExecuted: opts?.onToolExecuted,
    };
  }

  private buildPromptInput(actorId: string, opts?: OrchestrateTaskOptions) {
    return {
      actorId,
      userText: this.currentTurnUserMessage ?? undefined,
      narrativeRecall: opts?.narrativeRecall,
      personalization: opts?.personalization,
      interruptedContext: opts?.interruptedContext,
      userLocation: opts?.userLocation,
      onToolLoopAfterBatch: opts?.onToolLoopAfterBatch,
    };
  }

  private buildUserTurn(userMessage: string, opts?: OrchestrateTaskOptions): ChatUserTurn {
    return {
      text: userMessage,
      ...(opts?.visionFrames?.length ? { visionFrames: opts.visionFrames } : {}),
    };
  }

  private buildMasterDelegateStreamOptions(actorId: string, opts?: OrchestrateTaskOptions): AgentStreamOptions {
    if (!this.promptContextBuilder) {
      return {
        masterSubAgentDelegate: true,
        chatToolsBuiltin: buildMasterAgentChatTools(this.subAgentCapabilities.values()),
        ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
      };
    }
    return {
      ...this.promptContextBuilder.buildForMasterDelegate({
        ...this.buildPromptInput(actorId, opts),
        subAgentCapabilities: this.subAgentCapabilities.values(),
      }),
      ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
    };
  }

  private buildMasterStreamOptions(actorId: string, opts?: OrchestrateTaskOptions): AgentStreamOptions | undefined {
    const chatToolsExtra: ChatCompletionTool[] = [];
    if (this.promptContextBuilder) {
      const base = this.promptContextBuilder.build(this.buildPromptInput(actorId, opts));
      if (base?.chatToolsExtra?.length) chatToolsExtra.push(...base.chatToolsExtra);
      return {
        ...(base ?? {}),
        chatToolsBuiltin: buildMasterAgentChatTools(this.subAgentCapabilities.values(), chatToolsExtra),
        chatToolsExtra: [],
        ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
      };
    }
    return {
      chatToolsBuiltin: buildMasterAgentChatTools(this.subAgentCapabilities.values(), chatToolsExtra),
      ...(opts?.agentAccessMode ? { agentAccessMode: opts.agentAccessMode } : {}),
    };
  }

  private async executeWithMasterDelegateTools(
    actorId: string,
    userMessage: string,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
  ): Promise<string> {
    const sessionId = masterChatSessionId(actorId);
    let fullText = "";
    await this.masterProvider.streamCompletion(
      sessionId,
      this.buildUserTurn(userMessage, opts),
      (delta) => {
        fullText += delta;
        onAssistantDelta?.(delta);
      },
      this.buildToolContext(actorId, opts),
      this.buildMasterDelegateStreamOptions(actorId, opts),
    );
    this.recordSuccess("master-delegate-tools", this.getTurnDelegationState(actorId, opts?.chatUserMessageId).reports.length);
    return fullText;
  }

  private async executeWithMasterOnly(
    actorId: string,
    userMessage: string,
    onAssistantDelta?: (delta: string) => void,
    opts?: OrchestrateTaskOptions,
  ): Promise<string> {
    const sessionId = masterChatSessionId(actorId);
    let fullText = "";
    await this.masterProvider.streamCompletion(
      sessionId,
      this.buildUserTurn(userMessage, opts),
      (delta) => {
        fullText += delta;
        onAssistantDelta?.(delta);
      },
      this.buildToolContext(actorId, opts),
      this.buildMasterStreamOptions(actorId, opts),
    );
    this.recordSuccess("master-only", 0);
    return fullText;
  }

  private async executeTaskWithTools(
    actorId: string,
    task: SubTask,
    capability: SubAgentCapability,
    invokeCtx?: SubAgentInvokeContext,
    agentAccessMode?: AgentAccessMode,
  ): Promise<string> {
    const baseStreamOpts: AgentStreamOptions = {
      ...(this.promptContextBuilder?.buildForSubAgent({
        ...this.buildPromptInput(actorId, this.currentTurnOrchestrateOpts ?? undefined),
        capability,
        taskDescription: task.description,
      }) ?? {}),
      ...(agentAccessMode ? { agentAccessMode } : {}),
    };

    const allowedList =
      (baseStreamOpts.chatToolsBuiltin ?? [])
        .map((t) => (t.type === "function" ? t.function?.name : ""))
        .filter(Boolean)
        .join(", ") || "(none)";
    const priorBlock = invokeCtx?.priorResults.length
      ? `\n\nPrior sub-agent reports for reference; do not repeat work:\n${this.formatSubAgentReportsForMaster(invokeCtx.priorResults)}`
      : "";
    const userGoal = invokeCtx?.userMessage ? `\n\nOriginal user request:\n${invokeCtx.userMessage}` : "";

    const turnState = this.currentTurnUserMessage
      ? this.getTurnDelegationState(actorId, this.currentTurnOrchestrateOpts?.chatUserMessageId)
      : null;
    const agentMessages = turnState
      ? this.getInterAgentMessagesForAgent(turnState, capability.type)
      : [];
    const interAgentBlock = this.formatInterAgentMessagesForPrompt(agentMessages);

    const prompt = [
      `You are the ${capability.name} sub-agent, invoked by the master Agent. Report to the master Agent only.`,
      userGoal,
      `Current sub-task:\n${task.description}`,
      priorBlock,
      interAgentBlock,
      `Available tools:\n${allowedList}`,
      "Use necessary tools. Then return a concise sub-agent report with conclusion, evidence, and success/failure.",
      `The final line must be: ${USER_VISIBLE_PROGRESS_MARKER} followed by one short user-visible completion line.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const sessionId = `subagent-${actorId}-${task.id}-${Date.now()}`;
    let fullText = "";
    await this.masterProvider.streamCompletion(
      sessionId,
      { text: prompt },
      (delta) => {
        fullText += delta;
      },
      this.buildToolContext(actorId, this.currentTurnOrchestrateOpts ?? undefined),
      baseStreamOpts,
    );
    return fullText.trim();
  }

  private resolveSubAgentTimeout(agentType: SubAgentType): number {
    if (agentType === "tech") {
      return Math.max(this.config.techSubtaskTimeoutMs, this.config.taskTimeoutMs);
    }
    return this.config.taskTimeoutMs;
  }

  private emptySubAgentMetrics(): SubAgentPerformanceMetrics {
    return { invocations: 0, failures: 0, timeouts: 0, avgExecutionTime: 0 };
  }

  private recordSubAgentMetrics(
    agentType: SubAgentType,
    success: boolean,
    executionTime: number,
    timedOut: boolean,
  ): void {
    const prev = this.subAgentMetrics.get(agentType) ?? this.emptySubAgentMetrics();
    const invocations = prev.invocations + 1;
    const failures = prev.failures + (success ? 0 : 1);
    const timeouts = prev.timeouts + (timedOut ? 1 : 0);
    const avgExecutionTime = Math.round(
      (prev.avgExecutionTime * prev.invocations + executionTime) / invocations,
    );
    this.subAgentMetrics.set(agentType, {
      invocations,
      failures,
      timeouts,
      avgExecutionTime,
      lastExecutionTime: executionTime,
    });
  }

  private withSubTaskTimeout<T>(promise: Promise<T>, timeoutMs: number, taskId: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Sub-task ${taskId} timed out after ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private formatSubAgentReportsForMaster(results: SubAgentResult[]): string {
    return results
      .map(
        (r) =>
          `[report taskId=${r.taskId} agent=${r.agentType} success=${r.success}${r.executionTime != null ? ` ms=${r.executionTime}` : ""}]\n${r.result}`,
      )
      .join("\n\n---\n\n");
  }

  private recordSuccess(strategy: string, subTaskCount: number): void {
    this.executionHistory.push({
      timestamp: new Date().toISOString(),
      taskId: `turn-${Date.now()}`,
      duration: 0,
      success: true,
      strategy,
      subTaskCount,
    });
    this.metrics.successRate = this.calculateSuccessRate();
  }

  private log(message: string, data?: unknown): void {
    if (this.config.verbose) {
      console.log(`[MasterAgent] [${new Date().toISOString()}] ${message}`, data ? JSON.stringify(data) : "");
    }
  }

  private calculateSuccessRate(): number {
    if (this.executionHistory.length === 0) return 100;
    const recentHistory = this.executionHistory.slice(-50);
    const successCount = recentHistory.filter((h) => h.success).length;
    return Math.round((successCount / recentHistory.length) * 100);
  }

  public getMetricsSnapshot(): PerformanceMetrics {
    this.metrics.successRate = this.calculateSuccessRate();
    return { ...this.metrics };
  }

  public getExecutionHistory(limit = 10): Array<unknown> {
    return this.executionHistory.slice(-limit).reverse();
  }

  public adjustConcurrency(newMaxParallel: number): void {
    const rtConfig = getAgentRuntimeConfig();
    const maxAllowed = rtConfig.masterDelegation.maxParallelSubAgents;
    this.config.maxParallelTasks = Math.min(Math.max(1, newMaxParallel), maxAllowed);
    this.log("Concurrency adjusted", { maxParallelTasks: this.config.maxParallelTasks, maxAllowed });
  }

  public getSubAgentMetricsSnapshot(): Record<SubAgentType, SubAgentPerformanceMetrics> {
    const types: SubAgentType[] = ["life", "tech", "info", "creative", "security", "general"];
    const out = {} as Record<SubAgentType, SubAgentPerformanceMetrics>;
    for (const t of types) {
      out[t] = this.subAgentMetrics.get(t) ?? this.emptySubAgentMetrics();
    }
    return out;
  }

  public getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const metrics = this.getMetricsSnapshot();
    if (metrics.successRate < 80) {
      suggestions.push("成功率较低，建议检查子 Agent 工具权限、超时和失败报告。");
    }
    if (metrics.fallbackCount > metrics.totalTasks * 0.2) {
      suggestions.push("降级频率较高，建议检查主 Agent 委派工具链路。");
    }

    const subMetrics = this.getSubAgentMetricsSnapshot();
    for (const [type, sm] of Object.entries(subMetrics) as [SubAgentType, SubAgentPerformanceMetrics][]) {
      if (sm.invocations === 0) continue;
      const failRate = sm.failures / sm.invocations;
      if (failRate > 0.25) {
        suggestions.push(`${type} 子 Agent 失败率 ${Math.round(failRate * 100)}%，建议优化 taskDescription 或工具白名单。`);
      }
      if (type === "tech" && sm.timeouts > 0 && sm.timeouts / sm.invocations > 0.15) {
        suggestions.push(
          `tech 子 Agent 超时 ${sm.timeouts}/${sm.invocations} 次，可提高 TECH_SUBTASK_TIMEOUT_MS（当前 ${this.config.techSubtaskTimeoutMs}ms）。`,
        );
      }
      if (type === "life" && sm.avgExecutionTime > 45_000) {
        suggestions.push("life 子 Agent 平均耗时偏高，确认主 Agent 在 taskDescription 中写明消费类别以减少工具扫描。");
      }
      if (type === "info" && sm.avgExecutionTime > 30_000) {
        suggestions.push("info 子 Agent 平均耗时偏高，建议主 Agent 委派时缩小检索范围。");
      }
    }

    return suggestions;
  }
}
