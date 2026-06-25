import { join } from "node:path";

import { envBool } from "../config/memory-env.js";

function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envPositiveFloat(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? "");
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

export function getAgenticMemorySearchTopK(): number {
  return envPositiveInt("AGENT_AGENTIC_MEMORY_SEARCH_TOP_K", 30);
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

/** 时间衰减半衰期（小时），超期记忆的相关度按指数衰减 */
export function getTimeDecayHalfLifeHours(): number {
  return envPositiveFloat("AGENT_MEMORY_TIME_DECAY_HALF_LIFE_H", 72);
}

/** 高信号记忆的检索加权倍率 */
export function getHighSignalBoost(): number {
  return envPositiveFloat("AGENT_MEMORY_HIGH_SIGNAL_BOOST", 1.5);
}

/** 低信号缓冲最大条目数，达到后触发批量摘要写入 */
export function getLowSignalBufferMaxItems(): number {
  return envPositiveInt("AGENT_MEMORY_LOW_SIGNAL_BUFFER_MAX_ITEMS", 10);
}

/** 低信号缓冲最大字符数，达到后触发批量摘要写入 */
export function getLowSignalBufferMaxChars(): number {
  return envPositiveInt("AGENT_MEMORY_LOW_SIGNAL_BUFFER_MAX_CHARS", 8000);
}

/** 召回压缩触发阈值（字符数），超过则调用 LLM 压缩 */
export function getRecallCompressThreshold(): number {
  return envPositiveInt("AGENT_MEMORY_RECALL_COMPRESS_THRESHOLD", 2500);
}

/** 记忆 TTL（天），超过此天数的低重要性记忆可被清理。0=不清理 */
export function getMemoryTTLDays(): number {
  return envPositiveInt("AGENT_MEMORY_TTL_DAYS", 60);
}

/** 生命周期清理间隔（分钟） */
export function getLifecycleIntervalMin(): number {
  return envPositiveInt("AGENT_MEMORY_LIFECYCLE_INTERVAL_MIN", 360);
}

/** 去重相似度阈值（0-1），高于此值视为重复记忆 */
export function getDedupSimilarityThreshold(): number {
  return envPositiveFloat("AGENT_MEMORY_DEDUP_SIMILARITY_THRESHOLD", 0.92);
}

export function getSleepAgentEnabled(): boolean {
  return envBool("AGENT_MEMORY_SLEEP_AGENT_ENABLED", true);
}
