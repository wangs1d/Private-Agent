/** `memory_summary` 行内话题标签：`[topic:wallet]` */
export const MEMORY_TOPIC_TAG_RE = /\[topic:([a-z][a-z0-9_-]{0,31})\]/i;

const TOPIC_RULES: ReadonlyArray<{ topic: string; patterns: RegExp[] }> = [
  { topic: "wallet", patterns: [/转账|汇款|钱包|余额|充值|支付|消费|红包|账单/i] },
  { topic: "calendar", patterns: [/日程|提醒|闹钟|安排|待办|会议|预约/i] },
  { topic: "world", patterns: [/世界|技能商店|自由市场|点数/i] },
  { topic: "entertainment", patterns: [/游戏|gomoku|五子棋|斗地主|炸金花|21点|对局|下棋|打牌/i] },
  { topic: "social", patterns: [/推文|发帖|评论|点赞|社交|动态/i] },
  { topic: "creative", patterns: [/文案|写作|翻译|润色|策划|故事|文章|ppt/i] },
  { topic: "tech", patterns: [/代码|编程|debug|脚本|自动化|rpa|部署|运维|api/i] },
  { topic: "info", patterns: [/搜索|调研|比价|查询|新闻|天气/i] },
  { topic: "life", patterns: [/外卖|点餐|订票|酒店|机票|电影|购物|网购/i] },
  { topic: "security", patterns: [/安全|风险|权限|审批|异常|诈骗|钓鱼/i] },
  { topic: "preference", patterns: [/记住|偏好|喜欢|讨厌|生日|纪念日|重要/i] },
];

/** 从用户/任务文本推断话题桶（统一窗口内软分区）。 */
export function inferMemoryTopic(text: string): string {
  const t = text.trim();
  if (!t) return "general";
  for (const { topic, patterns } of TOPIC_RULES) {
    if (patterns.some((p) => p.test(t))) return topic;
  }
  return "general";
}

/** 格式化为写入 `memory_summary` 的行首标签。 */
export function formatMemoryTopicTag(topic: string): string {
  const normalized = topic.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "general";
  return `[topic:${normalized}]`;
}

/** 从履历行解析话题；无标签视为 `general`（全局可见）。 */
export function extractMemoryTopicFromLine(line: string): string {
  const m = line.match(MEMORY_TOPIC_TAG_RE);
  return m?.[1]?.toLowerCase() ?? "general";
}

/**
 * 话题与当前 query 的对齐加分（供 relevance 排序）。
 * - 同话题：强加分
 * - 行无标签 / general：弱加分（全局事实）
 * - 明确跨话题：减分
 */
export function topicRelevanceBoost(lineTopic: string, queryTopic: string): number {
  if (queryTopic === "general") {
    return lineTopic === "general" ? 0.15 : 0;
  }
  if (lineTopic === "general") return 0.2;
  if (lineTopic === queryTopic) return 0.45;
  return -0.35;
}
