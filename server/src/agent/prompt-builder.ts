import { USER_AGENT_TOOL_SYSTEM_SUFFIX } from "@private-ai-agent/agent-world";
import {
  appendAgentAccessModeSystemSuffix,
  type AgentAccessMode,
  parseAgentAccessMode,
} from "./agent-access-mode.js";
import type { AgentPromptMemoryContext } from "../external-model/types.js";

/**
 * 与 `USER_AGENT_TOOL_SYSTEM_SUFFIX` 首段一致，用于判断 system 是否已拼接工具说明（幂等追加）。
 * 参考 Hermes `prompt_builder`：工具相关说明在单一处维护，避免各 Provider 分叉。
 */
export const AGENT_TOOL_SYSTEM_SUFFIX_MARKER = "【Agent World 开放式注册】";
export const CLOCK_TOOL_SYSTEM_SUFFIX_MARKER = "【时钟】";
export const WEB_SEARCH_SYSTEM_SUFFIX_MARKER = "【联网检索】";

const CLOCK_TOOL_SYSTEM_SUFFIX =
  "\n\n【时钟与位置】用户询问时间或所在城市/当前位置时，必须调用 clock.* 工具（clock.get_current_time / clock.get_user_location）；禁止使用 IP 或训练数据臆测位置。";

const WEB_SEARCH_SYSTEM_SUFFIX =
  "\n\n【联网检索】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息时，必须先调用 search_web（query 2-6 个核心词，可含当前年月或「最新」），禁止仅凭训练数据作答；整合结果时优先引用发布时间最新的条目，并注明日期。本地消费（电影票、外卖等）同样须先搜索再回复。";

/**
 * 在启用 function calling / 工具环时，向 system 内容追加 Agent World 工具指引（已包含则跳过）。
 */
export const MASTER_SUBAGENT_DELEGATE_MARKER = "【主 Agent 调度】";
export const CONCISE_REPLY_SYSTEM_SUFFIX_MARKER = "【回复风格】";

const CONCISE_REPLY_SYSTEM_SUFFIX = `

【回复风格】面向用户的最终回复须尽量精简：
- 先给结论或核心答案，再补必要细节；能一句说清就不写两句。
- 避免开场白、套话、重复用户原话和过度铺垫（如「好的，我来帮你…」）。
- 列表/步骤仅在确实有多项时用；简单问答通常 1～3 句即可。
- 用户明确要求详尽说明时再展开。
- 禁止在回复中暴露任何内部技术细节：不输出 taskId、jobId、记录 ID、编号、API 路径、工具调用过程等用户无感知的信息。例如创建日程/提醒/任务后，只说「已为你创建」即可，不要返回 ID 或编号。`;

const MASTER_SUBAGENT_DELEGATE_SUFFIX = `

【主 Agent 调度】你是主 Agent，负责理解用户诉求并回复用户。
- 简单、单一事项：优先直接使用 clock、calendar、search_web 等工具，不要委派子 Agent。
- 需要专业能力或较多步骤时：调用 master_invoke_sub_agent；彼此独立的子任务可在同一轮并行委派多个子 Agent（受 MAX_PARALLEL_SUB_AGENTS 限流）。
- 每次调用 master_invoke_sub_agent 时，必须填写 userStatusLine：用你自己的口吻写一句给用户看的进度话，要有活人感（可幽默、可拟人，如「我让我小弟去帮你查天气了」），禁止固定套话或只写工具名。
- 有依赖须串行（如先 security 再 life）；无依赖可并行。耗时任务可 runInBackground=true，用 master_poll_sub_agent_tasks 查进度。
- 子 Agent 报告仅供你整合；最终由你用自然语言精简回复用户。
- 规划前可调用 master_list_sub_agents 查看可委派类型。
- 用户处于「沙箱」时勿委派需要 desktop.visual.run_task / vision.periodic_* / self.* 的任务；应先提醒用户在输入框开启「完全访问」。`;

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
  return out;
}

/** 主 Agent 启用子 Agent 委派工具时追加的 system 说明 */
export function appendMasterSubAgentDelegateSuffix(systemContent: string): string {
  if (systemContent.includes(MASTER_SUBAGENT_DELEGATE_MARKER)) return systemContent;
  return systemContent + MASTER_SUBAGENT_DELEGATE_SUFFIX;
}

/** 未设置 `AGENT_PROMPT_MEMORY_KEYS` 时默认注入的 UAP 键（可用 env 覆盖或 `off` 关闭）。 */
export const DEFAULT_AGENT_PROMPT_MEMORY_KEYS = [
  "persona",
  "soul",
  "values",
  "values_profile",
  "abilities",
  "skill_tendencies",
  "memory_summary",
  "important_dates",
  "user_profile",
  "emotion_state",
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
  const n = raw ? Number.parseInt(raw, 10) : 6000;
  return Number.isFinite(n) && n > 200 ? n : 6000;
}

function promptMemorySummaryMaxLines(): number {
  const raw = process.env.AGENT_PROMPT_MEMORY_SUMMARY_MAX_LINES?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 50;
  return Number.isFinite(n) && n > 10 ? n : 50;
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
  if (rawSummary) {
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
    !memory?.dailyDigest
  ) {
    return baseSystem.trim();
  }
  const parts: string[] = [];
  if (memory.taskContext) parts.push(`[Turn Task Context]\n${memory.taskContext}`);
  if (memory.toneGuidance) parts.push(`【本轮语气与情绪适配】\n${memory.toneGuidance}`);
  if (memory.userProfile) parts.push(`【用户画像】\n${memory.userProfile}`);
  if (memory.userLocation) parts.push(`【用户位置】\n${memory.userLocation}`);
  if (memory.persona) parts.push(`【人格与角色】\n${memory.persona}`);
  if (memory.values) parts.push(`【价值观与原则】\n${memory.values}`);
  if (memory.abilities) parts.push(`【能力倾向】\n${memory.abilities}`);
  if (memory.agentCaps) parts.push(`【你的 Agent 专属能力】\n${memory.agentCaps}`);
  if (memory.worldCaps) parts.push(`【Agent World】\n${memory.worldCaps}`);
  if (memory.dailyDigest) parts.push(`【今日对话摘要】\n${memory.dailyDigest}`);
  if (memory.narrativeRecall) parts.push(`【记忆图联想检索】\n${memory.narrativeRecall}`);
  if (memory.memorySummary) parts.push(`【持久记忆与偏好】\n${memory.memorySummary}`);
  if (memory.interruptedContext) parts.push(memory.interruptedContext);
  parts.push(baseSystem.trim());
  return parts.join("\n\n");
}
