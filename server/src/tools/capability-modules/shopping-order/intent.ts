/**
 * shopping.order.* 工具意图元数据 + 关键词分类映射。
 *
 * `SHOPPING_ORDER_INTENT_RULES` 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES`
 * 同结构（`ToolIntentRule`），通过 `setExtraIntentRules` 在启动时合并到全局规则表，
 * 供 tool-search BM25 排序调权。
 *
 * `SHOPPING_ORDER_CATEGORY_MAPPING` 供 `openai-compatible-tool-loop.ts` 的
 * `TOOL_CATEGORY_MAPPINGS` 合并：命中关键词时把本模块全部工具名注入到候选分类。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - shopping.suggest（仅比价建议，不执行下单）
 *   - wallet.purchase / wallet（仅记账，不真实下单）
 *   - browser.fetch_page / 读价（只读抓页，明文禁止下单）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const SHOPPING_ORDER_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "shopping.order.",
    metadata: {
      aliases: [
        "shopping", "order", "place order", "buy now", "add to cart", "checkout",
        "purchase", "online shopping", "place an order",
        "购物", "下单", "购买", "买东西", "买", "网购", "帮我买", "在淘宝下单",
        "在京东买", "在美团点", "点外卖", "下单买", "加入购物车", "结算",
      ],
      negativeAliases: [
        "suggest", "recommend", "compare price", "price compare",
        "wallet", "balance", "record expense", "bookkeeping",
        "fetch page", "read price", "screenshot",
        "建议", "推荐", "比价", "余额", "记账", "记录消费", "读价", "截图",
      ],
      examples: [
        "在淘宝帮我买个 iPhone 15",
        "帮我在京东下单卫生纸",
        "在美团点一份肯德基",
        "帮我下单这个商品",
        "place an order on taobao for a phone case",
      ],
      negativeExamples: [
        "帮我推荐买什么手机",
        "记一下这笔消费",
        "帮我读一下淘宝这个商品价格",
        "截个屏看看当前页面",
      ],
    },
  },
  {
    exact: "shopping.order.search",
    metadata: {
      aliases: [
        "search product", "find product", "search item", "look for product",
        "搜商品", "搜索商品", "找商品", "在淘宝搜", "在京东搜", "在美团搜",
        "搜一下", "找一下",
      ],
      examples: [
        "在淘宝搜一下 iPhone 15",
        "帮我在京东找一下卫生纸",
        "美团搜肯德基",
        "search for a phone case on taobao",
      ],
      negativeExamples: [
        "帮我下单这个商品",
        "查一下我的订单",
      ],
    },
  },
  {
    exact: "shopping.order.place",
    metadata: {
      aliases: [
        "place order", "submit order", "buy now", "checkout", "confirm order",
        "下单", "购买", "买东西", "帮我买", "下单买", "提交订单", "确认下单", "结算",
      ],
      examples: [
        "帮我在淘宝下单这个 iPhone 15",
        "在京东买一箱牛奶",
        "美团点一份肯德基套餐",
        "place this order for me",
      ],
      negativeExamples: [
        "帮我推荐买什么手机",
        "记一下这笔消费",
        "帮我读一下这个商品价格",
      ],
    },
  },
  {
    exact: "shopping.order.track",
    metadata: {
      aliases: [
        "track order", "check order", "order status", "logistics", "shipping",
        "查订单", "查询订单", "订单状态", "物流", "到哪了", "订单到哪了", "看下我的订单",
      ],
      examples: [
        "帮我查一下淘宝订单",
        "京东那个订单到哪了",
        "查一下我的美团订单状态",
        "track my order on taobao",
      ],
      negativeExamples: [
        "帮我下单这个商品",
        "取消这个订单",
      ],
    },
  },
  {
    exact: "shopping.order.cancel",
    metadata: {
      aliases: [
        "cancel order", "refund", "return order", "revoke order",
        "取消订单", "退款", "退货", "撤回订单", "不要了",
      ],
      examples: [
        "帮我取消淘宝这个订单",
        "京东那个订单不要了，取消掉",
        "cancel this order for me",
      ],
      negativeExamples: [
        "帮我下单这个商品",
        "查一下我的订单",
      ],
    },
  },
];

export const SHOPPING_ORDER_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "shopping_order",
  keywords: [
    // 中英关键词，覆盖用户口语
    "shopping", "order", "buy", "purchase", "checkout", "cart", "place order",
    "track order", "cancel order", "refund",
    "taobao", "tmall", "jd", "jingdong", "meituan", "pdd", "pinduoduo",
    "dianping", "douyin", "tiktok shop",
    "购物", "下单", "购买", "买东西", "买", "网购", "帮我买",
    "淘宝", "天猫", "京东", "美团", "拼多多", "点评", "抖音",
    "点外卖", "加入购物车", "结算", "提交订单",
    "查订单", "订单状态", "物流", "取消订单", "退款", "退货",
  ],
};
