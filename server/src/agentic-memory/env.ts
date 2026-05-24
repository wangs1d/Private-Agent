import { join } from "node:path";

import { envBool } from "../config/memory-env.js";

function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function isAgenticMemoryEnabled(): boolean {
  return envBool("AGENT_AGENTIC_MEMORY_ENABLED", true);
}

export function getAgenticMemoryDir(): string {
  return (
    process.env.AGENT_AGENTIC_MEMORY_DIR?.trim() ||
    join(process.cwd(), "data", "agentic_memory")
  );
}

export function getAgenticMemoryCollection(): string {
  return process.env.AGENT_AGENTIC_MEMORY_COLLECTION?.trim() || "agentic_memories";
}

export function getAgenticMemoryTopK(): number {
  return envPositiveInt("AGENT_AGENTIC_MEMORY_TOP_K", 8);
}

export function getAgenticMemoryEmbeddingModel(): string {
  return process.env.AGENT_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
}

export function getAgenticMemoryLlmModel(): string {
  return (
    process.env.AGENT_AGENTIC_MEMORY_LLM_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4o-mini"
  );
}

export function resolveOpenAiApiKey(): string | null {
  return (
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    null
  );
}

export function getAgenticMemoryCustomInstructions(): string {
  const custom = process.env.AGENT_AGENTIC_MEMORY_INSTRUCTIONS?.trim();
  if (custom) return custom;
  return [
    "从对话与事件中提取可长期保留的事实、偏好、计划与结论。",
    "保留「前因 → 行动 → 结果」因果链，标注时间、人物与主题，便于跨会话联想。",
    "允许跨主题跳跃：若新信息与旧记忆存在隐含关联（同一项目、同一人物、同一目标），应建立联系而非孤立存储。",
    "合并重复或矛盾信息，用简洁中文陈述；不确定时保留原文线索。",
  ].join("\n");
}
