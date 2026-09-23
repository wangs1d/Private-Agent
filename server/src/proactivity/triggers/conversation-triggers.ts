// ProactivityHub —— 对话内触发器（从 agent-core 迁移，新旧替换）
//
// 双层检测（零 LLM、零 token）：
//  1. 关键词种子层（正则）：高精度强线索直判
//  2. 语义泛化层（SemanticTriggerMatcher）：范例覆盖率评分，捕捉正则写不完的说法；
//     范例库由 InitiativeEngine 决策蒸馏在线扩充（learnExemplar），越用越准
//  - followup：等待结果/待办约定 → 主动承接跟进
//  （care 情绪关怀已下线：实测只有后台成本、无用户可见产出）
import type { ProactiveIntent } from "../proactivity-types.js";
import { detectSemanticHook } from "../semantic-trigger-matcher.js";

/** 对话主动类型 */
export type ConversationProactiveHookKind = "followup";

/** 一次对话内主动钩子检测结果 */
export type ConversationProactiveHook = {
  kind: ConversationProactiveHookKind;
  importance: "high" | "medium";
  title: string;
};

// 跟进/待办类：等待结果、未完成、待会要做、约定提醒 → importance medium
const CONV_HOOK_FOLLOWUP_RE =
  /待会|等会儿|晚点|回头再|之后提醒|别忘了|帮我记|记得.*提醒|等结果|等消息|等回复|看看.*进度|跟进一下|盯着点|留意一下|过几天|下礼拜|下周|这个周末|晚上再说|有空再说/i;

/** 检测一段用户文本里是否有值得主动承接的强线索；无则返回 null（保持静默） */
export function detectConversationProactiveHook(
  text: string | undefined | null,
): ConversationProactiveHook | null {
  if (!text) return null;
  if (CONV_HOOK_FOLLOWUP_RE.test(text)) {
    return { kind: "followup", importance: "medium", title: "用户有等待跟进或待办事项，值得主动承接" };
  }
  // 语义泛化层：正则未命中但范例覆盖达标（换一种说法的强线索）
  const semantic = detectSemanticHook(text);
  if (semantic) {
    return { kind: "followup", importance: "medium", title: "用户话里有待跟进的事（语义识别）" };
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
