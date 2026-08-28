import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";

/**
 * 强制工具路由（forced tool choice）：
 * 对时间/位置/时效性事实/显式电话等场景强制指定 tool_choice，
 * 避免 LLM 在事实型问题上编造。
 *
 * 规则：
 * 1. 显式电话请求 → 强制 phone_call_user
 * 2. 直接时间/日期/位置问题 → 强制 clock_get_current_time（Fast 模式跳过：
 *    system prompt 已注入 currentTime/userLocation，强制调用徒增 1 次 round trip）
 * 3. 时效性事实查询 → 强制 search_web
 *
 * 注：weather_get_local 不再强制路由，已并入 tool-router 延迟目录，
 * 由 tool-router 检索召回（见 tool-search/core-tool-library.ts）。
 */

const DIRECT_CLOCK_OR_LOCATION_RE =
  /现在.*几点|几点了|当前.*时间|今天.*几号|今天.*星期|我.*在哪|当前位置|current time|what time|where am i/i;

const FRESH_WEB_LOOKUP_RE =
  /search|look up|browse|web|latest|recent|news|headline|price|pricing|stock|market|quote|announcement|release|version|movie|ticket|showtime|box office|gossip|rumor|drama|search|查查|查一查|帮我查|帮我看看|搜索|搜一下|查一下|查询|联网|浏览|网页|最新|最近|新闻|资讯|头条|八卦|吃瓜|爆料|热搜|近况|怎么样了|怎么样子|什么情况|什么动静|价格|票价|股价|行情|大盘|a股|港股|美股|公告|发布|版本|电影|热映|排片|影讯/i;

// 扩展触发 fresh lookup 的场景：用户提到具体模型/产品名 + "新/最新/出/版/v\d|k\d" 等时效信号。
const FRESH_FACT_ENTITY_HINT_RE =
  /(?:kimi|gpt|claude|gemini|llama|qwen|deepseek|文心|通义|盘古|智谱|豆包|星火|混元|llm|大模型|foundation model|foundation_model)[\s\-_]*[a-z0-9]*\d|新出|新发|刚出|刚发|新版|新版本|新模型|新上|v\d|k\d|beta|rc\d|preview|alpha/i;

/** 时效性事实工具集（强制 search_web 判定 + 工具结果后处理共用）。 */
export const FRESH_FACT_TOOL_NAMES = new Set([
  "search_web",
  "fetch_web",
  "info.inspect_webpage",
  "info.navigate_site",
]);

export function shouldRequireFreshWebLookup(
  userText: string,
  apiTools: ChatCompletionTool[],
): boolean {
  const text = userText.trim();
  if (!text) return false;
  if (DIRECT_CLOCK_OR_LOCATION_RE.test(text)) return false;
  const hasFreshWebTrigger = FRESH_WEB_LOOKUP_RE.test(text) || FRESH_FACT_ENTITY_HINT_RE.test(text);
  if (!hasFreshWebTrigger) return false;
  return apiTools.some(
    (tool) =>
      tool.type === "function" &&
      typeof tool.function?.name === "string" &&
      FRESH_FACT_TOOL_NAMES.has(tool.function.name),
  );
}

export type ForcedToolChoice =
  | { type: "function"; function: { name: string } }
  | "auto";

export function resolveForcedToolChoice(
  userText: string,
  apiTools: ChatCompletionTool[],
  fastProfile?: boolean,
): ForcedToolChoice {
  // 1. 显式电话请求 → 强制 phone_call_user
  if (isExplicitPhoneCallRequest(userText)) {
    const hasPhoneCallTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "phone_call_user",
    );
    if (hasPhoneCallTool) {
      return { type: "function", function: { name: "phone_call_user" } };
    }
  }

  // 2. 直接时间/日期/位置问题 → 强制 clock_get_current_time
  //    ⚠️ 只在非 Fast 模式强制：Fast 模式 system prompt 已注入 currentTime，
  //    跳过强制省 1 次 round trip（LLM→tool→LLM 共 3 次网络往返）。
  if (!fastProfile && DIRECT_CLOCK_OR_LOCATION_RE.test(userText)) {
    const hasClockTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "clock_get_current_time",
    );
    if (hasClockTool) {
      return { type: "function", function: { name: "clock_get_current_time" } };
    }
  }

  // 3. 时效性事实查询 → 强制 search_web（避免 LLM 用训练截止知识回答"最新"类问题）
  if (shouldRequireFreshWebLookup(userText, apiTools)) {
    const hasSearchTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "search_web",
    );
    if (hasSearchTool) {
      return { type: "function", function: { name: "search_web" } };
    }
  }

  return "auto";
}
