import { USER_AGENT_TOOL_SYSTEM_SUFFIX } from "@private-ai-agent/agent-world";
import type { AgentPromptMemoryContext } from "../external-model/types.js";

/**
 * 与 `USER_AGENT_TOOL_SYSTEM_SUFFIX` 首段一致，用于判断 system 是否已拼接工具说明（幂等追加）。
 * 参考 Hermes `prompt_builder`：工具相关说明在单一处维护，避免各 Provider 分叉。
 */
export const AGENT_TOOL_SYSTEM_SUFFIX_MARKER = "【Agent World 开放式注册】";
export const CLOCK_TOOL_SYSTEM_SUFFIX_MARKER = "【时钟】";

const CLOCK_TOOL_SYSTEM_SUFFIX =
  "\n\n【时钟】用户询问当前时间、日期、星期几时，必须调用 clock.get_current_time 或 clock.get_date（通过 IP 识别时区），禁止凭训练数据臆测时间。";

/**
 * 在启用 function calling / 工具环时，向 system 内容追加 Agent World 工具指引（已包含则跳过）。
 */
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

/**
 * 逗号分隔键列表；未设置或设为 `off`/`false`/`0` 时不把 UAP 记忆注入 system（与旧行为一致）。
 * 例：`persona,values,abilities,memory_summary`（长期演化时建议包含慢变量键）
 */
export function parsePromptMemoryKeysFromEnv(): string[] | null {
  const raw = process.env.AGENT_PROMPT_MEMORY_KEYS?.trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "off" || raw.toLowerCase() === "false") {
    return null;
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const SLICE_RESERVED_KEYS = new Set([
  "persona",
  "soul",
  "values",
  "values_profile",
  "abilities",
  "skill_tendencies",
]);

/**
 * 将 UAP 快照中的条目转为分层片段：人格 / 价值观 / 能力倾向 / 其余键合并为履历块。
 */
export function sliceMemoryEntriesToPromptContext(
  entries: Record<string, unknown>,
): AgentPromptMemoryContext {
  const str = (v: unknown): string => {
    if (typeof v === "string") return v.trim();
    if (v == null) return "";
    if (typeof v === "object") return "";
    return String(v).trim();
  };

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
  const memorySummary = memoryParts.join("\n\n");

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
    !memory?.worldCaps &&
    !memory?.narrativeRecall &&
    !memory?.memorySummary
  ) {
    return baseSystem.trim();
  }
  const parts: string[] = [];
  if (memory.persona) parts.push(`【人格与角色】\n${memory.persona}`);
  if (memory.values) parts.push(`【价值观与原则】\n${memory.values}`);
  if (memory.abilities) parts.push(`【能力倾向】\n${memory.abilities}`);
  if (memory.worldCaps) parts.push(`【Agent World 当前资源与已解锁技能】\n${memory.worldCaps}`);
  if (memory.narrativeRecall) parts.push(`【相关长期叙事与履历】\n${memory.narrativeRecall}`);
  if (memory.memorySummary) parts.push(`【持久记忆与偏好】\n${memory.memorySummary}`);
  parts.push(baseSystem.trim());
  return parts.join("\n\n");
}
