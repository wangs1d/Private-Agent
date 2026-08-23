// ProactivityHub —— 对话内触发器（从 agent-core 迁移，新旧替换）
//
// 双层检测（零 LLM、零 token）：
//  1. 关键词种子层（正则）：高精度强线索直判
//  2. 语义泛化层（SemanticTriggerMatcher）：范例覆盖率评分，捕捉正则写不完的说法；
//     范例库由 InitiativeEngine 决策蒸馏在线扩充（learnExemplar），越用越准
//  - care：疲惫/压力/情绪波动 → 主动关怀
//  - followup：等待结果/待办约定 → 主动承接跟进
import type { ProactiveIntent } from "../proactivity-types.js";
import { detectSemanticHook } from "../semantic-trigger-matcher.js";

/** 对话主动类型 */
export type ConversationProactiveHookKind = "care" | "followup";

/** 一次对话内主动钩子检测结果 */
export type ConversationProactiveHook = {
  kind: ConversationProactiveHookKind;
  importance: "high" | "medium";
  title: string;
};

// 关怀/情绪类：疲惫、压力、情绪波动 → importance high
const CONV_HOOK_CARE_RE =
  /好累|累了|累死|睡不着|失眠|难受|烦死了|好烦|心烦|压力大|焦虑|难过|不开心|委屈|崩溃|撑不住|emo|丧|心情差|今天好差|头疼|不舒服|生病|发烧|加班|熬夜|心情不好|压力山大|好压抑/i;

// 跟进/待办类：等待结果、未完成、待会要做、约定提醒 → importance medium
const CONV_HOOK_FOLLOWUP_RE =
  /待会|等会儿|晚点|回头再|之后提醒|别忘了|帮我记|记得.*提醒|等结果|等消息|等回复|看看.*进度|跟进一下|盯着点|留意一下|过几天|下礼拜|下周|这个周末|晚上再说|有空再说/i;

/** 检测一段用户文本里是否有值得主动承接的强线索；无则返回 null（保持静默） */
export function detectConversationProactiveHook(
  text: string | undefined | null,
): ConversationProactiveHook | null {
  if (!text) return null;
  if (CONV_HOOK_CARE_RE.test(text)) {
    return { kind: "care", importance: "high", title: "用户在表达疲惫或情绪波动，值得主动关心一下" };
  }
  if (CONV_HOOK_FOLLOWUP_RE.test(text)) {
    return { kind: "followup", importance: "medium", title: "用户有等待跟进或待办事项，值得主动承接" };
  }
  // 语义泛化层：正则未命中但范例覆盖达标（换一种说法的强线索）
  const semantic = detectSemanticHook(text);
  if (semantic) {
    return semantic.kind === "care"
      ? { kind: "care", importance: "medium", title: "用户话里透着疲惫或情绪压力（语义识别）" }
      : { kind: "followup", importance: "medium", title: "用户话里有待跟进的事（语义识别）" };
  }
  return null;
}

/** 把对话钩子转为主动意图（stateNote 为按需感知的用户状态备注） */
export function buildConversationIntent(
  actorId: string,
  text: string,
  stateNote: string,
): ProactiveIntent | null {
  const hook = detectConversationProactiveHook(text);
  if (!hook) return null;
  return {
    actorId,
    kind: hook.kind,
    importance: hook.importance,
    title: hook.title,
    summary: `${hook.title}${stateNote ? `；${stateNote}` : ""}。用户原话：${text.trim().slice(0, 64)}`,
    mode: "speak",
    source: "conversation",
  };
}
