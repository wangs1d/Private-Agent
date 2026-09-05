import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";

/**
 * 强制工具路由（forced tool choice）——只保留高精度结构信号（2026-09-05 根源化）：
 * 对显式电话、直接时间/位置问题强制指定 tool_choice，避免 LLM 编造。
 *
 * 规则：
 * 1. 显式电话请求 → 强制 phone.call_user（结构化意图，非话题词）
 * 2. 直接时间/日期/位置问题 → 强制 clock.get_current_time（对话面 system prompt
 *    已注入 currentTime/userLocation，fastProfile 跳过强制省 1 次 round trip）
 *
 * 旧的「时效性事实 → 强制 search_web」分支（FRESH_WEB_LOOKUP_RE /
 * FRESH_FACT_ENTITY_HINT_RE 话题词表）已删除——"需不需要外部信息"由路由层
 * 语义分类承担，"有没有真的查"由工具循环的出口自检（风格判定）承担，
 * 不再用话题关键词在执行层预判。
 *
 * 注：weather_get_local 不强制路由，由 tool-router 检索召回。
 */

const DIRECT_CLOCK_OR_LOCATION_RE =
  /现在.*几点|几点了|当前.*时间|今天.*几号|今天.*星期|我.*在哪|当前位置|current time|what time|where am i/i;

export type ForcedToolChoice =
  | { type: "function"; function: { name: string } }
  | "auto";

export function resolveForcedToolChoice(
  userText: string,
  apiTools: ChatCompletionTool[],
  fastProfile?: boolean,
): ForcedToolChoice {
  // 1. 显式电话请求 → 强制 phone.call_user
  //    ⚠️ 工具名以注册名为准（点号分族，见 agent-phone-tools.ts）；
  //    旧实现写成下划线 phone_call_user，与注册名永不匹配，等于死分支。
  if (isExplicitPhoneCallRequest(userText)) {
    const hasPhoneCallTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "phone.call_user",
    );
    if (hasPhoneCallTool) {
      return { type: "function", function: { name: "phone.call_user" } };
    }
  }

  // 2. 直接时间/日期/位置问题 → 强制 clock.get_current_time
  //    ⚠️ 只在非 Fast 模式强制：Fast 模式 system prompt 已注入 currentTime，
  //    跳过强制省 1 次 round trip（LLM→tool→LLM 共 3 次网络往返）。
  if (!fastProfile && DIRECT_CLOCK_OR_LOCATION_RE.test(userText)) {
    const hasClockTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "clock.get_current_time",
    );
    if (hasClockTool) {
      return { type: "function", function: { name: "clock.get_current_time" } };
    }
  }

  return "auto";
}
