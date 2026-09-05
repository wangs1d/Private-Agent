import { join } from "node:path";

import { envBool } from "../config/memory-env.js";
import { isPlaceholderApiKey } from "../config/api-key-validator.js";
// 统一嵌入模型解析：AGENT_EMBEDDING_MODEL → OPENAI_EMBEDDINGS_MODEL → 默认，
// 与 humanLike / narrative-hybrid / forgotten 等通道保持同一模型（阈值与分数才可比）。
import { resolveEmbeddingModel } from "../services/openai-embedding-client.js";

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
  return resolveEmbeddingModel();
}

/**
 * 解析可用的 Embedding 端点（OpenAI 兼容 /v1/embeddings）。
 * 优先显式配置，其次 OPENAI_EMBEDDINGS_URL，再退到 OPENAI_BASE_URL——
 * 但仅当该 Base URL 真的提供 embeddings（DeepSeek 等纯聊天渠道不支持，返回 null）。
 */
export function getAgenticMemoryEmbeddingBaseUrl(): string | null {
  const explicit = process.env.AGENT_EMBEDDING_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const embeddingsUrl = process.env.OPENAI_EMBEDDINGS_URL?.trim();
  if (embeddingsUrl) return embeddingsUrl.replace(/\/+$/, "");

  const chatBase = process.env.OPENAI_BASE_URL?.trim();
  if (!chatBase) return null;
  const host = chatBase.toLowerCase();
  if (/deepseek|moonshot|kimi/.test(host)) return null; // 无 /embeddings 的纯聊天渠道
  return chatBase.replace(/\/+$/, "");
}

/** 按模型推导 embedding 维度；AGENT_EMBEDDING_DIMENSIONS 可显式覆盖 */
export function getAgenticMemoryEmbeddingDims(model: string): number {
  const explicit = Number.parseInt(process.env.AGENT_EMBEDDING_DIMENSIONS ?? "", 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const m = model.toLowerCase();
  if (m.includes("text-embedding-3-large")) return 3072;
  if (m.includes("text-embedding-3")) return 1536;
  if (m.includes("bge-m3")) return 1024;
  if (m.includes("bge-large")) return 1024;
  if (m.includes("bge-small")) return 512;
  if (m.includes("m3e")) return 1024;
  return 1536;
}

/** Embedding 专用 Key：优先 AGENT_EMBEDDING_API_KEY，其次对话 Key */
export function resolveEmbeddingApiKey(): string | null {
  const key =
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    null;
  if (isPlaceholderApiKey(key)) return null;
  return key;
}

export function getAgenticMemoryLlmModel(): string {
  return (
    process.env.AGENT_AGENTIC_MEMORY_LLM_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4o-mini"
  );
}

export function resolveOpenAiApiKey(): string | null {
  const key =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    null;
  // 防御：占位符 key（sk-placeholder-... 等）不应被当作真 key 传给 mem0ai
  if (isPlaceholderApiKey(key)) return null;
  return key;
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

// ============================================================
// 方案 A：记忆层间打通（memory-bridge）
// ============================================================

/** 桥接层开关（缺省开；关闭后 narrative 写入/召回回退旧双写行为） */
export function isMemoryBridgeEnabled(): boolean {
  return envBool("AGENT_MEMORY_BRIDGE_ENABLED", true);
}

/** 遗忘同步扫描间隔（分钟，0=关闭定时器，仅手动调用 syncForgetting） */
export function getBridgeForgetSyncIntervalMin(): number {
  const v = Number.parseInt(process.env.AGENT_MEMORY_BRIDGE_FORGET_SYNC_INTERVAL_MIN ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}

/** 融合召回最终保留条数 */
export function getBridgeFusedTopK(): number {
  return envPositiveInt("AGENT_MEMORY_BRIDGE_FUSED_TOP_K", 8);
}

// ============================================================
// 方案 B：语义账本（ledger）
// ============================================================

export function isAgenticLedgerEnabled(): boolean {
  return envBool("AGENT_MEMORY_LEDGER_ENABLED", true);
}

/** 账本保留策略：superseded/作废超过 N 天物理删除；0=永保留 */
export function getLedgerRetentionDays(): number {
  return envPositiveInt("AGENT_MEMORY_LEDGER_RETENTION_DAYS", 180);
}

// ============================================================
// 用户理解档案（User Understanding Store）
// ============================================================

export function isUserUnderstandingEnabled(): boolean {
  return envBool("AGENT_USER_UNDERSTANDING_ENABLED", true);
}

// ============================================================
// 方案 C：承诺草稿板（commitment board）
// ============================================================

export function isCommitmentBoardEnabled(): boolean {
  return envBool("AGENT_COMMITMENT_BOARD_ENABLED", true);
}

/** 扫描循环间隔（分钟） */
export function getCommitmentScanIntervalMin(): number {
  return envPositiveInt("AGENT_COMMITMENT_SCAN_INTERVAL_MIN", 5);
}

/** 对话自动提取承诺（LLM）开关；关闭后仅显式工具通道 */
export function isCommitmentAutoExtractEnabled(): boolean {
  return envBool("AGENT_COMMITMENT_AUTO_EXTRACT_ENABLED", true);
}

/**
 * 承诺自动提取范围（P0-2 捕获与记忆路由解耦）：
 *   high = 仅高信号路径抽取（旧行为，灰度回退档）
 *   all  = 低信号写入也 fire-and-forget 抽取——口语承诺（"明天发你"）通常
 *          被记忆侧判为临时上下文/decay，与存储价值无关，承诺照样要抓。
 *          抽取是 LLM 通道自身产出，无词表预筛。
 */
export function getCommitmentExtractScope(): "high" | "all" {
  const raw = process.env.AGENT_COMMITMENT_EXTRACT_SCOPE?.trim().toLowerCase();
  return raw === "high" ? "high" : "all";
}

// ============================================================
// 方案 D：溯源作废（provenance）
// ============================================================

export function isProvenanceEnabled(): boolean {
  return envBool("AGENT_MEMORY_PROVENANCE_ENABLED", true);
}
