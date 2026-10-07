/**
 * L1 语义意图分类调用（2026-10-07 契约化重构：结构化调用的第一个完整消费者）。
 *
 * 职责收敛：本文件只做路由特有三件事——prompt 组装、intent JSON 解析、
 * 顺带情绪/话题辅助分析（与意图 JSON 同体输出，省一次每轮 LLM 调用）。
 * 调用参数（预算/超时/json mode）、超时竞速、网关式重试全部委托
 * {@link structuredCall} 契约助手——换路由模型时这些行为按 provider
 * 能力档案自适应，本文件零改动。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import { structuredCall } from "../external-model/structured-call.js";
import { resolveRouteCallParams } from "../external-model/provider-profiles.js";
import type { RouteDecision } from "./task-router.js";
import { parseIntentJson, type IntentLabel } from "./intent-router.js";

export function buildRoutePrompt(
  text: string,
  recentUserTurns: string[],
  activeTasksSummary?: string,
): string {
  const lines: string[] = [
    "你是双面架构的意图路由器。对话面对话直答（零工具）；任务面在后台真正调用工具把事办完。你的任务只有一个：判断这条用户消息的意图标签。",
    "",
    '只输出一个 JSON 对象，格式：{"intent":"标签","confidence":0.0到1.0,"sentiment":<-1到1的小数，用户情绪>,"tags":[<最多3个情绪标签>],"topics":[<1-3个话题关键词>],"search_query":"<搜索词>"}。不要输出任何其他字符。',
    "intent 必须且只能取以下封闭集之一：",
    "- chat：纯对话。寒暄、情绪、观点交流、评价、闲聊追问，凭常识或已有上下文就能答的内容。问你的近况/想法/感受也是 chat。",
    "- knowledge_qa：常识/知识问答（不依赖实时信息，如原理、历史、解释）。",
    "- realtime_lookup：需要外部**公开网络**实时信息——新闻、某人（公众人物/他人）近况、最新消息、价格行情、热搜、比分、排片、天气等，答准了必须现查的。",
    "- personal_data_query：查**用户自己的**数据——我的/我自己的日程、提醒、订单、快递、钱包余额、账单、消息、通话、相册照片、设备状态等。这类走系统内工具直查，绝不联网搜索。",
    "- media_retrieval：找图片/照片/视频/壁纸/表情包。",
    "- action_write：写数据/有副作用的操作——创建或修改日程提醒、发消息、下单、支付等。",
    "- multi_step_task：多步操作、操作软件/电脑/设备、或以上都没贴切的办事请求。",
    "- meta_capability：询问你能做什么/系统状态。",
    "",
    "判定要点：",
    "- 实时信息类哪怕没有「查/搜」字样（如「刘浩存最近的消息」「今天A股怎么样」「比特币现在什么价」）也是 realtime_lookup。",
    "- 「我的订单/我的日程/我钱包」这类**用户本人数据**是 personal_data_query，不是 realtime_lookup——哪怕它也「需要现查」，查的地方是系统内数据不是公开网络。",
    "- 天气查询是 realtime_lookup（需要实时数据）；感叹天气（「今天天气真好」）是 chat。",
    "- 用户明确说「不要联网/别搜索/不用上网」时：按消息本来的知识属性判（能凭常识答→chat 或 knowledge_qa），绝不判 realtime_lookup。",
    "- confidence 表达你对标签判断的把握；判不准就给低分（<0.5），系统会自动走保守平面，不会出错。",
    "- intent=realtime_lookup 时 search_query 必填：结合最近对话解决指代（如「我老婆」指代哪个具体人名、「那家店」是哪家），生成一句完整、具体、可直接搜索的中文查询词；其他 intent 一律给空字符串。",
    "- 短追问（如「娱乐圈的」「新鲜的」）按它继承的话题判——语境见最近对话与后台任务。",
    "- sentiment/tags/topics 是顺带分析（情绪与话题），省略不报错，但尽量都给。",
    "",
  ];
  if (activeTasksSummary?.trim()) {
    lines.push("当前正在后台执行的任务（若本消息是在修正/取消这些任务，按其话题判意图）：");
    lines.push(activeTasksSummary.trim());
    lines.push("⚠️ 只是过问进度（「怎么样了/好了没/有结果了吗/还要多久」）→ 判 chat：");
    lines.push("任务结果会由系统自动回到对话里，本轮口头应一声即可，绝不再派新任务。");
    lines.push("");
  }
  if (recentUserTurns.length > 0) {
    lines.push("最近对话（最旧在前，仅供理解话题）：");
    for (const turn of recentUserTurns.slice(-4)) {
      lines.push(`- ${turn}`);
    }
    lines.push("");
  }
  lines.push(`用户消息：${text}`);
  return lines.join("\n");
}

/**
 * 解析路由输出里顺带携带的情绪/话题辅助分析（缺省/解析失败返回 undefined，
 * 消费方回退独立情绪分析调用）。
 */
function parseAuxAnalysis(
  raw: string | undefined | null,
): RouteDecision["auxAnalysis"] | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const score = Number(obj.sentiment);
    if (!Number.isFinite(score)) return undefined;
    const tags = Array.isArray(obj.tags)
      ? obj.tags.map((t) => String(t)).filter(Boolean).slice(0, 3)
      : [];
    const topics = Array.isArray(obj.topics)
      ? obj.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      sentimentScore: Math.max(-1, Math.min(1, score)),
      emotionTags: tags,
      topics,
    };
  } catch {
    return undefined;
  }
}

export type IntentRouteCall =
  | {
      ok: true;
      /** L1 意图判定（intent 已过封闭集校验） */
      intent: { intent: IntentLabel; confidence: number };
      /** 顺带情绪/话题辅助分析（缺省 undefined，消费方回退独立情绪分析） */
      auxAnalysis: RouteDecision["auxAnalysis"] | undefined;
      /** 原始输出（realtime 轮 search_query 二次提取用） */
      raw: string;
      attempts: number;
    }
  | {
      ok: false;
      reason: "provider_disabled" | "timeout" | "call_error" | "unparseable";
      attempts: number;
    };

/**
 * L1 结构化意图分类：预算/超时/json mode 按路由 provider 能力档案自适应，
 * 超时/坏输出/异常网关式重试（细节见 structured-call）。永不抛错。
 */
export async function classifyIntentByLlm(
  provider: ExternalChatProvider,
  routeSessionId: string,
  text: string,
  recentUserTurns: string[] = [],
  activeTasksSummary?: string,
): Promise<IntentRouteCall> {
  const prompt = buildRoutePrompt(text, recentUserTurns, activeTasksSummary);
  const { maxOutputTokens, timeoutMs, jsonMode } = resolveRouteCallParams(provider);
  const result = await structuredCall<{ intent: IntentLabel; confidence: number }>(
    provider,
    routeSessionId,
    prompt,
    {
      label: "intent_route",
      maxOutputTokens,
      timeoutMs,
      jsonMode,
      parse: (raw) => parseIntentJson(raw),
    },
  );
  if (!result.ok) {
    return { ok: false, reason: result.reason, attempts: result.attempts };
  }
  return {
    ok: true,
    intent: result.value,
    auxAnalysis: parseAuxAnalysis(result.raw),
    raw: result.raw,
    attempts: result.attempts,
  };
}
