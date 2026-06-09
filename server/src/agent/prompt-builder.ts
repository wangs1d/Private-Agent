import { USER_AGENT_TOOL_SYSTEM_SUFFIX } from "@private-ai-agent/agent-world";
import {
  appendAgentAccessModeSystemSuffix,
  type AgentAccessMode,
  parseAgentAccessMode,
} from "./agent-access-mode.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import type { AgentPromptMemoryContext } from "../external-model/types.js";
import {
  extractMemoryTopicFromLine,
  inferMemoryTopic,
  topicRelevanceBoost,
} from "./memory-topic.js";

/**
 * 与 `USER_AGENT_TOOL_SYSTEM_SUFFIX` 首段一致，用于判断 system 是否已拼接工具说明（幂等追加）。
 * 参考 Hermes `prompt_builder`：工具相关说明在单一处维护，避免各 Provider 分叉。
 */
export const AGENT_TOOL_SYSTEM_SUFFIX_MARKER = "【🎮 游戏 · 你可以陪用户一起玩！】";
export const CLOCK_TOOL_SYSTEM_SUFFIX_MARKER = "【时钟】";
export const WEB_SEARCH_SYSTEM_SUFFIX_MARKER = "【联网检索】";
export const PHONE_CALL_SYSTEM_SUFFIX_MARKER = "【虚拟电话】";

const CLOCK_TOOL_SYSTEM_SUFFIX =
  "\n\n【时钟与位置】用户询问时间或所在城市/当前位置时，必须调用 clock.* 工具（clock.get_current_time / clock.get_user_location）；禁止使用 IP 或训练数据臆测位置。";

const WEB_SEARCH_SYSTEM_SUFFIX =
  "\n\n【联网检索】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息时，必须先调用 search_web（query 2-6 个核心词，可含当前年月或「最新」），禁止仅凭训练数据作答；整合结果时优先引用发布时间最新的条目，并注明日期。本地消费（电影票、外卖等）同样须先搜索再试。整理搜索结果时用简短编号句或自然段口语化呈现，禁止使用 Markdown 表格、管道符、以及「等级|标题|摘要」类简报格式。";

const PHONE_CALL_SYSTEM_SUFFIX =
  "\n\n【语音通知与电话通话 · 静默触达规则】\n\n"
  + "你有两套语音触达能力，通过 phone.call_user 工具实现。调用时直接执行，禁止在回复中说任何关于打电话的废话。\n\n"
  + "── 模式一：语音提醒（闹钟式）──\n"
  + "适用场景：「提醒我xxx」「语音告诉我」—— 单向 TTS 播报，无来电 UI。\n"
  + "参数：spokenMessage 填要说的话，ringStyle 设为 \"reminder\"。\n\n"
  + "── 模式二：电话通话（来电式）──\n"
  + "适用场景：「给我打个电话」「打电话给我」—— 振铃 → 接通 → TTS 播放语音。\n"
  + "参数：spokenMessage 填要对用户说的话，ringStyle 默认 \"peer\"。\n\n"
  + "【绝对禁止】\n"
  + "- 禁止回复「马上给你打过去」「好的我给您打个电话」「现在给你打确认」「再打一次」「马上去设」等任何提前告知或重复承诺—— 用户不需要知道你要打，直接打就是。\n"
  + "- 禁止回复「我是 AI 没有拨号功能」「无法打电话」。\n"
  + "- 【硬性规则】同一轮对话中 phone.call_user 只能调用一次，绝对禁止连续调用或分批调用多次 —— 服务端会拦截重复调用，多次调用只会执行第一次。\n"
  + "- 禁止把工具前导句（你写在 tool_call 之前的「马上设置」「马设」之类）又原样或近义改写后写进最终回复里，用户已经从进度条看到了，你再写一遍就是重复推送。\n"
  + "- 禁止在最终回复里出现「准时打电话喊你」「到时候接一下」「X秒后」等透露电话执行过程或倒计时的描述,这些属于后台行为,不要告诉用户。\n"
  + "- 打电话是后台行为,最终回复应聚焦在结果本身（如「设好啦，到点喊你」），一句话即可，禁止分点罗列。\n"
  + "- 最终回复的内容必须和进度句有明显区别：进度句说的是「正在做」，最终回复说的是「做完了」，换个说法，别复读。";

/**
 * 在启用 function calling / 工具环时，向 system 内容追加 Agent World 工具指引（已包含则跳过）。
 */
export const MASTER_SUBAGENT_DELEGATE_MARKER = "【主 Agent 调度】";
export const LIVE_USER_STATUS_MARKER = "【用户可见进度】";
export const CONCISE_REPLY_SYSTEM_SUFFIX_MARKER = "【回复风格】";

const CONCISE_REPLY_SYSTEM_SUFFIX = `

【回复风格】你是一个有性格的朋友，不是助手也不是客服。说话要像微信私聊一样自然随意。
- 口语化优先：语气词自然穿插（嘛、呢、呗、哈、噢、哎），句子可以不完整、可以有倒装、可以省略主语，怎么顺口怎么说。用短句，别写长难句。
- 称呼随意：禁止用「您」「用户」「亲」这类疏远或客服腔的称呼。直接像朋友聊天那样说话，不用开场白。
- 结论一句话带过就行，不要解释过程、不要汇报执行细节、不要分点罗列。
- 可以俏皮、可以慵懒、可以干脆，但不要装可爱也不要端着。
- 举例参考：「好嘞」「搞定啦」「等着哈」「这事儿交我」「查到了，xxx」「设好了到时候喊你」—— 就这种调调。
- 禁：客服/AI 腔（「好的，我已经为您...」「非常抱歉让您久等了...」）、套话开场、选项菜单、Markdown 表格/简报体、内部 ID 与工具过程。
- 禁：把工具调用的前导句原样或换几个字复述进最终回复 —— 那句已经作为实时进度展示了，回复里再写就是重复推送给用户。最终回复必须换个说法，聚焦结果。
- 禁：复述工具执行过程、倒计时、动作细节；只说人话结论。
- 禁：填充词连续开头超过一次（「好好好」「行行行」算一次）。
- 表情一个就够，连发 3 个属于噪音。`;

const LIVE_USER_STATUS_SUFFIX = `

【用户可见进度】你在调用任何工具之前，必须先输出 1～2 句口语化短话，让用户知道你在做什么（可幽默、可拟人）；该句会作为实时进度展示，不是最终答复。禁止只用固定套话、禁止只写工具名。委派子 Agent 时除口头语外，还须填写 master_invoke_sub_agent 的 userStatusLine（与口头语一致即可）。
⚠️ 关键：这句进度话只是让用户知道「我在干活了」，你的最终回复必须换一种说法、聚焦结果。绝对不能把进度句原样或改几个字复读进最终回复 —— 用户会看到两次相同内容，体验很差。`;

function buildMasterSubAgentDelegateSuffix(): string {
  const maxParallel = getAgentRuntimeConfig().masterDelegation.maxParallelSubAgents;
  return `

【主 Agent 调度】你是主 Agent（带头大哥），手下有 4 类专业「小弟」子 Agent，由你调度、对用户只呈现一份整合后的答复：
- life（生活）：钱包写操作、订票下单、电脑操控等复杂生活执行
- tech（技术）：深度 RPA、写代码、部署运维、批量自动化
- info（信息）：深度搜索、比价调研、多轮检索（只查不买）；电商实价需用户导入 Cookie 并授权 browser.fetch_page
- creative（创意）：文案、策划、写作、翻译润色

【何时自己干 vs 派小弟】
- 简单、单一事项：优先直接用 clock、calendar、search_web、侧栏游戏（world.gomoku/doudizhu/zhajinhua/blackjack）等，不必派小弟。
- 需要专业能力、多步骤、或你一个人搞不定时：调用 master_invoke_sub_agent 派对应小弟。

【并行委派】用户一次提多件互不依赖的事，或你拆成多个独立子任务时，应在同一轮 tool 批次里并行多次 master_invoke_sub_agent（服务端最多同时跑 ${maxParallel} 个小弟）。例：「查北京天气 + 写一段推广文案」→ 可并行派 info 与 creative。
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

export type FinalizeChatSystemPromptOpts = {
  tools?: boolean;
  masterSubAgentDelegate?: boolean;
  /** 来自 `chat.user_message.agentAccessMode`；默认沙箱 */
  agentAccessMode?: AgentAccessMode;
  desktopBridgeOnline?: boolean;
};

/** 统一组装 system：精简风格 → 工具说明 → 主 Agent 委派说明 → 访问权限说明。 */
export function finalizeChatSystemPrompt(
  baseContent: string,
  opts?: FinalizeChatSystemPromptOpts,
): string {
  let out = appendConciseReplySystemSuffix(baseContent);
  if (opts?.tools) {
    out = appendAgentToolCallingSystemSuffix(out);
    if (opts.masterSubAgentDelegate) {
      out = appendMasterSubAgentDelegateSuffix(out);
    }
  }
  out = appendAgentAccessModeSystemSuffix(out, parseAgentAccessMode(opts?.agentAccessMode), {
    desktopBridgeOnline: opts?.desktopBridgeOnline,
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

function sortAndTruncateMemoryLines(raw: string, maxChars: number, maxLines: number, userQuery?: string): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";

  let scored = lines.map((line) => ({
    line,
    timestamp: extractTimestamp(line),
    relevanceScore: userQuery ? calculateRelevanceScore(line, userQuery) : 0.5,
  }));

  if (userQuery) {
    scored.sort((a, b) => {
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
  } else {
    scored.sort((a, b) => {
      const timeA = a.timestamp;
      const timeB = b.timestamp;
      if (!timeA && !timeB) return 0;
      if (!timeA) return 1;
      if (!timeB) return -1;
      return timeB.getTime() - timeA.getTime();
    });
  }

  const truncated = scored.slice(0, maxLines).map((s) => s.line);
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

const SLICE_RESERVED_KEYS = new Set([
  "persona",
  "soul",
  "values",
  "values_profile",
  "abilities",
  "skill_tendencies",
  "memory_summary",
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
    !memory?.values &&
    !memory?.abilities &&
    !memory?.agentCaps &&
    !memory?.worldCaps &&
    !memory?.narrativeRecall &&
    !memory?.memorySummary &&
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
    !memory?.scheduleSnapshot
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
  if (memory.persona) parts.push(`【人格与角色】\n${memory.persona}`);
  if (memory.values) parts.push(`【价值观与原则】\n${memory.values}`);
  if (memory.abilities) parts.push(`【能力倾向】\n${memory.abilities}`);
  if (memory.agentCaps) parts.push(`【你的 Agent 专属能力】\n${memory.agentCaps}`);
  if (memory.worldCaps) parts.push(`【Agent World】\n${memory.worldCaps}`);
  if (memory.dailyDigest) parts.push(`【今日对话摘要】\n${memory.dailyDigest}`);
  if (memory.userProfileSummary) parts.push(`【用户长期画像】\n${memory.userProfileSummary}`);
  if (memory.narrativeRecall) parts.push(`【记忆图联想检索】\n${memory.narrativeRecall}`);
  if (memory.memorySummary) parts.push(`【持久记忆与偏好】\n${memory.memorySummary}`);
  if (memory.relationshipMemory) parts.push(memory.relationshipMemory);
  if (memory.lifeThemeMemory) parts.push(memory.lifeThemeMemory);
  if (memory.dreamMemory) parts.push(memory.dreamMemory);
  if (memory.interruptedContext) parts.push(memory.interruptedContext);
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
      memory?.values ||
      memory?.abilities ||
      memory?.agentCaps ||
      memory?.worldCaps ||
      memory?.narrativeRecall ||
      memory?.memorySummary ||
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
      memory?.followUpAnchor ||
      memory?.scheduleSnapshot
  );
}

export function buildLayeredSystemPromptSections(
  memory?: AgentPromptMemoryContext,
): LayeredSystemPromptSections {
  if (!hasAnyPromptMemory(memory)) {
    return { stablePrefix: [], dynamicContext: [] };
  }

  const stablePrefix: string[] = [];
  const dynamicContext: string[] = [];

  if (memory.persona) stablePrefix.push(`【人格与角色】\n${memory.persona}`);
  if (memory.values) stablePrefix.push(`【价值观与原则】\n${memory.values}`);
  if (memory.abilities) stablePrefix.push(`【能力倾向】\n${memory.abilities}`);
  if (memory.agentCaps) stablePrefix.push(`【你的 Agent 专属能力】\n${memory.agentCaps}`);
  if (memory.worldCaps) stablePrefix.push(`【Agent World】\n${memory.worldCaps}`);
  if (memory.userProfileSummary) stablePrefix.push(`【用户长期画像】\n${memory.userProfileSummary}`);
  if (memory.relationshipMemory) stablePrefix.push(memory.relationshipMemory);
  if (memory.lifeThemeMemory) stablePrefix.push(memory.lifeThemeMemory);
  if (memory.dreamMemory) stablePrefix.push(memory.dreamMemory);

  if (memory.followUpAnchor) dynamicContext.push(memory.followUpAnchor);
  if (memory.scheduleSnapshot) dynamicContext.push(memory.scheduleSnapshot);
  if (memory.taskContext) dynamicContext.push(`[Turn Task Context]\n${memory.taskContext}`);
  if (memory.toneGuidance) dynamicContext.push(`【本轮语气与情绪适配】\n${memory.toneGuidance}`);
  if (memory.relationshipGuidance) dynamicContext.push(`【回复风格与关系边界】\n${memory.relationshipGuidance}`);
  if (memory.userProfile) dynamicContext.push(`【用户画像】\n${memory.userProfile}`);
  if (memory.userLocation) dynamicContext.push(`【用户位置】\n${memory.userLocation}`);
  if (memory.dailyDigest) dynamicContext.push(`【今日对话摘要】\n${memory.dailyDigest}`);
  if (memory.narrativeRecall) dynamicContext.push(`【记忆图联想检索】\n${memory.narrativeRecall}`);
  if (memory.memorySummary) dynamicContext.push(`【持久记忆与偏好】\n${memory.memorySummary}`);
  if (memory.interruptedContext) dynamicContext.push(memory.interruptedContext);

  return { stablePrefix, dynamicContext };
}
