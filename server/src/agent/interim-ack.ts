/**
 * 「分阶段异步对话交互」即时确认应答（Interim Acknowledgement）。
 *
 * 设计目标
 * --------
 * 把一次用户请求拆成两段回复：
 *   1. 阶段一「即时确认应答」：路由多步/工具型请求时，服务端在几百毫秒内
 *      先推送一段非常短的"已收到 / 正在处理"短句（chat.assistant_interim）。
 *   2. 阶段二「结果交付」：原本的 chat.assistant_chunk / chat.assistant_done
 *      链路不变，把真实答案以流式方式交付给客户端。
 *
 * 中间穿插后台的搜索、工具调用、子 Agent 委派等计算任务。
 *
 * 模板策略
 * --------
 * 采用"路由模式驱动 + 轻量关键词润色"的固定模板：
 *   - 0 额外模型调用：纯本地查表 + 字符串裁剪。
 *   - 模式 + 关键词双维度分流，避免对闲聊/短消息过度打扰。
 *   - 返回 null 表示本轮不发送（如 fast_chat、master_only 简单任务、极短消息）。
 *
 * 客户端约定
 * --------
 *   - messageId 形如 `interim-${traceId}`，与正式回复 `assistant-${traceId}`
 *     解耦；客户端可独立渲染为"待办气泡"。
 *   - 收到首条 chat.assistant_chunk（messageId 形如 `assistant-${traceId}`）
 *     时，应让位/合并 interim 气泡。
 */
import type { LlmExecutionMode } from "./task-router.js";

/** 关键词 → 模板选择（仅在触发场景内做轻量润色）。 */
const KEYWORD_TEMPLATES: Array<{ pattern: RegExp; map: Record<LlmExecutionMode, string> }> = [
  {
    pattern: /天气|气温|下雨|下雪|温度|weather/i,
    map: {
      master_delegate: "好的，我先看一眼天气…",
      plan_execute: "我先确认下天气…",
      direct_llm: "让我先查一下天气…",
      master_only: "",
      fast_chat: "",
    },
  },
  {
    pattern: /搜索|查一下|查查|联网|搜一搜|search|browse/i,
    map: {
      master_delegate: "好的，我先联网去查…",
      plan_execute: "我先查一下资料…",
      direct_llm: "让我先查一下…",
      master_only: "",
      fast_chat: "",
    },
  },
  {
    pattern: /写|起草|文案|润色|改写|总结|摘要|翻译/i,
    map: {
      master_delegate: "好的，我先准备一下…",
      plan_execute: "我先理一下思路…",
      direct_llm: "让我先写一版…",
      master_only: "",
      fast_chat: "",
    },
  },
  {
    pattern: /代码|编程|debug|脚本|sql|api/i,
    map: {
      master_delegate: "好的，我先派个技术助手看一下…",
      plan_execute: "我先拆解一下实现步骤…",
      direct_llm: "让我先看一下代码…",
      master_only: "",
      fast_chat: "",
    },
  },
];

const DEFAULT_TEMPLATES: Record<LlmExecutionMode, string> = {
  master_delegate: "好的，我先派个助手去处理…",
  plan_execute: "好的，我先整理一下思路…",
  direct_llm: "好的，让我看一下…",
  master_only: "",
  fast_chat: "",
};

const NOISE_PREFIXES = /^(你好|hi|hello|hey|谢谢|thanks|thank you|再见|bye)[!！.。？?\s]*$/i;

/**
 * 是否应该在本轮发送即时确认应答。
 *
 * 仅在"用户明显会等一会儿"的场景返回 true：
 *   - master_delegate：子 Agent 委派链路（耗时最大）
 *   - plan_execute：计划-执行编排（多轮工具环）
 *   - direct_llm：直接 LLM + 工具调用（带工具的单轮）
 *
 * 排除：
 *   - fast_chat：单轮流式，第一 token 几百毫秒就能出，没有等待压力。
 *   - master_only 但任务非常短：master_only 在 simple_direct_task 路径下也很快。
 *   - 寒暄/超短消息：根本没人在意"等不等"。
 *   - 极长消息（> 2000 字符）：通常是大段资料输入，更适合一次性流式。
 */
export function shouldEmitInterimAck(
  text: string,
  mode: LlmExecutionMode,
  opts: { enabled: boolean } = { enabled: true },
): boolean {
  if (!opts.enabled) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  if (t.length < 4) return false;
  if (NOISE_PREFIXES.test(t)) return false;

  if (mode === "master_delegate" || mode === "plan_execute") return true;
  if (mode === "direct_llm") return true;
  return false;
}

/**
 * 根据路由模式 + 关键词挑选模板文本。
 * 返回 null 表示本轮不发送（与 shouldEmitInterimAck 一致）。
 */
export function buildInterimAckText(text: string, mode: LlmExecutionMode): string | null {
  if (!shouldEmitInterimAck(text, mode)) return null;

  const t = text.trim();
  for (const entry of KEYWORD_TEMPLATES) {
    if (entry.pattern.test(t)) {
      const candidate = entry.map[mode];
      if (candidate) return candidate;
    }
  }
  return DEFAULT_TEMPLATES[mode] || null;
}

/** interim 消息的 messageId 命名规则，与正式回复 `assistant-${traceId}` 区分。 */
export function interimAckMessageId(traceId: string): string {
  return `interim-${traceId}`;
}
