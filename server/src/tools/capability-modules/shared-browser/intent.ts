/**
 * shared_browser.* 工具意图元数据 + 关键词分类映射。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - agent_browser.*（服务端无头会话池，用户不可见、需 sessionId）
 *   - browser.fetch_page（只读单页抓取，无状态）
 *   - desktop.visual.run_task（操控桌面软件，非浏览器）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const SHARED_BROWSER_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "shared_browser.",
    metadata: {
      aliases: [
        "shared browser", "my browser", "user browser", "visible browser",
        "共用浏览器", "我的浏览器", "当前浏览器", "浏览器里", "帮我看网页",
        "打开网页", "打开网址", "打开链接", "去这个网站", "在浏览器里操作",
      ],
      negativeAliases: [
        "virtual browser", "headless", "session id",
        "search web", "fetch page", "shopping", "order",
        "desktop", "computer use", "screen control",
        "搜索", "读价", "比价", "下单", "购物",
        "操控电脑", "桌面", "屏幕控制", "无头",
      ],
      examples: [
        "在我打开的浏览器里帮我看一下这个页面",
        "用浏览器帮我查一下我刚登录的网站里的订单",
        "帮我在浏览器里打开这个链接并填写表单",
        "在我正看着的页面上点一下登录按钮",
      ],
      negativeExamples: [
        "帮我搜一下今天的新闻",
        "在后台打开一个无头浏览器抓取页面",
        "帮我操控电脑打开微信",
      ],
    },
  },
  {
    exact: "shared_browser.navigate",
    metadata: {
      aliases: [
        "open in my browser", "navigate", "open url", "打开网页", "打开网址",
        "打开链接", "去网站", "访问网页",
      ],
      examples: [
        "帮我在浏览器里打开 https://example.com",
        "去这个网站看看",
      ],
      negativeExamples: ["后台开个无头浏览器会话"],
    },
  },
  {
    exact: "shared_browser.read_page",
    metadata: {
      aliases: [
        "read page", "page content", "extract text", "读页面", "看看页面",
        "页面内容", "提取文本", "这个页面写的什么",
      ],
      examples: [
        "看看我浏览器里这个页面写了什么",
        "读一下当前页面的内容",
      ],
      negativeExamples: ["截个图"],
    },
  },
];

export const SHARED_BROWSER_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "shared_browser",
  keywords: [
    "shared browser", "my browser", "current page", "visible browser",
    "共用浏览器", "我的浏览器", "当前浏览器", "浏览器里", "帮我看网页",
    "打开网页", "打开网址", "页面内容", "读页面",
  ],
};
