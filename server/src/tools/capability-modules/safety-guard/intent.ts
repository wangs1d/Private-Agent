/**
 * safety.* 工具意图元数据 —— BM25 调权。
 *
 * 求助类关键词（救命/害怕/跟踪…）必须高权重命中本模块；「紧急联系人」「借口
 * 电话」是配置面入口。与 period 域互斥（negativeAliases）。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const SAFETY_GUARD_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "safety.",
    metadata: {
      aliases: [
        "sos", "emergency", "emergency contact", "panic", "personal safety",
        "fake call", "escape call", "call me", "excuse to leave",
        "救命", "求救", "求助", "紧急", "紧急联系人", "紧急联络人",
        "害怕", "危险", "跟踪", "尾随", "被跟踪", "报警协助",
        "守护", "安全助手", "借口电话", "借口来电", "帮我打电话离开",
        "脱身", "装来电", "伪装来电", "打个电话救我",
        "借口", "找个借口", "借口离开", "给我打个电话", "打个电话给我", "打给我", "来个电话",
      ],
      negativeAliases: [
        "月经", "例假", "大姨妈", "痛经",
        "电话代打", "帮我叫外卖", "客服电话", "查电话号码",
      ],
      examples: [
        "救命，帮我通知紧急联系人",
        "我把妈妈设为紧急联系人 13812345678",
        "深夜打车有点害怕",
        "给我打个电话让我脱身",
        "给我打个电话，我要找个借口离开",
        "帮我妈设为主联系人",
        "我的紧急联系人有谁",
        "set my mom as emergency contact",
        "call me with an excuse to leave",
      ],
      negativeExamples: [
        "我妈什么时候生日",
        "帮我打电话给餐厅订座",
        "月经推迟了正常吗",
        "帮我查一下这个客服电话",
      ],
    },
  },
];
