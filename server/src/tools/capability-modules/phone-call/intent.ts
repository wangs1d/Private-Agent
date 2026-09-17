/**
 * phone_call.* 工具意图元数据 + 关键词分类映射。
 *
 * 边界区分（negativeAliases / negativeExamples）—— 与虚拟电话 / phone.dial 划清界限：
 *   - 虚拟电话（phone.virtual_call / phone.call_user）：站内应用内互拨，6 位虚拟号，无话费
 *   - phone.dial：仅打开拨号盘，无确认门与结果回填闭环
 *   - email_sms（发短信/邮件）、聊天（微信）通道
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const PHONE_CALL_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "phone_call.",
    metadata: {
      aliases: [
        "phone call", "real call", "make a call", "call for me", "call the restaurant",
        "打电话", "帮我打电话", "打个电话", "代打电话", "致电", "电话预约", "电话订座",
        "电话确认", "回电", "拨打电话", "打给商家", "打给对方", "电话代办",
      ],
      negativeAliases: [
        "virtual phone", "in-app call", "agent call", "call my agent",
        "sms", "text message", "email", "wechat",
        "虚拟电话", "应用内通话", "打给我的agent", "给agent打电话", "站内电话",
        "发短信", "发消息", "微信", "群呼", "营销外呼",
      ],
      examples: [
        "帮我打电话给这家餐厅预订周六晚上7点4个人的位子",
        "打个电话给快递员让他放驿站",
        "致电酒店确认一下我的订单改到周日",
        "帮我打电话问问理发店今天营业到几点",
      ],
      negativeExamples: [
        "给我的 agent 打个虚拟电话",
        "在应用里给我的助手打电话",
        "帮我发条短信告诉商家我不去了",
        "用拨号盘帮我填一下号码我自己说",
      ],
    },
  },
  {
    exact: "phone_call.prepare",
    metadata: {
      aliases: [
        "prepare call", "确认拨打", "生成拨打卡", "预约电话准备",
      ],
      examples: [
        "帮我预约，号码是 138xxxx1234",
        "打这个电话订座",
      ],
      negativeExamples: ["给我的 agent 打虚拟电话"],
    },
  },
  {
    exact: "phone_call.start",
    metadata: {
      aliases: ["开始拨打", "确认了，打吧", "拨出"],
      examples: ["（用户点击确认拨打后）开始拨出这个电话"],
      negativeExamples: ["用户还没确认就拨"],
    },
  },
  {
    exact: "phone_call.finish",
    metadata: {
      aliases: ["通话结果", "回填结果", "挂了", "打完了", "订到了"],
      examples: [
        "刚打完了，订到了周六7点，预约号A1024",
        "电话没人接",
      ],
      negativeExamples: ["还没打电话"],
    },
  },
  {
    exact: "phone_call.status",
    metadata: {
      aliases: ["电话打得怎么样", "通话状态", "拨打进度"],
      examples: ["刚才那个电话打得怎么样了"],
      negativeExamples: ["看看短信发出去没有"],
    },
  },
  {
    exact: "phone_call.list",
    metadata: {
      aliases: ["打电话记录", "外呼记录", "之前帮打的电话"],
      examples: ["之前帮我打的电话都有哪些"],
      negativeExamples: ["看看我的手机通话记录"],
    },
  },
];

export const PHONE_CALL_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "phone_call",
  keywords: [
    "phone call", "make a call", "call for me", "reservation call",
    "打电话", "帮我打", "打个电话", "致电", "电话预约", "电话订座",
    "电话确认", "回电", "拨打电话", "电话代办",
  ],
};
