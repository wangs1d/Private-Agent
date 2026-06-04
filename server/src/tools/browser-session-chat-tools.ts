import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 任意模式可调用：查看用户已导入/授权的站点（不含 Cookie 明文）。 */
export const BROWSER_SESSION_LIST_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "browser.session.list",
    description:
      "列出用户已配置的电商/OTA 浏览器登录态（携程、淘宝、京东等）：是否已导入 Cookie、是否授权 Agent 读价。不含 Cookie 内容。未授权时引导用户在 App/设置中导入 Cookie 并开启 agentAllowed。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

/** 完全访问 + 用户 per-site agentAllowed 后方可调用。 */
export const BROWSER_FETCH_PAGE_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "browser.fetch_page",
    description:
      "使用用户已导入且已授权的站点 Cookie，在服务端无头浏览器打开 URL 并提取页面正文与价格线索（比价调研，不下单不支付）。仅支持携程/淘宝/京东/去哪儿/飞猪等同源 URL。须用户先在设置中导入 Cookie 并将 agentAllowed 设为 true。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的 https 页面（须与已授权站点同源）" },
        siteId: {
          type: "string",
          enum: ["ctrip", "taobao", "jd", "qunar", "fliggy"],
          description: "可选；省略时根据 url 自动识别",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const BROWSER_SESSION_CHAT_TOOLS: ChatCompletionTool[] = [
  BROWSER_SESSION_LIST_CHAT_TOOL,
  BROWSER_FETCH_PAGE_CHAT_TOOL,
];

export const BROWSER_SANDBOX_RESTRICTED_CHAT_TOOLS: ChatCompletionTool[] = [
  BROWSER_FETCH_PAGE_CHAT_TOOL,
];
