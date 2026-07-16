/**
 * agent_browser.* 工具意图元数据 + 关键词分类映射。
 *
 * `AGENT_BROWSER_INTENT_RULES` 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES`
 * 同结构（`ToolIntentRule`），通过 `setExtraIntentRules` 在启动时合并到全局规则表，
 * 供 tool-search BM25 排序调权。
 *
 * `AGENT_BROWSER_CATEGORY_MAPPING` 供 `openai-compatible-tool-loop.ts` 的
 * `TOOL_CATEGORY_MAPPINGS` 合并：命中关键词时把本模块全部工具名注入到候选分类。
 *
 * 边界区分（negativeAliases / negativeExamples）：
 *   - browser.fetch_page（只读单页抓取，无状态）
 *   - shopping.order.*（仅购物平台业务流程）
 *   - desktop.visual.run_task（操控用户桌面软件，非浏览器）
 *   - search_web / fetch_web（通用搜索/抓取，非交互式浏览器操作）
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const AGENT_BROWSER_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "agent_browser.",
    metadata: {
      aliases: [
        "browser", "web browser", "open page", "open url", "navigate to",
        "click button", "fill form", "type in", "scroll page", "web automation",
        "virtual browser", "agent browser", "web page operation",
        "浏览器", "打开网页", "打开网址", "打开链接", "去这个网站",
        "网页操作", "帮我操作", "在网页上", "填表单", "填表格",
        "点按钮", "点击按钮", "输入框", "网页上点", "滚动页面",
        "虚拟浏览器", "帮我浏览", "去网页",
      ],
      negativeAliases: [
        "search web", "web search", "fetch page", "fetch url", "read price",
        "shopping", "order", "place order", "buy", "checkout",
        "desktop", "computer use", "screen control", "run task",
        "搜索", "读价", "比价", "下单", "买东西", "购物",
        "操控电脑", "桌面", "屏幕控制",
      ],
      examples: [
        "帮我打开这个网址 https://example.com 看看",
        "去这个网站帮我填一下表单",
        "在网页上点一下登录按钮",
        "帮我操作一下这个网页",
        "open this url and click the submit button",
        "帮我在浏览器里查一下这个页面的内容",
      ],
      negativeExamples: [
        "帮我搜一下今天的新闻",
        "在淘宝下单这个商品",
        "帮我操控电脑打开微信",
        "读一下这个商品的价格",
      ],
    },
  },
  {
    exact: "agent_browser.open",
    metadata: {
      aliases: [
        "open url", "open page", "navigate to", "go to url", "visit website",
        "打开网址", "打开网页", "打开链接", "去网站", "访问网页", "去这个网址",
      ],
      examples: [
        "帮我打开 https://example.com",
        "去这个链接看看",
        "访问这个网页",
        "open this url for me",
      ],
      negativeExamples: [
        "帮我搜一下这个页面内容",
        "截个当前页面的图",
      ],
    },
  },
  {
    exact: "agent_browser.click",
    metadata: {
      aliases: [
        "click", "click button", "click link", "press button", "tap",
        "点击", "点按钮", "点链接", "按下", "点一下",
      ],
      examples: [
        "帮我点一下页面上的登录按钮",
        "点击提交按钮",
        "click the login button",
      ],
      negativeExamples: [
        "帮我输入用户名",
        "截个图看看",
      ],
    },
  },
  {
    exact: "agent_browser.type",
    metadata: {
      aliases: [
        "type", "input", "fill", "enter text", "write", "type in",
        "输入", "填写", "填入", "打字", "输入文本", "填表单",
      ],
      examples: [
        "帮我在搜索框里输入 iPhone 15",
        "填写用户名和密码",
        "type hello in the input box",
      ],
      negativeExamples: [
        "帮我点一下按钮",
        "等一下页面加载",
      ],
    },
  },
  {
    exact: "agent_browser.scroll",
    metadata: {
      aliases: [
        "scroll", "scroll down", "scroll up", "scroll to", "page down",
        "滚动", "往下拉", "往上拉", "滚到", "翻页", "向下滚",
      ],
      examples: [
        "帮我往下滚动一下页面",
        "滚动到页脚",
        "scroll down to see more",
      ],
      negativeExamples: [
        "帮我点一下按钮",
        "截个图",
      ],
    },
  },
  {
    exact: "agent_browser.extract_text",
    metadata: {
      aliases: [
        "extract text", "get text", "read page", "read content", "page text",
        "get content", "inspect page",
        "提取文本", "读取页面", "获取内容", "页面内容", "看看页面有什么", "读取网页",
      ],
      examples: [
        "帮我看看这个页面有什么内容",
        "提取页面文本",
        "read the page content for me",
      ],
      negativeExamples: [
        "帮我截个图",
        "帮我点按钮",
      ],
    },
  },
  {
    exact: "agent_browser.screenshot",
    metadata: {
      aliases: [
        "screenshot", "capture", "snapshot", "take picture",
        "截图", "截屏", "截个图", "页面截图", "抓图",
      ],
      examples: [
        "帮我截个当前页面的图",
        "截一下屏",
        "take a screenshot of the page",
      ],
      negativeExamples: [
        "帮我提取页面文本",
        "帮我点按钮",
      ],
    },
  },
  {
    exact: "agent_browser.wait_for",
    metadata: {
      aliases: [
        "wait for", "wait until", "wait element", "wait for selector",
        "等待", "等一下", "等元素出现", "等加载",
      ],
      examples: [
        "等一下页面加载完成",
        "等待弹窗出现",
        "wait for the result to appear",
      ],
      negativeExamples: [
        "帮我点按钮",
        "帮我截图",
      ],
    },
  },
  {
    exact: "agent_browser.close",
    metadata: {
      aliases: [
        "close browser", "close session", "close page", "finish browsing",
        "关闭浏览器", "关闭会话", "关掉网页", "结束浏览",
      ],
      examples: [
        "关闭浏览器",
        "用完了关掉",
        "close the browser session",
      ],
      negativeExamples: [
        "帮我打开新网页",
        "帮我截图",
      ],
    },
  },
];

export const AGENT_BROWSER_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "agent_browser",
  keywords: [
    // 中英关键词，覆盖用户口语
    "browser", "web page", "open url", "open page", "navigate", "visit",
    "click", "type in", "fill form", "scroll", "screenshot", "web automation",
    "virtual browser", "agent browser",
    "浏览器", "打开网页", "打开网址", "打开链接", "网页操作",
    "帮我操作", "在网页上", "填表单", "填表格", "点按钮", "点击",
    "输入框", "滚动页面", "截图", "虚拟浏览器", "去网站", "访问网页",
  ],
};
