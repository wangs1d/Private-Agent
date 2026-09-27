import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const MEMORY_GOVERNANCE_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "memory.forget",
    metadata: {
      aliases: [
        "forget", "delete memory", "stop watching", "remove from memory",
        "忘掉", "忘了它", "删除记忆", "把我忘了", "别记了", "不要再关注",
        "别再盯", "取消监控这个", "把这事忘了", "清掉关于",
      ],
      negativeAliases: [
        "我想不起来", "我忘了带钥匙", "记性不好", "忘了说什么",
        "记住", "记一下", "别忘了提醒我",
      ],
      examples: [
        "把关于前公司的记忆都删了吧",
        "别再帮我盯戴森吹风机的价格了",
        "我不再喜欢那个明星了，把关注取消",
        "把我答应小李的那事忘了，不做了",
        "删掉关于健身房的记录",
      ],
      negativeExamples: [
        "糟糕我忘了带手机",
        "帮我记一下这事别忘了",
        "我刚才想说什么来着",
      ],
    },
  },
  {
    exact: "activity.timeline",
    metadata: {
      aliases: [
        "what did you do", "activity log", "audit trail", "status report",
        "你都干了什么", "你做了什么", "最近帮我办了什么", "在忙什么",
        "有什么在等我确认", "行动记录", "工作汇报",
      ],
      negativeAliases: ["代办足迹上传", "上报结果", "帮我办一件事"],
      examples: [
        "你最近都帮我干了些什么",
        "你现在手上在忙什么",
        "有没有什么事在等我确认",
        "汇报一下最近的工作",
      ],
      negativeExamples: ["帮我订个餐厅", "这事办得怎么样了（单件事查进度）"],
    },
  },
];

export const MEMORY_GOVERNANCE_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "memory_governance",
  keywords: [
    "forget", "delete memory", "activity", "audit", "timeline",
    "忘掉", "忘了它", "删除记忆", "别再关注", "取消关注", "别再盯",
    "你都干了什么", "你做了什么", "最近办了什么", "在忙什么", "等我确认", "行为记录",
  ],
};
