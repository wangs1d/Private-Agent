import { USER_AGENT_TOOL_SYSTEM_SUFFIX } from "@private-ai-agent/agent-world";
import type { AgentPromptMemoryContext } from "../external-model/types.js";

/**
 * 与 `USER_AGENT_TOOL_SYSTEM_SUFFIX` 首段一致，用于判断 system 是否已拼接工具说明（幂等追加）。
 * 参考 Hermes `prompt_builder`：工具相关说明在单一处维护，避免各 Provider 分叉。
 */
export const AGENT_TOOL_SYSTEM_SUFFIX_MARKER = "【Agent World 开放式注册】";
export const CLOCK_TOOL_SYSTEM_SUFFIX_MARKER = "【时钟】";

const CLOCK_TOOL_SYSTEM_SUFFIX =
  "\n\n【时钟与位置】用户询问时间或所在城市时，必须调用 clock.* 工具；位置以【用户位置】中的前端 GPS 为准，禁止使用 IP 或训练数据臆测。";

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
- 用户明确要求详尽说明时再展开。`;

const MASTER_SUBAGENT_DELEGATE_SUFFIX = `

【主 Agent 调度】你是主 Agent，负责理解用户诉求并回复用户。
- 简单、单一事项：优先直接使用 clock、calendar、search_web 等工具，不要委派子 Agent。
- 需要专业能力或较多步骤时：调用 master_invoke_sub_agent，每次只委派一个子 Agent，等待工具返回的【子Agent执行报告】后再决定下一步。
- 每次调用 master_invoke_sub_agent 时，必须填写 userStatusLine：用你自己的口吻写一句给用户看的进度话，要有活人感（可幽默、可拟人，如「我让我小弟去帮你查天气了」），禁止固定套话或只写工具名。
- 可多次串行调用不同子 Agent（例如先 info 查资料，再 life 设提醒），禁止要求并行执行多个子 Agent。
- 子 Agent 报告仅供你整合；最终由你用自然语言精简回复用户。
- 规划前可调用 master_list_sub_agents 查看可委派类型。`;

/** 追加「尽量精简」的回复风格说明（已包含则跳过）。 */
export function appendConciseReplySystemSuffix(systemContent: string): string {
  if (systemContent.includes(CONCISE_REPLY_SYSTEM_SUFFIX_MARKER)) return systemContent;
  return systemContent + CONCISE_REPLY_SYSTEM_SUFFIX;
}

export type FinalizeChatSystemPromptOpts = {
  tools?: boolean;
  masterSubAgentDelegate?: boolean;
};

/** 统一组装 system：精简风格 → 工具说明 → 主 Agent 委派说明。 */
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
]);

/**
 * 将 UAP 快照中的条目转为分层片段：人格 / 价值观 / 能力倾向 / 其余键合并为履历块。
 */
export function sliceMemoryEntriesToPromptContext(
  entries: Record<string, unknown>,
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
  let memorySummary = memoryParts.join("\n\n");
  const rawSummary = str(entries["memory_summary"]);
  if (rawSummary) {
    memorySummary = memorySummary ? `${rawSummary}\n\n${memorySummary}` : rawSummary;
  }
  const maxChars = promptMemorySummaryMaxChars();
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
    !memory?.taskContext
  ) {
    return baseSystem.trim();
  }
  const parts: string[] = [];
  if (memory.taskContext) parts.push(`[Turn Task Context]\n${memory.taskContext}`);
  if (memory.userLocation) parts.push(`【用户位置】\n${memory.userLocation}`);
  if (memory.persona) parts.push(`【人格与角色】\n${memory.persona}`);
  if (memory.values) parts.push(`【价值观与原则】\n${memory.values}`);
  if (memory.abilities) parts.push(`【能力倾向】\n${memory.abilities}`);
  if (memory.agentCaps) parts.push(`【你的 Agent 专属能力】\n${memory.agentCaps}`);
  if (memory.worldCaps) parts.push(`【Agent World】\n${memory.worldCaps}`);
  if (memory.narrativeRecall) parts.push(`【Memory Tree 检索摘录】\n${memory.narrativeRecall}`);
  if (memory.memorySummary) parts.push(`【持久记忆与偏好】\n${memory.memorySummary}`);
  if (memory.interruptedContext) parts.push(memory.interruptedContext);
  parts.push(baseSystem.trim());
  return parts.join("\n\n");
}
