import { USER_AGENT_TOOL_SYSTEM_SUFFIX } from "@private-ai-agent/agent-world";
import {
  appendAgentAccessModeSystemSuffix,
  type AgentAccessMode,
  parseAgentAccessMode,
} from "./agent-access-mode.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import type { AgentPromptMemoryContext } from "../external-model/types.js";
import type { PersonalityCore } from "../brain/types.js";
import {
  extractMemoryTopicFromLine,
  inferMemoryTopic,
  topicRelevanceBoost,
} from "./memory-topic.js";

/**
 * 与 `USER_AGENT_TOOL_SYSTEM_SUFFIX` 首段一致，用于判断 system 是否已拼接工具说明（幂等追加）。
 * 参考 `prompt_builder` 设计：工具相关说明在单一处维护，避免各 Provider 分叉。
 */
export const AGENT_TOOL_SYSTEM_SUFFIX_MARKER = "【工具说明】";
export const CLOCK_TOOL_SYSTEM_SUFFIX_MARKER = "【时钟】";
export const WEB_SEARCH_SYSTEM_SUFFIX_MARKER = "【联网检索】";
export const PHONE_CALL_SYSTEM_SUFFIX_MARKER = "【语音通知与电话通话";

const CLOCK_TOOL_SYSTEM_SUFFIX =
  "\n\n【时钟与位置】用户询问时间或所在城市/当前位置时，必须调用 clock.* 工具（clock.get_current_time / clock.get_user_location）；禁止使用 IP 或训练数据臆测位置。";

const WEB_SEARCH_SYSTEM_SUFFIX =
  "\n\n【联网检索】涉及时事、新闻、股价、排片、票价、价格、公告等强时效信息时，必须先调用 search_web（query 2-6 个核心词，可含当前年月或「最新」），优先用搜索结果作答，并注明日期。整理搜索结果时优先用「一句总括 + 2-4 个分点重点」：每点先写关键词，再补一句说明；可以用短小标题、编号或 emoji 起头，但不要上来先说一遍、后面又重复展开一遍。禁止重复同一句开场、结论或相同信息块；禁止使用 Markdown 表格、管道符、以及「等级|标题|摘要」类简报格式。若用户问的是单一事实判断（如“现在在哪 / 有没有 / 是不是 / 最新情况”），默认只回答“结论 + 1 句依据”，不要再补第二轮总结性复述。\n\n【搜索失败兜底】search_web 返回 0 条或网络异常时，仍可基于训练知识作答，但必须前置一句「我这边搜不到最新数据，按我之前知道的答你」之类说明，让用户知道这不是实时结果。不要机械回复「搜索不到」就走人。天气查询直接调 weather.* 工具（如果已注册），不要走 search_web。";

const PHONE_CALL_SYSTEM_SUFFIX =
  "\n\n【语音通知与电话通话 · 静默触达规则】\n\n"
  + "你有三套语音触达能力，调用时直接执行，禁止在回复中说任何关于打电话/发语音的废话。\n\n"
  + "── 工具一：voice.speak（轻量播报）──\n"
  + "适用场景：用户说「读一下」「念给我听」「播报一下」—— 单向 TTS 即时播报，无 UI，客户端后台一次性播放。\n"
  + "参数：text 填要朗读的内容，mode 默认 \"instant\"。\n\n"
  + "── 工具二：voice.send_message（微信式语音消息）──\n"
  + "适用场景：用户说「发语音」「发条语音消息」「用语音回复」—— 落地为可重播的语音气泡，客户端渲染为微信式语音消息，可多次点击重播。\n"
  + "参数：text 填语音消息要朗读的内容（会被 TTS 合成）。\n"
  + "与 voice.speak 区别：speak 是一次性即时播报无 UI；send_message 是落地语音消息，用户可重播。\n\n"
  + "── 工具三：phone.call_user（电话通话）──\n"
  + "适用场景：「给我打个电话」「打电话给我」—— 振铃 → 接通 → TTS 播放语音。\n"
  + "参数：spokenMessage 填要对用户说的话，ringStyle 默认 \"peer\"（reminder 为闹钟式无来电 UI）。\n\n"
  + "【绝对禁止】\n"
  + "- 禁止回复「马上给你打过去」「好的我给您打个电话」「现在给你打确认」「再打一次」「马上去设」等任何提前告知或重复承诺—— 用户不需要知道你要打，直接打就是。\n"
  + "- 别一上来就甩「我是 AI 打不了电话」「没法拨号」这种话。\n"
  + "- phone.call_user 一轮只许喊一次，喊多了系统只认第一回，后面白费。\n"
  + "- 打电话是后台的事儿，跟用户说话时别提倒计时、别说「到时候接一下」、别提「准时喊你」这种内部细节。\n"
  + "- 发语音消息同理：调 voice.send_message 后不要再在文本回复里复述语音内容，工具会替你落地。\n"

/**
 * 在启用 function calling / 工具环时，向 system 内容追加 Agent World 工具指引（已包含则跳过）。
 */
export const MASTER_SUBAGENT_DELEGATE_MARKER = "【主 Agent 调度】";
export const LIVE_USER_STATUS_MARKER = "【回复方向】";
export const CONCISE_REPLY_SYSTEM_SUFFIX_MARKER = "【回复方向】";
export const MESSAGE_TIMESTAMP_MARKER = "【消息时间戳】";

/**
 * 「活人感」核心方向（只给方向，不堆 prompt）：
 * 让模型基于"像熟识的老朋友"这个方向自己发挥，
 * 程序层靠 postValidate 兜底（如检测到客服腔触发重生成）。
 *
 * 不再列举"嘛/呢/呗/哈/哎"等具体语气词——这些应该让模型自己根据上下文选；
 * 不再列举禁用清单——具体行为由 assistant-humanizer 在程序层过滤。
 */
const CONCISE_REPLY_SYSTEM_SUFFIX = `

【回复方向】像熟识的老朋友，不像客服。短、自然、有温度。说重点，别端着，别"您"。`;

/**
 * 记忆召回的使用方式：让 LLM 知道"背景里有这些信息"，但要求像真人一样
 * 只在话题相关或临期时再主动提起，不要每轮都把承诺/未完成事项/历史提醒
 * 复读一遍。系统注入只是给 agent 后台认知，发言权仍由话题相关性决定。
 */
const MEMORY_RECALL_BEHAVIOR_SUFFIX = `

【记忆使用方式】system 里出现的【待兑现承诺】【未完成事项】【会话回顾】【持久记忆与偏好】等都属于"后台你知道的背景资料"，不是你必须主动提醒用户的小本本。规则：
- 当前话题和某条承诺/未完成事项明显相关，或那条事项马上到期（≤24h），才在回复里自然带一句；
- 否则保持沉默——真朋友不会把几周前的提醒每条都复读一遍，更不会用"顺便提醒你…"当过渡；
- 引用时要模糊自然（"之前你说过的那个…"），别照搬原文堆在句首；
- 即使本轮什么都没相关，宁可一字不提，也别硬塞一段「温馨提示」打断当下对话。`;

const LIVE_USER_STATUS_SUFFIX = ""; // 已合并到 CONCISE_REPLY_SYSTEM_SUFFIX

/**
 * 时间戳系统说明：让 LLM 知道每条 user/assistant 消息首行都带 `[ts:...]` 前缀。
 * 配合 AgentPromptMemoryContext.currentTime，Agent 能精确感知「几时发的」「距今多久」。
 */
const MESSAGE_TIMESTAMP_SUFFIX = `

【消息时间戳】每条 user/assistant 消息首行带前缀 \`[ts:YYYY-MM-DD HH:MM:SS|周X|relative]\`（本地秒级时间 + 星期 + 相对当前偏移，如 \`[ts:2026-06-10 14:35:22|周二|3m ago]\`）。涉及时间引用、先后、间隔一律以这条前缀为准，不要靠消息位置或印象；问「现在几点」仍调 clock 工具。

【跨天识别】每条消息的 \`[ts:YYYY-MM-DD...]\` 都带完整日期，**日期不同就是不同一天**，不能用「看着像今天」草率判断：
- 当前系统已注入「当前时间：YYYY-MM-DD HH:MM:SS 周X」，与历史消息前缀日期对比即可知道是哪天。
- \`relative\` 段只是参考：\`3m ago\` / \`5h ago\` 是同一天内的偏移；跨天会用 \`yesterday <时段>\` / \`Nd ago\` / \`Nw ago\`。读到 \`yesterday\` / \`Nd ago\` 必须把它识别成「非今天」。
- 回答"几天没聊 / 上次什么时候 / 昨天发生了什么"这类时间跨度问题，必须以 \`[ts:...]\` 里的日期为准，不能只看时间。
- 不要把「同一天内的不同时间」当成「隔了几天」，也不要反过来把「不同日期的同一时间」当成「同一时刻」。

【重要约束】\`[ts:...]\` 是系统注入的元数据标记，不是消息内容，也不是用户说的话。你绝不能：
1. 在回复中复述或引用 \`[ts:...]\` 标记本身；
2. 把 \`[ts:...]\` 后的内容当作上一轮对话来「接话」或「续写」；
3. 基于时间戳编造对话上下文（如「刚上轮你说的…」），除非用户消息内容里确实有对应内容。
每条消息的真正内容是 \`[ts:...]\n\` 之后的部分。

【话题切换】如果上一条 user 消息和当前 user 消息主题不同（如「问电影 → 问几天没聊」），说明用户已转话题。当前回复必须**直接、干净地回应本条 user 消息**——不要接着上一轮的话题续写、不要把上一轮的工具结果/未完成工作当作本轮语境：
- 回复开头不要出现「接着上轮的 XX / 我刚查 XX / 哈哈被你发现」之类承接旧话题的话；
- 不要在回复里把上一轮的工具名/搜索关键词再复述一遍，除非当前问题真的需要；
- 如果用户问「几天没聊 / 上次聊什么」，按 \`[ts:...]\` 日期如实回答日期差，不要凭印象模糊作答。`;

function buildMasterSubAgentDelegateSuffix(): string {
  const maxParallel = getAgentRuntimeConfig().masterDelegation.maxParallelSubAgents;
  return `

【主 Agent 调度】你是主 Agent（带头大哥），手下有 3 类专业「小弟」子 Agent，由你调度、对用户只呈现一份整合后的答复：
- life（生活）：钱包写操作、订票下单、电脑操控等复杂生活执行
- tech（技术）：深度 RPA、写代码、部署运维、批量自动化
- info（信息）：深度搜索、比价调研、多轮检索（只查不买）；电商实价需用户导入 Cookie 并授权 browser.fetch_page

【何时自己干 vs 派小弟】
- 简单、单一事项：优先直接用 clock、calendar、search_web 等，不必派小弟。
- 需要专业能力、多步骤、或你一个人搞不定时：调用 master_invoke_sub_agent 派对应小弟。

【并行委派】用户一次提多件互不依赖的事，或你拆成多个独立子任务时，应在同一轮 tool 批次里并行多次 master_invoke_sub_agent（服务端最多同时跑 ${maxParallel} 个小弟）。例：「查北京天气 + 调研某商品价格」→ 可并行派 info 做调研，主 Agent 自己查天气。
- 无依赖务必并行，不要无谓排队。
- 耗时任务可 runInBackground=true，再用 master_poll_sub_agent_tasks 收齐小弟报告后统一回复用户。

【对用户说话】每次 master_invoke_sub_agent 必须填 userStatusLine：口语化、有活人感（如「我让小弟去查价，你稍等」），禁止只写工具名或固定套话。
- 小弟报告仅供你整合；最终由你精简回复用户，不要甩内部 taskId。
- 不确定派谁时先 master_list_sub_agents 看名册。
- 用户处于「沙箱」时勿派需要 desktop.visual.run_task / vision.periodic_* / self.* 的任务；须提醒开启「完全访问」。`;
}

/** 追加「尽量精简」的回复风格说明（已包含则跳过）。 */
export function appendConciseReplySystemSuffix(systemContent: string): string {
  if (systemContent.includes(CONCISE_REPLY_SYSTEM_SUFFIX_MARKER)) return systemContent;
  return systemContent + CONCISE_REPLY_SYSTEM_SUFFIX;
}

const PRIVATE_BUTLER_REPLY_SYSTEM_SUFFIX_MARKER = "【活人感与进度话】"; // 合并到 CONCISE_REPLY，使用同一个 marker 避免重复
const PRIVATE_BUTLER_REPLY_SYSTEM_SUFFIX = ""; // 已合并到 CONCISE_REPLY_SYSTEM_SUFFIX

export function appendPrivateButlerReplySystemSuffix(systemContent: string): string {
  // 已合并到 CONCISE_REPLY_SYSTEM_SUFFIX（marker 一致，appendConciseReplySystemSuffix 会处理）
  return systemContent;
}

export const MEMORY_RECALL_BEHAVIOR_MARKER = "【记忆使用方式】";

/** 追加「记忆召回使用方式」说明：让 LLM 知道 background memory 的使用边界，不主动复读无关提醒。 */
export function appendMemoryRecallBehaviorSuffix(systemContent: string): string {
  if (systemContent.includes(MEMORY_RECALL_BEHAVIOR_MARKER)) return systemContent;
  return systemContent + MEMORY_RECALL_BEHAVIOR_SUFFIX;
}

/** 追加「消息时间戳」系统说明（已包含则跳过），让 LLM 理解每条消息首行 `[ts:...]` 前缀。 */
export function appendMessageTimestampSystemSuffix(systemContent: string): string {
  if (systemContent.includes(MESSAGE_TIMESTAMP_MARKER)) return systemContent;
  return systemContent + MESSAGE_TIMESTAMP_SUFFIX;
}

const WEEKDAY_CN_FOR_PROMPT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function pad2ForPrompt(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 生成注入 system 的「当前时间」片段：`当前时间：2026-06-10 14:35:22 周二 (Asia/Shanghai, 2026-06-10T14:35:22+08:00)`
 * 与消息时间戳前缀 `[ts:YYYY-MM-DD HH:MM:SS|周X|relative]` 配套使用。
 */
export function buildCurrentTimePrompt(at: Date = new Date()): string {
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const local =
    `${at.getFullYear()}-${pad2ForPrompt(at.getMonth() + 1)}-${pad2ForPrompt(at.getDate())} ` +
    `${pad2ForPrompt(at.getHours())}:${pad2ForPrompt(at.getMinutes())}:${pad2ForPrompt(at.getSeconds())}`;
  const weekday = WEEKDAY_CN_FOR_PROMPT[at.getDay()] ?? "";
  const iso = at.toString().includes("T") ? at.toISOString() : new Date(at.getTime()).toISOString();
  return `当前时间：${local} ${weekday} (时区：${tz}, ISO=${iso})`;
}

export type FinalizeChatSystemPromptOpts = {
  tools?: boolean;
  masterSubAgentDelegate?: boolean;
  /** 来自 `chat.user_message.agentAccessMode`；沙箱已废弃，恒为 full */
  agentAccessMode?: AgentAccessMode;
  desktopBridgeOnline?: boolean;
  phoneBridgeOnline?: boolean;
  /**
   * RuntimeKernel minimal 模式控制位：true 时跳过身份/时间戳说明/工具规则类后缀，
   * 这些"层 A 身份内容"由 RuntimeKernel state 管理，由 buildSessionSystem 在会话首条 system 一次性注入；
   * 工具调用规则（clock/search_web/voice/phone/master_invoke_sub_agent）已下沉到对应 tool schema description，
   * 工具被 ToolSearch contextual profile 暴露时 LLM 自然看到规则，不污染 prompt。
   *
   * minimal 模式仍保留：
   * - 「活人感与进度话」约束（合并了原回复风格+管家风格+用户可见进度，是 LLM 输出风格核心约束）
   * - 访问权限说明（agentAccessMode/desktopBridgeOnline/phoneBridgeOnline）
   *
   * functionalSuffixes=false 可进一步剥离「活人感」约束（仅用于极致节省场景，不推荐生产）。
   */
  suppressRuntimeSuffixes?: boolean;
  /**
   * 功能性后缀开关：false 时跳过「活人感」约束（极致节省场景，不推荐生产）。
   * 默认 undefined（视为 true）：保留「活人感」+ 访问权限。
   * 仅在 suppressRuntimeSuffixes=true（minimal 模式）时生效；其他模式此参数无效。
   */
  functionalSuffixes?: boolean;
};

/** 统一组装 system：精简风格 → 消息时间戳说明 → 工具说明 → 主 Agent 委派说明 → 访问权限说明。 */
export function finalizeChatSystemPrompt(
  baseContent: string,
  opts?: FinalizeChatSystemPromptOpts,
): string {
  // minimal 模式：只保留「活人感」约束 + 访问权限说明
  // 工具调用规则（clock/search_web/voice/phone/master_invoke_sub_agent）已下沉到 tool schema description，
  // 通过 ToolSearch contextual profile 按需暴露给 LLM
  if (opts?.suppressRuntimeSuffixes) {
    const keepFunctional = opts.functionalSuffixes !== false; // 默认 true
    let out = baseContent.trim();
    if (!keepFunctional) {
      // 极致节省模式：连「活人感」约束都跳过（不推荐生产）
      return out;
    }
    // 保留「活人感与进度话」约束（合并了回复风格+管家风格+进度话）
    out = appendConciseReplySystemSuffix(out);
    // 保留访问权限说明
    out = appendAgentAccessModeSystemSuffix(out, parseAgentAccessMode(opts?.agentAccessMode), {
      desktopBridgeOnline: opts?.desktopBridgeOnline,
      phoneBridgeOnline: opts?.phoneBridgeOnline,
    });
    return out;
  }
  // 非 minimal 模式：完整追加所有后缀（legacy/dynamic/conversation_only 行为不变）
  let out = appendConciseReplySystemSuffix(baseContent);
  out = appendPrivateButlerReplySystemSuffix(out);
  out = appendMessageTimestampSystemSuffix(out);
  // 记忆召回使用方式：让 LLM 知道 background memory 怎么用，不主动复读无关提醒
  out = appendMemoryRecallBehaviorSuffix(out);
  if (opts?.tools) {
    out = appendAgentToolCallingSystemSuffix(out);
    if (opts.masterSubAgentDelegate) {
      out = appendMasterSubAgentDelegateSuffix(out);
    }
  }
  out = appendAgentAccessModeSystemSuffix(out, parseAgentAccessMode(opts?.agentAccessMode), {
    desktopBridgeOnline: opts?.desktopBridgeOnline,
    phoneBridgeOnline: opts?.phoneBridgeOnline,
  });
  return out;
}

export function appendAgentToolCallingSystemSuffix(systemContent: string): string {
  let out = systemContent;
  if (!out.includes(AGENT_TOOL_SYSTEM_SUFFIX_MARKER)) {
    out += USER_AGENT_TOOL_SYSTEM_SUFFIX;
  }
  if (!out.includes(CLOCK_TOOL_SYSTEM_SUFFIX_MARKER)) {
    out += CLOCK_TOOL_SYSTEM_SUFFIX;
  }
  if (!out.includes(WEB_SEARCH_SYSTEM_SUFFIX_MARKER)) {
    out += WEB_SEARCH_SYSTEM_SUFFIX;
  }
  if (!out.includes(PHONE_CALL_SYSTEM_SUFFIX_MARKER)) {
    out += PHONE_CALL_SYSTEM_SUFFIX;
  }
  if (!out.includes(LIVE_USER_STATUS_MARKER)) {
    out += LIVE_USER_STATUS_SUFFIX;
  }
  return out;
}

/** 主 Agent 启用子 Agent 委派工具时追加的 system 说明 */
export function appendMasterSubAgentDelegateSuffix(systemContent: string): string {
  if (systemContent.includes(MASTER_SUBAGENT_DELEGATE_MARKER)) return systemContent;
  return systemContent + buildMasterSubAgentDelegateSuffix();
}

/** 未设置 `AGENT_PROMPT_MEMORY_KEYS` 时默认注入的 UAP 键（可用 env 覆盖或 `off` 关闭）。 */
export const DEFAULT_AGENT_PROMPT_MEMORY_KEYS = [
  "persona",
  "values",
  "abilities",
  "memory_summary",
  "memory_current_mission",
  "memory_preferences",
  "memory_facts",
  "memory_commitments",
  "memory_open_loops",
  "session_recap",
] as const;

/**
 * 解析 `AGENT_PROMPT_MEMORY_KEYS`：
 * - 未设置 → 默认键（开启记忆注入）
 * - `off`/`false`/`0` → 关闭
 * - 逗号列表 → 自定义键
 */
export function resolvePromptMemoryKeys(): string[] | null {
  const raw = process.env.AGENT_PROMPT_MEMORY_KEYS?.trim();
  if (!raw) return [...DEFAULT_AGENT_PROMPT_MEMORY_KEYS];
  if (raw === "0" || raw.toLowerCase() === "off" || raw.toLowerCase() === "false") {
    return null;
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @deprecated 使用 {@link resolvePromptMemoryKeys} */
export function parsePromptMemoryKeysFromEnv(): string[] | null {
  return resolvePromptMemoryKeys();
}

function promptMemorySummaryMaxChars(): number {
  const raw = process.env.AGENT_PROMPT_MEMORY_SUMMARY_MAX_CHARS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 1000;
  return Number.isFinite(n) && n > 200 ? n : 1000;
}

function promptMemorySummaryMaxLines(): number {
  const raw = process.env.AGENT_PROMPT_MEMORY_SUMMARY_MAX_LINES?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 6;
  return Number.isFinite(n) && n > 3 ? n : 6;
}

function promptSubAgentMemorySummaryMaxLines(): number {
  const raw = process.env.AGENT_SUBAGENT_MEMORY_SUMMARY_MAX_LINES?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 4;
  return Number.isFinite(n) && n > 3 ? n : 4;
}

function promptSubAgentMemorySummaryMaxChars(): number {
  const raw = process.env.AGENT_SUBAGENT_MEMORY_SUMMARY_MAX_CHARS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 600;
  return Number.isFinite(n) && n > 200 ? n : 600;
}

const TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/;

function extractTimestamp(line: string): Date | null {
  const match = line.match(TIMESTAMP_RE);
  if (!match?.[1]) return null;
  const ts = Date.parse(match[1]);
  return isNaN(ts) ? null : new Date(ts);
}

function sortAndTruncateMemoryLines(
  raw: string,
  maxChars: number,
  maxLines: number,
  userQuery?: string,
  opts?: { minRelevance?: number; fallbackOnEmpty?: boolean },
): string {
  const minRelevance = opts?.minRelevance ?? 0;
  const fallbackOnEmpty = opts?.fallbackOnEmpty ?? false;
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";

  let scored = lines.map((line) => ({
    line,
    timestamp: extractTimestamp(line),
    relevanceScore: userQuery ? calculateRelevanceScore(line, userQuery) : 0.5,
  }));

  // 先按相关度过滤（仅 userQuery 存在时启用门槛），过滤后按相关度+时间排序
  const filtered = minRelevance > 0 && userQuery
    ? scored.filter((s) => s.relevanceScore >= minRelevance)
    : scored;
  const workingSet = filtered.length > 0 ? filtered : (fallbackOnEmpty ? scored : []);

  if (workingSet.length === 0) return "";

  const sorted = [...workingSet].sort((a, b) => {
    if (Math.abs(b.relevanceScore - a.relevanceScore) > 0.2) {
      return b.relevanceScore - a.relevanceScore;
    }
    const timeA = a.timestamp;
    const timeB = b.timestamp;
    if (!timeA && !timeB) return 0;
    if (!timeA) return 1;
    if (!timeB) return -1;
    return timeB.getTime() - timeA.getTime();
  });

  const truncated = sorted.slice(0, maxLines).map((s) => s.line);
  let result = truncated.join("\n");
  if (result.length > maxChars) {
    result = `…（较早记录已截断）\n${result.slice(-maxChars)}`;
  }
  return result;
}

function calculateRelevanceScore(line: string, query: string): number {
  const queryLower = query.toLowerCase();
  const lineLower = line.toLowerCase();

  let score = 0;

  const queryTerms = queryLower.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g) || [];
  for (const term of queryTerms) {
    if (lineLower.includes(term)) {
      score += 0.3;
    }
  }

  const queryTopic = inferMemoryTopic(query);
  const lineTopic = extractMemoryTopicFromLine(line);
  score += topicRelevanceBoost(lineTopic, queryTopic);

  if (/\[用户要求记住\]/.test(line) || /\[Agent 承诺\/结论\]/.test(line)) {
    score += 0.2;
  }

  if (/偏好|喜欢|讨厌|重要|记住|记得/.test(queryLower) &&
      /偏好|喜欢|讨厌|禁忌|生日|纪念日|重要/.test(lineLower)) {
    score += 0.3;
  }

  if (/之前|上次|说过|刚才|刚刚/.test(queryLower)) {
    score += 0.1;
  }

  return Math.min(score, 1);
}

/** 将 KV 条目格式化为可注入 system 的文本（支持 JSON 对象/数组）。 */
export function formatKvValueForPrompt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return String(value);
  }
}

/**
 * 将结构化人格内核格式化为可读文本，注入 system prompt 稳定前缀的【人格内核】块。
 * 防漂移：每轮从 MemoryCortex.getPersonalityCore 拉取最新值并格式化为稳定文本，
 * 避免单次对话导致人格漂移。各字段缺省时跳过对应行。
 */
export function formatPersonalityCorePrompt(core: PersonalityCore): string {
  const lines: string[] = [];
  if (core.values.length > 0) {
    lines.push(`价值观：${core.values.join("、")}`);
  }
  if (core.speech_style) {
    const ss = core.speech_style;
    lines.push(`说话风格：语气${ss.tone}｜正式程度${ss.formality}｜幽默${ss.humor}`);
  }
  if (core.beliefs.length > 0) {
    lines.push(`信念：${core.beliefs.join("；")}`);
  }
  if (core.quirks.length > 0) {
    lines.push(`口癖：${core.quirks.join("；")}`);
  }
  return lines.join("\n");
}

const SLICE_RESERVED_KEYS = new Set([
  "persona",
  "soul",
  "values",
  "values_profile",
  "abilities",
  "skill_tendencies",
  "memory_summary",
  "memory_current_mission",
  "memory_preferences",
  "memory_facts",
  "memory_commitments",
  "memory_open_loops",
  "session_recap",
  "user_profile",
  "emotion_state",
]);

/**
 * 将 UAP 快照中的条目转为分层片段：人格 / 价值观 / 能力倾向 / 其余键合并为履历块。
 */
export function sliceMemoryEntriesToPromptContext(
  entries: Record<string, unknown>,
  userQuery?: string,
  opts?: { includeMemorySummary?: boolean },
): AgentPromptMemoryContext {
  const str = (v: unknown): string => formatKvValueForPrompt(v);

  const persona = str(entries["persona"]) || str(entries["soul"]);
  const values = str(entries["values"]) || str(entries["values_profile"]);
  const abilities = str(entries["abilities"]) || str(entries["skill_tendencies"]);

  const memoryParts: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (SLICE_RESERVED_KEYS.has(k)) continue;
    const s = str(v);
    if (s) memoryParts.push(`【${k}】\n${s}`);
  }
  memoryParts.sort();
  const maxChars = promptMemorySummaryMaxChars();
  let memorySummary = memoryParts.join("\n\n");
  const rawSummary = str(entries["memory_summary"]);
  const memoryCurrentMission = sortAndTruncateMemoryLines(str(entries["memory_current_mission"]), 240, 1, userQuery);
  const memoryPreferences = sortAndTruncateMemoryLines(str(entries["memory_preferences"]), 500, 4, userQuery);
  const memoryFacts = sortAndTruncateMemoryLines(str(entries["memory_facts"]), 500, 4, userQuery);
  // 「待兑现承诺 / 未完成事项」默认仅在 topic 相关时才注入 prompt；
  // 计算得分低于 0.45 的行直接丢弃（与用户当前话题弱相关就别让 LLM 主动提）。
  // 门槛 0.45 的依据：commitment 标签自带 +0.2 加成，加上 topic boost 0.15（general）
  // 或 0.45（同 topic），弱相关行落到 0.4（general+commitment）→ 被过滤；
  // 同 topic + commitment 行落到 0.65 → 保留。
  // 兜底：若全部不相关则不注入，避免把无关提醒强行塞进 prompt。
  const memoryCommitments = sortAndTruncateMemoryLines(
    str(entries["memory_commitments"]),
    500,
    2,
    userQuery,
    { minRelevance: 0.45, fallbackOnEmpty: false },
  );
  const memoryOpenLoops = sortAndTruncateMemoryLines(
    str(entries["memory_open_loops"]),
    500,
    2,
    userQuery,
    { minRelevance: 0.45, fallbackOnEmpty: false },
  );
  const sessionRecap = sortAndTruncateMemoryLines(str(entries["session_recap"]), 500, 4, userQuery);
  if (opts?.includeMemorySummary !== false && rawSummary) {
    const sorted = sortAndTruncateMemoryLines(rawSummary, maxChars, promptMemorySummaryMaxLines(), userQuery);
    memorySummary = memorySummary ? `${sorted}\n\n${memorySummary}` : sorted;
  }
  if (memorySummary.length > maxChars) {
    memorySummary = `…（较早记录已截断）\n${memorySummary.slice(-maxChars)}`;
  }

  const out: AgentPromptMemoryContext = {};
  if (persona) out.persona = persona;
  if (values) out.values = values;
  if (abilities) out.abilities = abilities;
  if (memorySummary) out.memorySummary = memorySummary;
  if (memoryCurrentMission) out.memoryCurrentMission = memoryCurrentMission;
  if (memoryPreferences) out.memoryPreferences = memoryPreferences;
  if (memoryFacts) out.memoryFacts = memoryFacts;
  if (memoryCommitments) out.memoryCommitments = memoryCommitments;
  if (memoryOpenLoops) out.memoryOpenLoops = memoryOpenLoops;
  if (sessionRecap) out.sessionRecap = sessionRecap;
  return out;
}

/** 子 Agent：仅人格 + 与任务相关的 memory_summary 行（更小上限）。 */
export function sliceSubAgentMemoryEntries(
  entries: Record<string, unknown>,
  taskQuery?: string,
): AgentPromptMemoryContext {
  const str = (v: unknown): string => formatKvValueForPrompt(v);
  const out: AgentPromptMemoryContext = {};
  const persona = str(entries["persona"]) || str(entries["soul"]);
  if (persona) out.persona = persona;

  const rawSummary = str(entries["memory_summary"]);
  if (rawSummary) {
    const sorted = sortAndTruncateMemoryLines(
      rawSummary,
      promptSubAgentMemorySummaryMaxChars(),
      promptSubAgentMemorySummaryMaxLines(),
      taskQuery,
    );
    if (sorted) out.memorySummary = sorted;
  }
  return out;
}

/** 人格 → 价值观 → 能力倾向 → 履历，最后接厂商默认安全提示（长期演化友好顺序）。 */
export function buildLayeredSystemPrompt(
  baseSystem: string,
  memory?: AgentPromptMemoryContext,
): string {
  if (
    !memory?.persona &&
    !memory?.personalityCore &&
    !memory?.values &&
    !memory?.abilities &&
    !memory?.agentCaps &&
    !memory?.worldCaps &&
    !memory?.narrativeRecall &&
    !memory?.memorySummary &&
    !memory?.memoryCurrentMission &&
    !memory?.memoryPreferences &&
    !memory?.memoryFacts &&
    !memory?.memoryCommitments &&
    !memory?.memoryOpenLoops &&
    !memory?.sessionRecap &&
    !memory?.interruptedContext &&
    !memory?.userLocation &&
    !memory?.taskContext &&
    !memory?.userProfile &&
    !memory?.toneGuidance &&
    !memory?.relationshipGuidance &&
    !memory?.dailyDigest &&
    !memory?.userProfileSummary &&
    !memory?.relationshipMemory &&
    !memory?.lifeThemeMemory &&
    !memory?.dreamMemory &&
    !memory?.followUpAnchor &&
    !memory?.scheduleSnapshot &&
    !memory?.currentTime &&
    !memory?.skillIndex &&
    !memory?.workingMemorySummary &&
    !memory?.recentConversationHistory
  ) {
    return baseSystem.trim();
  }
  const parts: string[] = [];
  if (memory.followUpAnchor) parts.push(memory.followUpAnchor);
  if (memory.scheduleSnapshot) parts.push(memory.scheduleSnapshot);
  if (memory.taskContext) parts.push(`[Turn Task Context]\n${memory.taskContext}`);
  if (memory.toneGuidance) parts.push(`【本轮语气与情绪适配】\n${memory.toneGuidance}`);
  if (memory.relationshipGuidance) parts.push(`【回复风格与关系边界】\n${memory.relationshipGuidance}`);
  if (memory.userProfile) parts.push(`【用户画像】\n${memory.userProfile}`);
  if (memory.userLocation) parts.push(`【用户位置】\n${memory.userLocation}`);
  if (memory.personalityCore) parts.push(`【人格内核】\n${memory.personalityCore}`);
  if (memory.persona) parts.push(`【人格与角色】\n${memory.persona}`);
  if (memory.values) parts.push(`【价值观与原则】\n${memory.values}`);
  if (memory.abilities) parts.push(`【能力倾向】\n${memory.abilities}`);
  if (memory.agentCaps) parts.push(`【你的 Agent 专属能力】\n${memory.agentCaps}`);
  if (memory.worldCaps) parts.push(`【Agent World】\n${memory.worldCaps}`);
  if (memory.dailyDigest) parts.push(`【今日对话摘要】\n${memory.dailyDigest}`);
  if (memory.userProfileSummary) parts.push(`【用户长期画像】\n${memory.userProfileSummary}`);
  if (memory.narrativeRecall) parts.push(`【记忆图联想检索】\n${memory.narrativeRecall}`);
  if (memory.workingMemorySummary) parts.push(`【当前工作记忆】\n${memory.workingMemorySummary}`);
  if (memory.recentConversationHistory)
    parts.push(
      `【最近对话回顾】\n（用于指代消解与话题衔接，不是用户的最新指令；当前轮请以「用户最新一条」为准）\n${memory.recentConversationHistory}`,
    );
  if (memory.memorySummary) parts.push(`【持久记忆与偏好】\n${memory.memorySummary}`);
  if (memory.memoryPreferences) parts.push(`【用户偏好】\n${memory.memoryPreferences}`);
  if (memory.memoryFacts) parts.push(`【用户事实】\n${memory.memoryFacts}`);
  if (memory.memoryCommitments) parts.push(`【待兑现承诺】\n${memory.memoryCommitments}`);
  if (memory.memoryOpenLoops) parts.push(`【未完成事项】\n${memory.memoryOpenLoops}`);
  if (memory.sessionRecap) parts.push(`【会话回顾】\n${memory.sessionRecap}`);
  if (memory.relationshipMemory) parts.push(memory.relationshipMemory);
  if (memory.lifeThemeMemory) parts.push(memory.lifeThemeMemory);
  if (memory.dreamMemory) parts.push(memory.dreamMemory);
  if (memory.yesterdayHighlight) parts.push(memory.yesterdayHighlight);
  if (memory.memoryContinuity) parts.push(memory.memoryContinuity);
  if (memory.interruptedContext) parts.push(memory.interruptedContext);
  if (memory.currentTime) parts.push(`【当前时间】\n${memory.currentTime}`);
  // 元认知与情绪：让 LLM 知道"自己现在怎么想/感觉如何"
  if (memory.metaCognition) parts.push(`【自我认知】\n${memory.metaCognition}`);
  if (memory.emotionState) parts.push(`【当前情绪】\n${memory.emotionState}`);
  if (memory.skillIndex) parts.push(memory.skillIndex);
  parts.push(baseSystem.trim());
  return parts.join("\n\n");
}

export type LayeredSystemPromptSections = {
  stablePrefix: string[];
  dynamicContext: string[];
};

function hasAnyPromptMemory(memory?: AgentPromptMemoryContext): boolean {
  return Boolean(
    memory?.persona ||
      memory?.personalityCore ||
      memory?.values ||
      memory?.abilities ||
      memory?.agentCaps ||
      memory?.worldCaps ||
      memory?.narrativeRecall ||
      memory?.memorySummary ||
      memory?.memoryPreferences ||
      memory?.memoryFacts ||
      memory?.memoryCommitments ||
      memory?.memoryOpenLoops ||
      memory?.sessionRecap ||
      memory?.interruptedContext ||
      memory?.userLocation ||
      memory?.taskContext ||
      memory?.userProfile ||
      memory?.toneGuidance ||
      memory?.relationshipGuidance ||
      memory?.dailyDigest ||
      memory?.userProfileSummary ||
      memory?.relationshipMemory ||
      memory?.lifeThemeMemory ||
      memory?.dreamMemory ||
      memory?.yesterdayHighlight ||
      memory?.memoryContinuity ||
      memory?.followUpAnchor ||
      memory?.scheduleSnapshot ||
      memory?.currentTime ||
      memory?.skillIndex ||
      memory?.workingMemorySummary ||
      memory?.recentConversationHistory
  );
}

export function buildLayeredSystemPromptSections(
  memory?: AgentPromptMemoryContext,
): LayeredSystemPromptSections {
  if (!hasAnyPromptMemory(memory)) {
    return { stablePrefix: [], dynamicContext: [] };
  }
  const m = memory as AgentPromptMemoryContext;

  const stablePrefix: string[] = [];
  const dynamicContext: string[] = [];

  if (m.personalityCore) stablePrefix.push(`【人格内核】\n${m.personalityCore}`);
  if (m.persona) stablePrefix.push(`【人格与角色】\n${m.persona}`);
  if (m.values) stablePrefix.push(`【价值观与原则】\n${m.values}`);
  if (m.abilities) stablePrefix.push(`【能力倾向】\n${m.abilities}`);
  if (m.agentCaps) stablePrefix.push(`【你的 Agent 专属能力】\n${m.agentCaps}`);
  if (m.worldCaps) stablePrefix.push(`【Agent World】\n${m.worldCaps}`);
  if (m.userProfileSummary) stablePrefix.push(`【用户长期画像】\n${m.userProfileSummary}`);
  if (m.relationshipMemory) stablePrefix.push(m.relationshipMemory);
  if (m.lifeThemeMemory) stablePrefix.push(m.lifeThemeMemory);
  if (m.dreamMemory) stablePrefix.push(m.dreamMemory);

  if (m.yesterdayHighlight) dynamicContext.push(m.yesterdayHighlight);
  if (m.memoryContinuity) dynamicContext.push(m.memoryContinuity);
  if (m.followUpAnchor) dynamicContext.push(m.followUpAnchor);
  if (m.scheduleSnapshot) dynamicContext.push(m.scheduleSnapshot);
  if (m.taskContext) dynamicContext.push(`[Turn Task Context]\n${m.taskContext}`);
  if (m.toneGuidance) dynamicContext.push(`【本轮语气与情绪适配】\n${m.toneGuidance}`);
  if (m.relationshipGuidance) dynamicContext.push(`【回复风格与关系边界】\n${m.relationshipGuidance}`);
  if (m.userProfile) dynamicContext.push(`【用户画像】\n${m.userProfile}`);
  if (m.userLocation) dynamicContext.push(`【用户位置】\n${m.userLocation}`);
  if (m.dailyDigest) dynamicContext.push(`【今日对话摘要】\n${m.dailyDigest}`);
  if (m.narrativeRecall) dynamicContext.push(`【记忆图联想检索】\n${m.narrativeRecall}`);
  if (m.workingMemorySummary) dynamicContext.push(`【当前工作记忆】\n${m.workingMemorySummary}`);
  if (m.recentConversationHistory)
    dynamicContext.push(
      `【最近对话回顾】\n（用于指代消解与话题衔接，不是用户的最新指令；当前轮请以「用户最新一条」为准）\n${m.recentConversationHistory}`,
    );
  if (m.memorySummary) dynamicContext.push(`【持久记忆与偏好】\n${m.memorySummary}`);
  if (m.memoryPreferences) dynamicContext.push(`【用户偏好】\n${m.memoryPreferences}`);
  if (m.memoryFacts) dynamicContext.push(`【用户事实】\n${m.memoryFacts}`);
  if (m.memoryCommitments) dynamicContext.push(`【待兑现承诺】\n${m.memoryCommitments}`);
  if (m.memoryOpenLoops) dynamicContext.push(`【未完成事项】\n${m.memoryOpenLoops}`);
  if (m.sessionRecap) dynamicContext.push(`【会话回顾】\n${m.sessionRecap}`);
  if (m.interruptedContext) dynamicContext.push(m.interruptedContext);
  if (m.currentTime) dynamicContext.push(`【当前时间】\n${m.currentTime}`);
  if (m.skillIndex) dynamicContext.push(m.skillIndex);

  return { stablePrefix, dynamicContext };
}
