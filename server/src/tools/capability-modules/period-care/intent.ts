/**
 * period.* 工具意图元数据 —— BM25 调权。
 *
 * 关键词刻意避开「安全/救命/求助」域（那是 safety-guard 的领地），
 * 用 negativeAliases 划清边界，避免「帮我」类模糊输入串台。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const PERIOD_CARE_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "period.",
    metadata: {
      aliases: [
        "period", "menstrual", "menstruation", "menstrual cycle", "cycle tracking",
        "period tracker", "pms", "cramps",
        "月经", "例假", "大姨妈", "姨妈", "生理期", "经期", "月经周期",
        "痛经", "月经不调", "见红", "月事", "好事儿", "那个来了",
      ],
      negativeAliases: [
        "救命", "求助", "报警", "110", "120", "紧急",
        "运动", "健身", "减肥", "体重",
      ],
      examples: [
        "我大姨妈来了",
        "月经今天结束了",
        "这个月痛经好厉害",
        "我下次月经大概什么时候来",
        "来之前两天提醒我",
        "我的周期一般是32天",
        "最近三次月经是哪几天",
        "my period started today",
        "when will my next period come",
      ],
      negativeExamples: [
        "帮我记录体重65公斤",
        "我肚子疼要打120",
        "帮我设置明天开会的提醒",
        "最近跑步心率怎么样",
      ],
    },
  },
];
