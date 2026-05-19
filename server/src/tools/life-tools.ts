import type { ToolRegistry } from "./tool-registry.js";

export function registerLifeTools(registry: ToolRegistry): void {
  registry.register("budget.calculate", async (input) => {
    const income = Number(input.income ?? 0);
    const rent = Number(input.rent ?? 0);
    const food = Number(input.food ?? 0);
    const transport = Number(input.transport ?? 0);
    const remain = income - rent - food - transport;
    return {
      summary: "预算计算完成",
      remain,
      advice: remain >= 0 ? "收支健康，可适度储蓄" : "收支为负，建议降低可选消费",
    };
  });

  registry.register("shopping.suggest", async (input) => {
    const item = String(input.item ?? "未知商品");
    const budget = Number(input.budget ?? 0);
    return {
      summary: "购物建议已生成",
      item,
      budget,
      suggestion: budget >= 200 ? "可选品质款，关注售后和保修" : "优先性价比款，注意核心参数",
    };
  });

  registry.register("reminder.plan", async (input) => {
    const subject = String(input.subject ?? "事项");
    const date = String(input.date ?? "今日");
    return {
      summary: "提醒计划已生成",
      subject,
      date,
      checklist: ["创建提醒", "提前1小时通知", "完成后归档"],
    };
  });
}
