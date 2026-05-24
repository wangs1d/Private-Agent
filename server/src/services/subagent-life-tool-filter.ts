/**
 * life 子 Agent 按任务语义二次过滤工具白名单，减少无关工具暴露、加快决策。
 */

export type LifeTaskCategory = "purchase" | "social" | "daily" | "entertainment" | "visual";

const CATEGORY_MATCHERS: Record<LifeTaskCategory, RegExp> = {
  purchase:
    /买|购|订|预订|下单|支付|花钱|消费|外卖|酒店|打车|机票|火车|转账|汇款|充值|红包|余额|wallet|purchase|shop|trade|a2a/i,
  social: /朋友|好友|社交|消息|聊天|relay|friend|social|动态|红包/i,
  daily: /天气|日程|提醒|闹钟|schedule|weather|reminder|alarm|calendar|几点|叫我/i,
  entertainment: /五子棋|斗地主|炸金花|gomoku|doudizhu|zhajinhua|游戏|music|video|对局/i,
  visual: /电脑|网站|desktop|visual|屏幕|操作|打开网站|app|携程|美团|淘宝|京东|饿了么|12306|rpa/i,
};

const CATEGORY_TOOL_PARTS: Record<LifeTaskCategory, readonly string[]> = {
  purchase: ["wallet", "fund", "market", "shop", "purchase", "a2a", "trade"],
  social: ["social", "relay", "message", "chat", "friend", "agent.link", "agent.send", "aip", "peer"],
  daily: ["calendar", "schedule", "weather", "reminder", "alarm"],
  entertainment: ["gomoku", "music", "video", "doudizhu", "zhajinhua", "world."],
  visual: ["desktop", "visual", "vision"],
};

/** 根据任务描述识别 life 子任务类别（可多选）。 */
export function classifyLifeTaskCategories(taskText: string): Set<LifeTaskCategory> {
  const t = taskText.trim();
  const categories = new Set<LifeTaskCategory>();
  if (!t) {
    categories.add("purchase");
    categories.add("daily");
    return categories;
  }

  for (const [cat, re] of Object.entries(CATEGORY_MATCHERS) as [LifeTaskCategory, RegExp][]) {
    if (re.test(t)) categories.add(cat);
  }

  if (categories.size === 0) {
    categories.add("purchase");
    categories.add("daily");
  }

  // 消费类任务若涉及网站/App，补充视觉工具
  if (categories.has("purchase") && CATEGORY_MATCHERS.visual.test(t)) {
    categories.add("visual");
  }

  return categories;
}

/** 在 life 全量白名单内按任务类别收窄工具名列表。 */
export function filterLifeCapabilityTools(allLifeTools: readonly string[], taskText: string): string[] {
  const categories = classifyLifeTaskCategories(taskText);
  const allowedParts = new Set<string>();

  for (const cat of categories) {
    for (const part of CATEGORY_TOOL_PARTS[cat]) allowedParts.add(part);
  }

  // clock.* 始终保留（与 SUBAGENT_SHARED_REGISTRY_TOOLS 一致）
  allowedParts.add("clock");

  return allLifeTools.filter((tool) =>
    tool.startsWith("clock.") || [...allowedParts].some((part) => tool.includes(part)),
  );
}
