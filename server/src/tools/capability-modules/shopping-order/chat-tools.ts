import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 购物/下单能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `shopping.order.*`）：
 *   - shopping.order.search  后台无头浏览器搜索商品
 *   - shopping.order.place   两阶段确认下单
 *   - shopping.order.track   查询订单状态/物流
 *   - shopping.order.cancel  两阶段确认取消订单
 *
 * 核心定位：在**服务端后台启动 Playwright 无头浏览器**，注入用户预先导入并授权
 * 的 Cookie，直接在后台完成下单/查单/取消，把结果呈现给用户。
 *
 * 与现有能力的边界：
 *   - browser.fetch_page：只读抓页读价，明文禁止下单；本工具突破此边界
 *   - shopping.suggest：仅比价建议，不执行下单；本工具真实提交订单
 *   - wallet.purchase：纯内存记账；本工具真实下单后可联动它记账
 *   - desktop.visual.run_task：操控用户电脑真实软件；本工具在服务端无头浏览器
 *   - meituan.create_order：调平台开放 API；本工具走浏览器，不依赖开放 API
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY：
 *   1. 用户不会每轮都下单，进核心会浪费 token
 *   2. 关键词触发（"下单" / "帮我买" / "在淘宝买"）时由 tool_discover 拉出
 *
 * 安全护栏（不依赖访问模式，沙箱下也可用）：
 *   - 须先导入平台 Cookie 并授权 agentAllowed=true
 *   - 金额上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000）
 *   - place / cancel 两阶段确认（5 分钟 TTL token）
 *   - 平台白名单 + 审计日志
 */
export const SHOPPING_ORDER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shopping.order.search",
      description:
        "在服务端后台启动 Playwright 无头浏览器，注入用户预先导入并授权的 Cookie，" +
        "打开指定购物平台的搜索页，读取商品列表（名称/价格/链接）。\n" +
        "适用场景：用户说「在淘宝搜 iPhone 15」「帮我在京东找一下卫生纸」「美团搜肯德基」等。\n" +
        "前置条件：用户须先导入目标平台 Cookie 并授权 agentAllowed=true" +
        "（POST /integrations/browser-sessions/import + /consent）。沙箱模式下也可用。\n" +
        "与 browser.fetch_page（只读读价）/ shopping.suggest（仅比价建议）的区别：" +
        "本工具为后续下单做准备，返回的商品列表可直接传给 shopping.order.place。\n" +
        "已实现 adapter 的平台：taobao/tmall/jd/meituan；" +
        "pdd/dianping/douyin 暂未实现 adapter，调用会返回「暂不支持」。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["taobao", "tmall", "jd", "meituan", "dianping", "pdd", "douyin"],
            description:
              "目标购物平台。taobao=淘宝, tmall=天猫, jd=京东, meituan=美团, " +
              "dianping=大众点评, pdd=拼多多, douyin=抖音商城。",
          },
          query: {
            type: "string",
            description: "搜索关键词，例如「iPhone 15」「卫生纸」「肯德基」。",
          },
          filters: {
            type: "object",
            properties: {
              maxPrice: {
                type: "number",
                description: "价格上限（CNY）。超出此价格的商品会被过滤掉。",
              },
              sort: {
                type: "string",
                enum: ["default", "price_asc", "price_desc", "sales"],
                description: "排序方式：default=默认, price_asc=价格升序, price_desc=价格降序, sales=销量优先。",
              },
              limit: {
                type: "integer",
                description: "返回结果条数上限，默认 5，最大 10。",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["platform", "query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.place",
      description:
        "在服务端后台无头浏览器中代用户下单。**两阶段确认**：\n" +
        "① confirm=false（默认）：走到结算页（不点提交订单按钮），返回订单摘要" +
        "（商品名/数量/单价/总价/收货地址）+ 确认 token + 结算页截图。LLM 须向用户复述摘要。\n" +
        "② confirm=true + confirmationToken：校验 token 后点击提交订单按钮，返回订单号。\n" +
        "前置条件：用户须先导入平台 Cookie 并授权 agentAllowed=true。沙箱模式下也可用。\n" +
        "安全：金额上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000），超阈值拒绝提交；" +
        "确认 token 5 分钟过期；不自动支付（只点提交订单，不点立即支付）。\n" +
        "与 wallet.purchase（仅记账）/ shopping.suggest（仅建议）的区别：本工具真实提交订单。\n" +
        "下单前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["taobao", "tmall", "jd", "meituan", "dianping", "pdd", "douyin"],
            description: "目标购物平台。",
          },
          item: {
            type: "string",
            description:
              "商品描述或商品详情页 URL。若是 URL 则直接打开该商品页；" +
              "若是关键词描述则先调 shopping.order.search 找到第一个匹配商品。",
          },
          quantity: {
            type: "integer",
            description: "购买数量，默认 1，上限 99。",
          },
          confirm: {
            type: "boolean",
            description:
              "是否执行阶段二（确认下单）。false 或缺省=阶段一（走到结算页返回摘要+token）；" +
              "true=阶段二（带 confirmationToken 完成提交订单）。",
          },
          confirmationToken: {
            type: "string",
            description: "阶段一返回的确认 token。仅在 confirm=true 时必填。",
          },
        },
        required: ["platform", "item"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.track",
      description:
        "在服务端后台无头浏览器中打开指定平台的订单列表页，读取订单状态/物流信息。\n" +
        "适用场景：用户说「帮我查一下淘宝订单」「京东那个订单到哪了」等。\n" +
        "前置条件：用户须先导入平台 Cookie 并授权 agentAllowed=true。沙箱模式下也可用。\n" +
        "未传 orderId 时返回最近订单列表；传 orderId 时优先查找指定订单。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["taobao", "tmall", "jd", "meituan", "dianping", "pdd", "douyin"],
            description: "目标购物平台。",
          },
          orderId: {
            type: "string",
            description: "订单号（可选）。不传则返回最近订单列表。",
          },
        },
        required: ["platform"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.order.cancel",
      description:
        "在服务端后台无头浏览器中取消指定订单。**两阶段确认**：\n" +
        "① confirm=false（默认）：生成确认 token，返回待取消订单摘要。\n" +
        "② confirm=true + confirmationToken：执行取消操作，返回结果。\n" +
        "前置条件：用户须先导入平台 Cookie 并授权 agentAllowed=true。沙箱模式下也可用。\n" +
        "取消前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["taobao", "tmall", "jd", "meituan", "dianping", "pdd", "douyin"],
            description: "目标购物平台。",
          },
          orderId: {
            type: "string",
            description: "要取消的订单号。",
          },
          confirm: {
            type: "boolean",
            description:
              "是否执行阶段二（确认取消）。false 或缺省=阶段一（返回确认 token）；" +
              "true=阶段二（带 confirmationToken 执行取消）。",
          },
          confirmationToken: {
            type: "string",
            description: "阶段一返回的确认 token。仅在 confirm=true 时必填。",
          },
        },
        required: ["platform", "orderId"],
        additionalProperties: false,
      },
    },
  },
];
