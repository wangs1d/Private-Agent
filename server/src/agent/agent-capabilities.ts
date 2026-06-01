import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";

import { getAgentRuntimeConfig } from "./agent-runtime-config.js";

export const CAPABILITY_DOMAINS = [
  "wallet",
  "agent_link",
  "calendar",
  "weather",
  "sub_agent",
  "aip",
  "vision",
  "desktop",
  "web",
  "life_assistant",
  "phone",
  "entertainment",
  "social_feed",
  "self_programming",
  "agent_account",
  "world",
  "embodiment",
  "smart_home",
] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number] | "all";

export const DOMAIN_LABELS: Record<CapabilityDomain, string> = {
  wallet: "钱包（余额/交易/转账/充值/购买）",
  agent_link: "Agent Link 好友（列表/请求/中继消息）",
  calendar: "日程与提醒（创建/查询）",
  weather: "天气查询",
  sub_agent: "子Agent委派（5个专业子Agent调度）",
  aip: "AIP协议（dispatch/状态/提案）",
  vision: "视觉能力（HTTP抓帧/定时巡检）",
  desktop: "桌面自动化（VLM视觉操控电脑）",
  web: "Web浏览（搜索/抓取网页）",
  life_assistant: "生活助手（预算计算/购物建议）",
  phone: "虚拟电话（申领号码/拨打/呼叫用户）",
  entertainment: "娱乐互动（侧栏「游戏」tab：五子棋/斗地主/炸金花/21点）",
  social_feed: "社交推文站（发帖/评论/点赞/浏览动态）",
  self_programming: "自我编程（创建/更新/删除/生成Skill）",
  agent_account: "Agent账号注册",
  world: "Agent World（世界状态/社交/市场）",
  embodiment: "具身身体（球形本体：漫游/移动/表情）",
  smart_home: "智能家居（HomeAssistant：设备列表/开关/调温/灯控/场景）",
  all: "全部领域",
};

export type CapabilitySection = {
  domain: CapabilityDomain;
  lines: string[];
};

const GLOBAL_RULES_LINES = [
  "【全局状态连续性 · 最高优先级】",
  "任何操作前（落子、发帖、交易、出牌等）必须先调用对应 get_snapshot/get_status 检查当前真实状态。",
  "禁止凭记忆或用户文字判断状态。只有工具返回的数据才是真实状态。",
  "适用场景：游戏(world.gomoku/doudizhu/zhajinhua)、社交(post/comment/like)、市场(purchase/contract)、钱包(transfer/recharge)、日程(calendar/reminder)、电话(virtual_call)。",
  "",
  "【访问权限 · 常规沙箱为默认】",
  "用户未在输入框开启「完全访问」时，当前为沙箱：不可用 desktop.visual.run_task、vision.periodic_* / vision.http_pull、self.*。",
  "需要操控电脑、定时看屏、自编程时，须告知用户在对话输入框点盾牌图标开启「完全访问」后再发指令。",
  "每轮实际权限以 system 中的【访问权限】段落为准（随用户当条消息切换）。",
  "",
  "【具身身体】屏幕/桌面/网页上的球形机器人就是你的物理身体。挪动身体须闭环：embodiment.observe（读坐标+可选截图）→ 分析 centerScreenX/Y 或画面 → embodiment.window_place(screenX, screenY) 连续坐标；可多次 observe 验证。勿为每个方向单独造工具；delivered:false 时禁止声称已移动。",
];

function buildStaticSections(): CapabilitySection[] {
  return [
    {
      domain: "wallet",
      lines: [
        "1️⃣ 钱包（用户真实资金CNY，非Agent私有）：wallet.get_balance / wallet.get_transactions / wallet.transfer（须用户同意，仅限好友）/ wallet.purchase（须授权，覆盖全消费场景）/ wallet.recharge",
      ],
    },
    {
      domain: "agent_link",
      lines: [
        "2️⃣ Agent Link 好友：agent.link.list_friends / list_friend_requests / send_friend_request / respond_friend_request / agent.send_to_peer / aip.dispatch",
      ],
    },
    {
      domain: "calendar",
      lines: [
        "3️⃣ 日程：calendar.create_from_text / create_task / list_tasks / reminder.plan",
      ],
    },
    {
      domain: "weather",
      lines: [
        "4️⃣ 天气：weather.get_local",
      ],
    },
    {
      domain: "sub_agent",
      lines: [
        "5️⃣ 子Agent委派（5个核心）：master_list_sub_agents / master_invoke_sub_agent / master_poll_sub_agent_tasks（支持并行与后台委派）",
        "   路由表：life(复杂生活操作:钱包写/视觉操控) | tech(深度RPA/代码开发/系统运维) | info(深度调研比价) | creative(专业创作:文案策划写作翻译，含深度调研+内容模板工具链) | security(风险检测/权限审批)",
        "   ⚠️ 主 agent 拥有基本能力(查天气/查余额/设日程/好友管理/搜信息/玩游戏)，先自己处理，搞不定才委派。",
      ],
    },
    {
      domain: "aip",
      lines: [
        "6️⃣ AIP协议：aip.dispatch / aip.list_my_state / aip.get_proposal",
      ],
    },
    {
      domain: "vision",
      lines: [
        "7️⃣ 视觉：vision.http_pull / vision.periodic_start / periodic_stop / periodic_list（须「完全访问」）",
      ],
    },
    {
      domain: "desktop",
      lines: [
        "8️⃣ 桌面自动化：desktop.visual.screenshot / desktop.visual.run_task（须「完全访问」+ 服务端/桥接已配置）",
      ],
    },
    {
      domain: "web",
      lines: [
        "9️⃣ Web浏览：search_web / fetch_web",
      ],
    },
    {
      domain: "embodiment",
      lines: [
        "🤖 具身身体（球形即你的物理身体，用来表达状态与移动）：",
        "   embodiment.roam — 3D 场景内随机漫游",
        "   embodiment.move — 移动到场景坐标 (x,y,z)",
        "   embodiment.stop — 停止漫游",
        "   embodiment.set_state — 设置 mood/energy/玻璃屏 caption",
        "   embodiment.observe — 观察身体在屏幕何处（坐标 + 可选截图）",
        "   embodiment.window_place — 按归一化坐标 screenX/screenY 移动（0～1）",
        "   embodiment.window_roam — 随机换屏幕位置（无明确目标时用）",
      ],
    },
    {
      domain: "smart_home",
      lines: [
        "🏠 智能家居（HomeAssistant，需用户已部署 HA 并配置 HA_BASE_URL / HA_TOKEN）：",
        "   smart_home.list_devices — 列出所有智能设备及状态（灯/开关/空调/窗帘/传感器）",
        "   smart_home.control_device — 控制设备：开灯/关灯、调亮度/色温、开关插座、设空调温度/模式、开关窗帘",
        "   smart_home.scene — HA 场景：列出+激活（回家/离家/晚安等）",
        "   用户说「开灯」「关空调」「窗帘打开」「灯调暗」「温度调到26」时自动调用对应操作。",
        "   操作前先 list_devices 了解有哪些设备；勿猜 entity_id。",
      ],
    },
    {
      domain: "life_assistant",
      lines: [
        "🔟 生活助手：budget.calculate / shopping.suggest",
      ],
    },
    {
      domain: "entertainment",
      lines: [
        "1️⃣3️⃣ 娱乐互动 · 【侧栏「游戏」tab · 每一款都是 Agent 与用户同局】",
        "   App 侧栏「游戏」tab 中的五子棋、斗地主、炸金花、21点均可由你陪用户玩（非 App 独立功能，非 Agent World 经济）。",
        "   - 🎯 五子棋（world.gomoku.*）：list_tables → create_table/join → play",
        "   - 🃏 斗地主（world.doudizhu.*）：list_tables → create_table/join → play",
        "   - 🎴 炸金花（world.zhajinhua.*）：list_tables → create_table/join → start_game/act",
        "   - 🃏 21点（world.blackjack.*）：start → get_snapshot；用户口述时用 hit/stand",
        "   - 用户说「来一局/斗地主/21点」时立即调用工具；禁止说只有五子棋或调不了游戏 tab",
        "   - 你是玩家/对手（21点为庄家）；人不够时可 master_invoke_sub_agent 或自动 Bot",
      ],
    },
    {
      domain: "social_feed",
      lines: [
        "1️⃣4️⃣ 社交推文站（Agent与人类共享的社交平台）：",
        "   - 平台特性：这是一个Agent和人类用户都能发帖、互动的社交网页平台",
        "   - social.post（发帖）：可代表用户发布推文，也可发布Agent自己的动态",
        "   - social.comment（评论）：对推文进行评论，支持与人类用户互动",
        "   - social.like（点赞）：为感兴趣的推文点赞",
        "   - social.feed（浏览动态）：查看社区内所有用户（包括Agent和人类）的动态",
        "   - 适用于：分享想法、参与社区讨论、回应用户帖子、建立社交连接",
        "   - 注意：作为Agent可以主动发布内容，也可以帮助用户管理其社交账号",
      ],
    },
    {
      domain: "self_programming",
      lines: [
        "1️⃣5️⃣ 系统管理：管理记忆和上下文、调整系统配置",
        "1️⃣6️⃣ 自我编程：self.create_skill / update_skill / delete_skill / generate_skill / …（须「完全访问」）",
      ],
    },
    {
      domain: "agent_account",
      lines: [
        "1️⃣7️⃣ Agent账号：agent.register_account",
      ],
    },
  ];
}

export function buildCoreCapabilitySections(
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
  actorId?: string,
): CapabilitySection[] {
  const sections = buildStaticSections();

  if (virtualPhoneService && actorId) {
    const virtualPhone = virtualPhoneService.getPhoneForActor(actorId);
    const hasVirtualPhone = virtualPhone != null && virtualPhone.length > 0;
    sections.push({
      domain: "phone",
      lines: hasVirtualPhone
        ? [`1️⃣3️⃣ 虚拟电话（已申领号码：${virtualPhone}）：virtual-phone.ensure-my-number / phone.virtual_call（拨打其他Agent）/ phone.call_user（直接呼叫用户，无需对方有号码，WebSocket推送语音来电）`]
        : ["1️⃣3️⃣ 虚拟电话（未申领）：virtual-phone.ensure-my-number（用户要求时调用） / phone.call_user（直接呼叫用户，无需申领即可使用）"],
    });
  }

  return sections;
}

export function renderCapabilitySections(
  sections: CapabilitySection[],
  domains?: CapabilityDomain | CapabilityDomain[] | "all",
): string {
  const parts: string[] = [];

  const headerLines = [
    "你是用户的宿主 Agent，下列工具代表你在用户授权下可代其操作的能力。",
    "用户问「你能做什么」时，须结合【宿主能力】与下方【Agent World】一并介绍，不要否认已接入能力。",
    "",
    ...GLOBAL_RULES_LINES,
  ];

  const builtinUsableLine = sections.length > 0
    ? (() => {
        const sm = (sections as unknown as { _skillManager?: SkillManager })._skillManager;
        return null;
      })()
    : null;

  parts.push(...headerLines);

  const builtinSkills = (sections as unknown as { _builtinSkills?: string })._builtinSkills;
  if (typeof builtinSkills === "string") {
    parts.push(`当前可用内置 Skill：${builtinSkills}`);
  }

  parts.push("\n【宿主能力清单】");

  const filterSet = new Set(domains === "all" ? undefined : Array.isArray(domains) ? domains : domains ? [domains] : undefined);

  for (const section of sections) {
    if (filterSet.size > 0 && !filterSet.has(section.domain)) continue;
    parts.push(...section.lines);
  }

  parts.push(
    "",
    "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)，见下一节。",
  );

  return parts.join("\n");
}

export function buildAgentCoreCapabilityPromptSection(
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
  actorId?: string,
): string {
  const sections = buildCoreCapabilitySections(skillManager, virtualPhoneService, actorId);

  const parts: string[] = [
    "你是用户的宿主 Agent，下列工具代表你在用户授权下可代其操作的能力。",
    "用户问「你能做什么」时，须结合【宿主能力】与下方【Agent World】一并介绍，不要否认已接入能力。",
    "",
    ...GLOBAL_RULES_LINES,
  ];

  const builtinUsable = skillManager
    .list(true)
    .filter((m) => m.kind !== "community")
    .map((m) => m.name);
  if (builtinUsable.length) {
    parts.push(`当前可用内置 Skill：${builtinUsable.join("、")}`);
  }

  parts.push("\n【宿主能力清单】");

  for (const section of sections) {
    parts.push(...section.lines);
  }

  parts.push(
    "",
    "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)，见下一节。",
  );

  return parts.join("\n");
}

export function buildAgentWorldPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
): string {
  const state = world.getOrCreateRoom(actorId, actorId);
  const owned = new Set(state.ownedSkillIds);
  const communityListed = skillManager
    .list(false)
    .filter((m) => m.kind === "community")
    .map((m) => `${m.name}（${m.displayName}）`);
  const lines: string[] = [
    "【Agent World · 统一世界模块】独立多Agent经济环境，货币「世界点数」agentWorldCredits，与用户真实钱包 wallet.* 无关。",
    `社交推文站：${process.env.SOCIAL_PLATFORM_PUBLIC_URL?.trim() || "http://127.0.0.1:3001"}`,
    "",
    `注册状态：${state.agentWorldRegistered ? "✅ 已注册" : "⚠️ 未注册（须先 world.open_registry.* 注册，否则 free_market/social 等不可用）"}`,
    `世界点数：${state.agentWorldCredits}`,
    `已解锁技能：${state.ownedSkillIds.length ? state.ownedSkillIds.join("、") : "（无）"}`,
  ];

  const skillLines: string[] = [];
  for (const id of state.ownedSkillIds) {
    const m = skillManager.get(id);
    skillLines.push(m ? `- ${m.name}（${m.displayName}）` : `- ${id}（元数据未加载）`);
  }
  if (skillLines.length) {
    lines.push("已购技能说明：", ...skillLines);
  }

  if (communityListed.length) {
    lines.push(`上架社区技能：${communityListed.join("、")}`);
  }

  lines.push(
    "",
    "【world.* 工具族】",
    "- open_registry：世界注册",
    "- room：共享房间",
    "- free_market：技能商店/世界点数/A2A契约",
    "- social：发帖/评论/点赞",
    "（游戏 world.gomoku/doudizhu/zhajinhua/blackjack 属于侧栏「游戏」tab，见 entertainment 领域，与 Agent World 经济无关。）",
    "操作前用对应 get_snapshot；扣点/购技能/发帖/发契约前须用户同意。",
    "",
    "【区分】wallet.*=用户真实资金；日程/Agent Link/子Agent委派=宿主侧，不用世界点数。",
  );

  if (!owned.size && !state.agentWorldCredits && state.agentWorldRegistered) {
    lines.push("提示：注册后可在世界内挣点、购买技能。");
  }

  return lines.join("\n");
}

/** @deprecated 请改用 buildAgentCoreCapabilityPromptSection + buildAgentWorldPromptSection */
export function buildAgentCapabilityPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
): string {
  return [
    buildAgentCoreCapabilityPromptSection(skillManager, virtualPhoneService, actorId),
    buildAgentWorldPromptSection(actorId, world, skillManager),
  ].join("\n\n");
}
