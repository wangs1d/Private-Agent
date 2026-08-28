/**
 * 长期记忆召回门控（Recall Gate）—— 记忆架构重构检索层
 *
 * 原则：白天「只写不捞」，长期记忆检索从「每轮默认」改为「白名单触发」。
 * 未触发时跳过长期记忆检索（省 token + 根治召回串台/幻觉污染）。
 *
 * 触发白名单（满足任一）：
 *  1. 显式记忆线索：用户明确提到记忆/上次/之前说过等（MEMORY_EXPLICIT_RE /
 *     MEMORY_RECALL_HINT_RE / META_CONVERSATION_RECALL_RE）；
 *  2. 新会话开场：thread 很短（首轮/新会话），注入一次跨会话记忆衔接；
 *  3. 个人事实陈述：用户主动陈述自我信息（我叫/我在…工作），走个人化写入路径。
 *
 * 触发时检索 query 只用用户原文（禁止拼接任务/偏好/openLoops 等加料，
 * 那是召回串台的根因——检索结果永远偏向旧任务簇）。
 *
 * 当天的问题不走长期检索，只扫当日 journal（DailyJournalService.searchToday）。
 */

import {
  MEMORY_EXPLICIT_RE,
  MEMORY_RECALL_HINT_RE,
  isWindowDeixisShortCircuit,
} from "./memory-signal.js";

/** 元对话记忆线索（"上次聊天/最后一次说/还记得吗"类） */
export const META_CONVERSATION_RECALL_RE =
  /上次聊天|上回聊天|上次聊|上回聊|最后(?:一次)?(?:说|聊|谈)|最近(?:一次)?(?:说|聊|谈)|之前(?:说|聊|谈)了?什么|什么时候(?:聊|说|谈)|还记得.*(?:上次|上回|之前|最后)/i;

/**
 * 跨天/日期指代：没有显式"上次/之前"时，用户也可能在问"昨天/前天"发生的事。
 * 命中即触发长期/日志检索；同时供上层决定 journal 检索窗口（近 48h~72h，见 agent-core）。
 */
export const DATE_DEIXIS_RE =
  /昨天|昨天(?:白天|晚上|上午|下午|中午|凌晨|夜里|睡前)?|前天|大前天|昨儿|上周|上上周|上个星期|前几天|前两天|几天前|前两三天|今早|今天早上|今天上午|今天白天|昨晚|昨天晚上|夜里|凌晨/i;

/** 个人事实陈述（触发个人化写入路径的召回） */
const PERSONAL_FACT_RE = /我叫|我是|我在做|我最近在|我的项目|我正在|我计划|我住在|我在.*工作|我的生日/i;

export type RecallGateInput = {
  /** 用户本轮原文（唯一合法的检索 query 来源） */
  text: string;
  /** 当前 thread 非 system 消息数；< 0 表示未知（关闭新会话判定） */
  threadMessageCount?: number;
  /** 本轮是否为模糊指代/短追问（"那个方案呢""它后来怎么样"类），由调用方用 isAmbiguousFollowUpMessage 判定 */
  ambiguousFollowUp?: boolean;
};

export type RecallGateResult = {
  /** 是否触发长期记忆检索 */
  trigger: boolean;
  reason:
    | "memory_cue" // 显式记忆线索
    | "new_session" // 新会话开场
    | "personal_fact" // 个人事实陈述
    | "anaphora_escalation" // 指代消解失败升级：会话长于窗口，指代可能落在窗口外
    | "off"; // 未触发（默认）
};

/**
 * 新会话开场判定阈值：仅 thread 内 user/assistant 消息总数 ≤ 1 视为新会话
 * （本 session 首条用户消息）。
 * 原阈值 2 的误判（串台根因之一）：首轮问答完成后 thread 已有 2 条消息，
 * 第二轮（如任务追问"你确定？"）仍命中 new_session → relationshipMemory/
 * 跨会话记忆全量注入任务轮 → agent 用角色关系语境盖过任务语境。
 * 修正后跨会话衔接只在真正的会话开场注入一次。
 */
const NEW_SESSION_THREAD_MAX = 1;
/**
 * 指代升级判定阈值：thread 消息数超过此值说明早期轮次已被截出窗口，
 * 模糊指代（"那个/它/继续"）有可能指向窗口外内容，需要升级长期检索。
 */
const ANAPHORA_ESCALATION_THREAD_MIN = 24;

export function shouldRecallLongTerm(input: RecallGateInput): RecallGateResult {
  const text = input.text.trim();
  if (!text) return { trigger: false, reason: "off" };

  // 0. 窗口内纯指代短路："刚才/刚刚/前面/之前"且无跨会话升级词时，
  //    由 thread/STM 消解即可；触发检索会把更早会话旧记忆注入当前问题（串台根治）。
  if (isWindowDeixisShortCircuit(text)) {
    return { trigger: false, reason: "off" };
  }

  // 1. 显式记忆线索 / 跨天日期指代
  //    （"刚才/刚刚/前面"是窗口内指代，不进这里——由 thread/STM 消解，见 IN_WINDOW_DEIXIS_RE）
  if (
    MEMORY_EXPLICIT_RE.test(text) ||
    MEMORY_RECALL_HINT_RE.test(text) ||
    META_CONVERSATION_RECALL_RE.test(text) ||
    DATE_DEIXIS_RE.test(text)
  ) {
    return { trigger: true, reason: "memory_cue" };
  }

  // 2. 个人事实陈述
  if (PERSONAL_FACT_RE.test(text)) {
    return { trigger: true, reason: "personal_fact" };
  }

  // 3. 新会话开场（thread 未知时不触发，保守）
  const count = input.threadMessageCount ?? -1;
  if (count >= 0 && count <= NEW_SESSION_THREAD_MAX) {
    return { trigger: true, reason: "new_session" };
  }

  // 4. 指代消解失败升级：模糊指代/短追问 + 会话已长于注入窗口
  // （短会话内 LLM 从最近轮次即可消解；只有历史被截断后，"那个"才可能指向窗口外）
  if (input.ambiguousFollowUp && count >= ANAPHORA_ESCALATION_THREAD_MIN) {
    return { trigger: true, reason: "anaphora_escalation" };
  }

  return { trigger: false, reason: "off" };
}
