/**
 * travel_booking.* 工具意图元数据 + 关键词分类映射。
 *
 * 边界区分：
 *   - ride_hailing.*：市内打车，非城际交通票务
 *   - travel.plan-itinerary / travel.search-poi：行程规划与 POI 探索，不报价不下单
 *   - travel.departure-advice：出发时间建议
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const TRAVEL_BOOKING_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "travel_booking.",
    metadata: {
      aliases: [
        "flight", "air ticket", "plane ticket", "train ticket", "rail", "hotel booking",
        "book flight", "book hotel", "ticket price", "fare", "compare prices",
        "机票", "航班", "火车票", "高铁", "动车", "车票", "酒店", "订房", "住宿",
        "订票", "订机票", "订酒店", "查票价", "比价", "价格对比", "多少钱",
        "去机场的机票", "出差", "差旅", "改签", "退票", "退改",
      ],
      negativeAliases: [
        "taxi", "ride hailing", "call a car", "打车", "叫车", "网约车",
        "itinerary planning", "travel guide", "行程规划", "攻略", "景点",
        "takeout", "外卖",
      ],
      examples: [
        "帮我查明天北京到上海的机票价格",
        "对比一下成都春熙路附近酒店的价格",
        "订一张后天去广州的高铁票",
        "MU5107 这个航班多少钱",
        "我要订国庆去三亚的机票和酒店",
      ],
      negativeExamples: [
        "帮我叫个车去机场",
        "规划一个成都三日游行程",
        "附近有什么好吃的",
      ],
    },
  },
  {
    exact: "travel_booking.search",
    metadata: {
      aliases: ["search flight", "flight price", "hotel price", "查机票", "查票价", "酒店价格", "比价", "报价"],
      examples: ["看看下周飞深圳的机票", "这家酒店一晚多少钱"],
      negativeExamples: ["确认下单", "取消订单"],
    },
  },
  {
    exact: "travel_booking.book",
    metadata: {
      aliases: ["book ticket", "order flight", "reserve hotel", "订票", "下单", "订这个航班", "就订这家酒店"],
      examples: ["就订这个航班，确认下单", "帮我订下来"],
      negativeExamples: ["先看看价格", "取消订单"],
    },
  },
  {
    exact: "travel_booking.status",
    metadata: {
      aliases: ["order status", "booking status", "订单状态", "机票订单", "查订单"],
      examples: ["我那个机票订单怎么样了", "查一下酒店订单状态"],
      negativeExamples: ["重新订一张"],
    },
  },
  {
    exact: "travel_booking.cancel",
    metadata: {
      aliases: ["cancel booking", "cancel order", "取消订单", "取消订票", "不要了"],
      examples: ["取消刚才的机票订单", "酒店订单帮我取消"],
      negativeExamples: ["改签到明天"],
    },
  },
  {
    exact: "travel_booking.refund",
    metadata: {
      aliases: ["refund ticket", "change flight", "reschedule train", "退票", "退签", "改签", "航班改签", "火车票改签", "退改"],
      examples: ["帮我把这张机票退了", "高铁票改签到明天上午", "酒店订单想退掉"],
      negativeExamples: ["还没付的订单直接取消"],
    },
  },
];

export const TRAVEL_BOOKING_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "travel_booking",
  keywords: [
    "flight", "air ticket", "train ticket", "rail", "high-speed rail", "hotel",
    "机票", "航班", "火车票", "高铁", "动车", "车票", "酒店", "订房",
    "订票", "查票价", "比价", "票价", "舱位", "经济舱", "二等座",
    "出差", "差旅", "往返", "单程", "直飞", "中转",
  ],
};
