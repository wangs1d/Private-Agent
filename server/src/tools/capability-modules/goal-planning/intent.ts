import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const GOAL_PLANNING_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "goal.plan.",
    metadata: {
      aliases: [
        "long term goal", "goal plan", "make a plan", "advance plan", "replan", "milestone",
        "计划", "目标", "长期目标", "做计划", "拆解", "推进", "下一步", "重排计划", "改计划",
        "搬家计划", "备考计划", "健身计划", "装修计划", "求职计划", "里程碑",
      ],
      negativeAliases: [
        "todo list", "reminder", "schedule today", "记一笔", "建提醒", "定闹钟",
        "今天的日程", "一次性任务", "订个外卖",
      ],
      examples: [
        "我想三个月内搬到东站附近，帮我规划一下",
        "帮我准备下个月的转岗答辩",
        "我的搬家计划进展怎么样了",
        "计划有变，我下个月出差，重排一下",
        "继续推进我的备考计划",
        "这个目标我不想要了，放弃吧",
      ],
      negativeExamples: [
        "今天下午三点提醒我开会",
        "帮我记一笔午饭花了 30 元",
        "现在帮我订一份外卖",
      ],
    },
  },
];

export const GOAL_PLANNING_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "goal_planning",
  keywords: [
    "goal", "plan", "milestone", "long term", "roadmap",
    "计划", "目标", "规划", "拆解", "推进", "里程碑", "长期",
    "搬家计划", "备考", "装修", "求职", "转岗", "存款计划",
  ],
};
