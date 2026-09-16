import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 共用浏览器能力 —— ChatCompletionTool schema。
 *
 * 工具族（`shared_browser.*`）：用户与 Agent 共用同一个客户端内嵌浏览器
 * （Flutter Windows 端 WebView2）。用户在「常用工具 → 浏览器」里正常浏览，
 * Agent 的操作用户实时可见，也可随时手动接管；用户已登录的站点 Agent
 * 直接以登录态操作，无需 Cookie 导入。
 *
 * 与 agent_browser.*（服务端 Playwright 无头会话池）的边界：
 *   - agent_browser.*：服务端后台无头浏览器，用户不可见，适合批量/后台任务
 *   - shared_browser.*：用户眼前的浏览器，适合需要用户登录态或用户在看的操作
 *     （如帮用户在已登录的电商/订票站查订单、填表），页面即时可见可接管
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY。
 */
export const SHARED_BROWSER_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shared_browser.navigate",
      description:
        "在用户正在使用的浏览器（客户端内嵌浏览器，用户可见）中打开指定 URL。\n" +
        "适用场景：帮用户打开网页并接续操作、用户说「帮我在浏览器里打开…」。\n" +
        "返回页面标题与最终 URL（等待加载完成）。浏览器未打开时返回明确错误。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要打开的 URL（http/https）。缺 scheme 时自动补 https://。",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.control",
      description:
        "控制用户浏览器的基础导航：后退（back）/前进（forward）/刷新（reload）/" +
        "停止加载（stop）/回到主页（home）。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["back", "forward", "reload", "stop", "home"],
            description: "导航动作。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.click",
      description:
        "点击用户浏览器当前页面中的元素。定位方式三选一：\n" +
        "  1. selector：CSS 选择器（#id / .class / tag[attr=v]）\n" +
        "  2. text：可见文本（精确或包含匹配，如「登录」「提交订单」）\n" +
        "  3. index：shared_browser.read_page 返回的可交互元素序号\n" +
        "点击前自动滚动到元素位置。建议先 read_page 拿到元素列表再操作。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器，与 text/index 三选一。" },
          text: { type: "string", description: "元素可见文本，与 selector/index 三选一。" },
          index: { type: "integer", description: "read_page 返回的可交互元素序号。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.type",
      description:
        "在用户浏览器当前页面的输入框中输入文本。默认清空后填入；submit=true 时" +
        "输入后回车提交（适用于搜索框）。selector 省略时自动定位第一个可见输入框。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "目标输入框的 CSS 选择器，省略则自动定位。" },
          text: { type: "string", description: "要输入的文本。" },
          submit: { type: "boolean", description: "输入后是否回车提交，默认 false。" },
          clear: { type: "boolean", description: "输入前是否清空输入框，默认 true。" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.scroll",
      description:
        "滚动用户浏览器当前页面：传 deltaY 相对滚动（正数向下），或 to=top/bottom 直达顶部/底部。",
      parameters: {
        type: "object",
        properties: {
          deltaY: { type: "integer", description: "相对滚动量（像素），正数向下。" },
          to: { type: "string", enum: ["top", "bottom"], description: "直达顶部/底部。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shared_browser.read_page",
      description:
        "读取用户浏览器当前页面：URL、标题、正文文本（截断）+ 可交互元素列表" +
        "（index/tag/text，供 shared_browser.click 的 index 参数使用）。\n" +
        "这是操作用户浏览器时的主要信息获取工具，操作前先调用它了解页面结构。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "只提取某元素的文本（CSS 选择器）。" },
          includeInteractive: { type: "boolean", description: "是否附带可交互元素列表，默认 true。" },
          maxChars: { type: "integer", description: "正文文本截断上限（字符），默认 4000。" },
        },
        additionalProperties: false,
      },
    },
  },
];
