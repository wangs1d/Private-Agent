import type { AgentReply } from "./types.js";

/**
 * 关键词意图识别路由（预算 / 购物 / 提醒）；未命中返回 null。
 */
export function tryMatchDemoKeywordRoute(text: string): AgentReply | null {
  const lower = text.toLowerCase();
  if (lower.includes("预算")) {
    return {
      text: "正在计算预算分配方案。",
      toolName: "budget.calculate",
      toolInput: { income: 12000, rent: 3500, food: 1800, transport: 600 },
    };
  }
  if (lower.includes("购物") || lower.includes("买")) {
    return {
      text: "正在分析购物建议。",
      toolName: "shopping.suggest",
      toolInput: { item: "手机", budget: 3000 },
    };
  }
  if (lower.includes("提醒") || lower.includes("起床") || lower.includes("闹钟")) {
    return {
      text: "正在为你创建定时提醒。",
      toolName: "reminder.plan",
      toolInput: { text: text.trim() },
    };
  }
  return null;
}
