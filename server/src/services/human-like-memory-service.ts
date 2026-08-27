import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig } from "../external-model/resolve-provider.js";
import { dedupeMemoryLines, normalizeMemoryLine, semanticFingerprint } from "./memory-record-utils.js";
import { fetchOpenAiCompatibleEmbedding } from "./openai-embedding-client.js";
import { isPlaceholderApiKey } from "../config/api-key-validator.js";
import type { InferenceNode } from "../brain/types.js";

/**
 * 真向量 cosine 相似度（方案 C）。
 * 用于 HumanLikeMemory 图谱节点的语义关联，替代原 string 精确匹配。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 向量缓存（进程内），key = 文本指纹，TTL 30min，避免重复算 embedding */
const embeddingCache = new Map<string, { vector: number[]; ts: number }>();
const EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * 异步计算文本的真 embedding（方案 C 核心）。
 * 无 API key 或 key 是占位符时返回 null（调用方降级到原逻辑）。
 * 带 30min 缓存，避免 ingest 同一文本重复算。
 */
async function computeEmbedding(text: string): Promise<number[] | null> {
  const apiKey =
    process.env.AGENT_EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (isPlaceholderApiKey(apiKey)) return null;
  const cacheKey = semanticFingerprint(text) || text.slice(0, 64);
  const now = Date.now();
  const cached = embeddingCache.get(cacheKey);
  if (cached && now - cached.ts < EMBEDDING_CACHE_TTL_MS) {
    return cached.vector;
  }
  try {
    const model = process.env.OPENAI_EMBEDDINGS_MODEL?.trim() || "text-embedding-3-small";
    // 不显式传 apiKey：让 client 内部 resolveEmbeddingEndpoint 统一走 AGENT_EMBEDDING_API_KEY，
    // 避免用对话 LLM key（OPENAI_API_KEY，如 DeepSeek）去打 embedding 端点导致 401。
    const r = await fetchOpenAiCompatibleEmbedding({
      model,
      input: text,
      // embedding 仅作检索增强：给短超时，慢/失败时降级到本地关键词检索（cosineLikeScore），
      // 避免把 buildRecall 拖到数秒，进而导致对话链路的记忆注入（prepareNarrativeRecall）超时失败。
      timeoutMs: 1200,
    });
    embeddingCache.set(cacheKey, { vector: r.vector, ts: now });
    return r.vector;
  } catch (err) {
    console.log(`[HumanLikeMemory] computeEmbedding 失败: ${err}`);
    return null;
  }
}

/**
 * 从 vectorFingerprint 字段解析真向量。
 * 旧节点存的是 normalizeMemoryLine(summary)（非 JSON 数组），解析失败返回 null。
 * 新节点存的是 JSON 序列化的向量数组。
 */
function parseVectorFingerprint(fp: string): number[] | null {
  if (!fp || !fp.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(fp);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "number") {
      return parsed as number[];
    }
  } catch {
    // 旧格式（非 JSON），降级到 null
  }
  return null;
}

/** 把真向量序列化为 vectorFingerprint 字段可存的字符串 */
function serializeVector(vec: number[]): string {
  return JSON.stringify(vec);
}

export type MemoryContextKind = "main" | "notes";
export type MemoryDomainLifecycle = "knowledge" | "transactional" | "temporary" | "relationship" | "procedural";
export type MemoryNodeKind = "entity" | "event" | "knowledge" | "experience" | "procedure";
export type RecallMode = "single_domain" | "cross_domain";
export type RecallDetailLevel = "summary" | "detail" | "source";
export type MemoryDeletionStage = "active" | "downranked" | "cold" | "soft_deleted" | "hard_deleted";
export type SleepAgentStage =
  | "daily_cleanup"
  | "weekly_merge"
  | "monthly_abstract"
  | "consistency_audit"
  | "promote_knowledge"
  | "connection_pruning"
  | "schema_formation";

export type MemoryVersionRecord = {
  versionId: string;
  previousVersionId: string | null;
  summary: string;
  createdAt: string;
  confidence: number;
  importance: number;
  correctness: "unknown" | "confirmed" | "suspected_error" | "rejected";
};

export type MemoryNodeRecord = {
  id: string;
  actorId: string;
  domainId: string;
  parentDomainId: string | null;
  kind: MemoryNodeKind;
  source: string;
  sourceType: "chat" | "tool" | "digest" | "world" | "system";
  context: MemoryContextKind;
  summary: string;
  rawRef?: string;
  keywords: string[];
  sceneTags: string[];
  emotionTags: string[];
  entityTags: string[];
  semanticFingerprint: string;
  vectorFingerprint: string;
  timestamp: string;
  lastAccessedAt: string;
  accessCount: number;
  importance: number;
  confidence: number;
  frequencyScore: number;
  recencyScore: number;
  domainScore: number;
  userFeedbackScore: number;
  correctness: "unknown" | "confirmed" | "suspected_error" | "rejected";
  deletionStage: MemoryDeletionStage;
  isArchived: boolean;
  conflictGroupId?: string;
  currentVersionId: string;
  versionIds: string[];
  metadata?: Record<string, unknown>;
};

export type MemoryEdgeRecord = {
  id: string;
  actorId: string;
  from: string;
  to: string;
  relation: "semantic" | "entity" | "temporal" | "scene" | "emotion" | "manual" | "version";
  weight: number;
  createdAt: string;
  updatedAt: string;
  decayFactor: number;
  hopCost: number;
};

export type MemoryCommunityRecord = {
  id: string;
  actorId: string;
  domainId: string;
  label: string;
  nodeIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type MemoryDomainPolicy = {
  parentDomainId: string | null;
  lifecycle: MemoryDomainLifecycle;
  enabled: boolean;
  retired: boolean;
  retentionDays: number;
  recallWeight: number;
  forgettingFactor: number;
  encryptionLevel: "none" | "standard" | "high";
  coldStorageAfterDays: number;
  softDeleteAfterDays: number;
  hardDeleteAfterDays: number;
  maxCrossDomainHops: number;
};

export type HumanLikeMemoryPolicyFile = {
  version: number;
  domains: Record<string, MemoryDomainPolicy>;
  retrieval: {
    maxRecallItems: number;
    maxCrossDomainItems: number;
    maxHopCount: number;
    diversityPenalty: number;
    userNegativeFeedbackPenalty: number;
    routeCrossDomainConfidenceThreshold: number;
  };
  sleepAgent: {
    enabled: boolean;
    dailyCleanupHour: number;
    weeklyMergeWeekday: number;
    monthlyAbstractDay: number;
    maxNodesPerRun: number;
    maxActionsPerRun: number;
    llmPlannerEnabled: boolean;
  };
};

export type HumanLikeMemoryStoreShape = {
  version: number;
  domains: Record<string, MemoryDomainPolicy>;
  nodes: Record<string, MemoryNodeRecord>;
  edges: Record<string, MemoryEdgeRecord>;
  versions: Record<string, MemoryVersionRecord>;
  communities: Record<string, MemoryCommunityRecord>;
};

export type HumanLikeMemoryRecallOptions = {
  source?: string;
  context?: MemoryContextKind;
  explicitDomain?: string;
  crossDomain?: boolean;
  limit?: number;
  detailLevel?: RecallDetailLevel;
};

export type HumanLikeMemoryRecallResult = {
  domainId: string;
  mode: RecallMode;
  recalledNodeIds: string[];
  confidence: number;
  text: string;
};

export type HumanLikeMemorySleepReport = {
  actorId: string;
  dailyCleanupCount: number;
  weeklyMergedCount: number;
  monthlyAbstractedCount: number;
  consistencyFlagCount: number;
  knowledgePromotedCount: number;
  compressionRate: number;
  estimatedRecallPrecision: number;
  plannedActions: number;
  executedActions: number;
  stageReports: Array<{
    stage: SleepAgentStage;
    changed: number;
    notes: string[];
  }>;
};

type HybridRetrievalCandidate = {
  node: MemoryNodeRecord;
  structureScore: number;
  keywordScore: number;
  vectorScore: number;
  finalScore: number;
};

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return overlap / Math.max(leftSet.size, rightSet.size);
}

function computeSimilarity(
  left: MemoryNodeRecord,
  right: MemoryNodeRecord,
): { score: number } {
  const semanticScore =
    left.semanticFingerprint.length > 0 && left.semanticFingerprint === right.semanticFingerprint
      ? 1
      : 0;
  // 方案 C：vectorScore 优先用真向量 cosine，无向量时降级到原字符串精确匹配
  const leftVec = parseVectorFingerprint(left.vectorFingerprint);
  const rightVec = parseVectorFingerprint(right.vectorFingerprint);
  let vectorScore: number;
  if (leftVec && rightVec) {
    // 新路径：真向量 cosine 相似度（0-1），替代原 0/0.92 二值
    vectorScore = Math.max(0, cosineSimilarity(leftVec, rightVec));
  } else {
    // 降级路径：旧节点无真向量，保持原字符串精确匹配逻辑
    vectorScore =
      left.vectorFingerprint.length > 0 && left.vectorFingerprint === right.vectorFingerprint ? 0.92 : 0;
  }
  const keywordScore = overlapScore(left.keywords, right.keywords);
  const entityScore = overlapScore(left.entityTags, right.entityTags);
  const sceneScore = overlapScore(left.sceneTags, right.sceneTags);
  const emotionScore = overlapScore(left.emotionTags, right.emotionTags);
  const score =
    semanticScore * 0.4 +
    vectorScore * 0.22 +
    keywordScore * 0.2 +
    entityScore * 0.1 +
    sceneScore * 0.05 +
    emotionScore * 0.03;
  return { score: clamp(score, 0, 1) };
}

type SleepAction =
  | { type: "downrank"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "cold"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "soft_delete"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "hard_delete"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "merge"; nodeIds: string[]; stage: SleepAgentStage; reason: string; summary?: string }
  | { type: "promote_knowledge"; nodeIds: string[]; stage: SleepAgentStage; reason: string; summary: string }
  | { type: "mark_error"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "mark_conflict"; nodeIds: string[]; stage: SleepAgentStage; reason: string }
  | { type: "decay_weight"; nodeId: string; stage: SleepAgentStage; reason: string; delta: number };

const DEFAULT_POLICY: HumanLikeMemoryPolicyFile = {
  version: 2,
  domains: {
    general: {
      parentDomainId: null,
      lifecycle: "knowledge",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1,
      forgettingFactor: 1,
      encryptionLevel: "none",
      coldStorageAfterDays: 120,
      softDeleteAfterDays: 365,
      hardDeleteAfterDays: 1000,
      maxCrossDomainHops: 2,
    },
    schedule: {
      parentDomainId: "general",
      lifecycle: "transactional",
      enabled: true,
      retired: false,
      retentionDays: 180,
      recallWeight: 0.9,
      forgettingFactor: 1.2,
      encryptionLevel: "standard",
      coldStorageAfterDays: 45,
      softDeleteAfterDays: 120,
      hardDeleteAfterDays: 365,
      maxCrossDomainHops: 1,
    },
    relationship: {
      parentDomainId: "general",
      lifecycle: "relationship",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1.2,
      forgettingFactor: 0.8,
      encryptionLevel: "standard",
      coldStorageAfterDays: 240,
      softDeleteAfterDays: 720,
      hardDeleteAfterDays: 2000,
      maxCrossDomainHops: 3,
    },
    profile: {
      parentDomainId: "general",
      lifecycle: "knowledge",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1.1,
      forgettingFactor: 0.7,
      encryptionLevel: "high",
      coldStorageAfterDays: 365,
      softDeleteAfterDays: 1000,
      hardDeleteAfterDays: 2000,
      maxCrossDomainHops: 2,
    },
    notes: {
      parentDomainId: "general",
      lifecycle: "knowledge",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 0.8,
      forgettingFactor: 1,
      encryptionLevel: "none",
      coldStorageAfterDays: 180,
      softDeleteAfterDays: 730,
      hardDeleteAfterDays: 1800,
      maxCrossDomainHops: 2,
    },
    temporary: {
      parentDomainId: "general",
      lifecycle: "temporary",
      enabled: true,
      retired: false,
      retentionDays: 14,
      recallWeight: 0.4,
      forgettingFactor: 1.6,
      encryptionLevel: "none",
      coldStorageAfterDays: 7,
      softDeleteAfterDays: 21,
      hardDeleteAfterDays: 45,
      maxCrossDomainHops: 1,
    },
    procedural: {
      parentDomainId: null,
      lifecycle: "procedural",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1.2,
      forgettingFactor: 0.6,
      encryptionLevel: "none",
      coldStorageAfterDays: 365,
      softDeleteAfterDays: 1200,
      hardDeleteAfterDays: 2400,
      maxCrossDomainHops: 2,
    },
  },
  retrieval: {
    maxRecallItems: 8,
    maxCrossDomainItems: 5,
    maxHopCount: 3,
    diversityPenalty: 0.12,
    userNegativeFeedbackPenalty: 0.4,
    routeCrossDomainConfidenceThreshold: 0.42,
  },
  sleepAgent: {
    enabled: true,
    dailyCleanupHour: 2,
    weeklyMergeWeekday: 0,
    monthlyAbstractDay: 1,
    maxNodesPerRun: 300,
    maxActionsPerRun: 120,
    llmPlannerEnabled: true,
  },
};

const DEFAULT_STORE: HumanLikeMemoryStoreShape = {
  version: 2,
  domains: structuredClone(DEFAULT_POLICY.domains),
  nodes: {},
  edges: {},
  versions: {},
  communities: {},
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 自动确认阈值：节点被召回次数 >= 此值时，自动从 "unknown" 升级为 "confirmed"。
 *
 * 设计意图：用户要求"agent 对有用的记忆是牢固的，不需要像人类一样有时候想不起"。
 * "有用"通过召回频次衡量 —— 3 次召回说明这条记忆确实在被反复使用，应锁定不衰减。
 * 阈值过低（1-2 次）会误锁偶发召回；过高（5+ 次）需要太多轮才生效，失去实用性。
 */
const AUTO_CONFIRM_THRESHOLD = 3;

/**
 * deletionStage 回退映射（供 reawakenNode 使用）。
 * 与 ForgettingController 中的 STAGE_ORDER 对应但反向：
 *   cold → downranked → active
 *   soft_deleted → cold
 *   active / hard_deleted 为终态，不再回退。
 */
const STAGE_REGRESS: Record<MemoryDeletionStage, MemoryDeletionStage> = {
  active: "active",
  downranked: "active",
  cold: "downranked",
  soft_deleted: "cold",
  hard_deleted: "hard_deleted",
};

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueStrings(values: string[], limit = 12): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function extractKeywords(text: string): string[] {
  const zh = text.match(/[\u4e00-\u9fff]{2,8}/g) ?? [];
  const en =
    text.toLowerCase().match(/[a-z][a-z0-9_-]{2,24}/g)?.filter((token) => token.length >= 3) ?? [];
  return uniqueStrings([...zh, ...en], 14);
}

function extractEntityTags(text: string): string[] {
  const candidates = text.match(/[\u4e00-\u9fffA-Za-z0-9_-]{2,20}/g) ?? [];
  return uniqueStrings(candidates.filter((token) => /[\u4e00-\u9fffA-Z]/.test(token[0] ?? "")), 10);
}

function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  if (/开心|高兴|满意|喜欢|期待|兴奋/.test(text)) tags.push("positive");
  if (/难过|焦虑|担心|害怕|压力|生气|烦/.test(text)) tags.push("negative");
  if (/重要|必须|务必|提醒|风险|警告/.test(text)) tags.push("urgent");
  if (/想念|关心|陪伴|安慰|信任|晚安/.test(text)) tags.push("warm");
  return tags;
}

function inferNodeKind(text: string, source: string): MemoryNodeKind {
  const combined = `${text} ${source}`;
  if (/流程|步骤|SOP|操作|调用|复用|模板|procedure/i.test(combined)) return "procedure";
  if (/经验|规律|总结|原则|教训/.test(combined)) return "experience";
  if (/事件|发生|今天|昨天|刚刚|上次|记录/.test(combined)) return "event";
  if (/人|朋友|家人|公司|项目|地点|账号/.test(combined)) return "entity";
  return "knowledge";
}

function inferDomain(text: string, source: string, context: MemoryContextKind): string {
  if (context === "notes") return "notes";
  if (/流程|步骤|SOP|操作|调用|模板|复用|procedure/i.test(`${text} ${source}`)) return "procedural";
  if (/日程|提醒|待办|明天|下周|计划|calendar|schedule/i.test(`${text} ${source}`)) return "schedule";
  if (/喜欢|偏好|生日|身份|习惯|讨厌|画像|profile/i.test(`${text} ${source}`)) return "profile";
  if (/关系|家人|朋友|安慰|陪伴|信任|晚安/i.test(`${text} ${source}`)) return "relationship";
  if (/临时|本次|会话|稍后|temporary/i.test(`${text} ${source}`)) return "temporary";
  return "general";
}

function inferSceneTags(source: string, context: MemoryContextKind, domainId: string): string[] {
  return uniqueStrings([context, domainId, source.split(":")[0] ?? source], 8);
}

function cosineLikeScore(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  const q = new Set(queryTokens);
  const t = new Set(targetTokens);
  let overlap = 0;
  for (const token of q) {
    if (t.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(q.size * t.size);
}

async function llmMergeLines(lines: string[]): Promise<string[] | null> {
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm || lines.length < 2) return null;

  try {
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_SLEEP_AGENT_MODEL?.trim() || llm.model || "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You merge redundant or fragmented memories into concise durable summaries. Return JSON only: {"merged":["..."]}.',
        },
        { role: "user", content: JSON.stringify({ lines }) },
      ],
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as { merged?: string[] };
    if (!Array.isArray(parsed.merged)) return null;
    return uniqueStrings(parsed.merged.map((item) => String(item)), 6);
  } catch {
    return null;
  }
}

async function llmExtractExperience(lines: string[]): Promise<string | null> {
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm || lines.length < 3) return null;

  try {
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_SLEEP_AGENT_MODEL?.trim() || llm.model || "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Extract a reusable experience rule from related memories. Return JSON only: {"summary":"..."}',
        },
        { role: "user", content: JSON.stringify({ lines }) },
      ],
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as { summary?: string };
    return typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : null;
  } catch {
    return null;
  }
}

async function llmPlanSleepActions(
  actorId: string,
  nodes: MemoryNodeRecord[],
  policy: HumanLikeMemoryPolicyFile,
): Promise<SleepAction[] | null> {
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm || !policy.sleepAgent.llmPlannerEnabled || nodes.length === 0) return null;

  try {
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_SLEEP_AGENT_MODEL?.trim() || llm.model || "gpt-4.1-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Plan incremental memory consolidation actions. Return JSON only: {"actions":[...]}. Allowed types: downrank,cold,soft_delete,hard_delete,merge,promote_knowledge,mark_error,mark_conflict.',
        },
        {
          role: "user",
          content: JSON.stringify({
            actorId,
            maxActions: Math.min(policy.sleepAgent.maxActionsPerRun, 24),
            nodes: nodes.slice(0, 40).map((node) => ({
              id: node.id,
              domainId: node.domainId,
              kind: node.kind,
              summary: node.summary.slice(0, 160),
              importance: node.importance,
              confidence: node.confidence,
              accessCount: node.accessCount,
              correctness: node.correctness,
              deletionStage: node.deletionStage,
            })),
          }),
        },
      ],
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as { actions?: SleepAction[] };
    return Array.isArray(parsed.actions) ? parsed.actions.slice(0, Math.min(policy.sleepAgent.maxActionsPerRun, 24)) : null;
  } catch {
    return null;
  }
}

export class HumanLikeMemoryService {
  private readonly filePath: string;
  private readonly policyFilePath: string;
  private store: HumanLikeMemoryStoreShape = structuredClone(DEFAULT_STORE);
  private policy: HumanLikeMemoryPolicyFile = structuredClone(DEFAULT_POLICY);
  private persistChain: Promise<void> = Promise.resolve();
  private policyWatcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private readonly telemetry = {
    recallHits: 0,
    recallMisses: 0,
    recallLatencyMs: [] as number[],
    writes: 0,
    writeLatencyMs: [] as number[],
    routeSingleDomain: 0,
    routeCrossDomain: 0,
  };

  constructor(filePath?: string, policyFilePath?: string) {
    this.filePath =
      filePath ?? process.env.AGENT_HUMAN_MEMORY_FILE?.trim() ?? join(process.cwd(), "data", "human-memory.json");
    this.policyFilePath =
      policyFilePath ??
      process.env.AGENT_HUMAN_MEMORY_POLICY_FILE?.trim() ??
      join(process.cwd(), "data", "human-memory-policy.json");
  }

  async load(): Promise<void> {
    await this.loadPolicy();
    await this.loadStore();
    this.startPolicyWatcher();
  }

  getPolicySnapshot(): HumanLikeMemoryPolicyFile {
    return structuredClone(this.policy);
  }

  getTelemetrySnapshot(): Record<string, unknown> {
    const average = (values: number[]): number =>
      values.length > 0 ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0;
    const recallTotal = this.telemetry.recallHits + this.telemetry.recallMisses;
    return {
      recallHitRate: recallTotal > 0 ? Number((this.telemetry.recallHits / recallTotal).toFixed(3)) : 0,
      recallAverageLatencyMs: average(this.telemetry.recallLatencyMs),
      writeCount: this.telemetry.writes,
      writeAverageLatencyMs: average(this.telemetry.writeLatencyMs),
      routeSingleDomain: this.telemetry.routeSingleDomain,
      routeCrossDomain: this.telemetry.routeCrossDomain,
    };
  }

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { context?: MemoryContextKind; domain?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const start = Date.now();
    const summary = text.trim().replace(/\s+/g, " ");
    if (!summary || summary.length < 6) return;

    const context = opts?.context ?? "main";
    const domainId = opts?.domain ?? inferDomain(summary, source, context);
    const domainPolicy = this.policy.domains[domainId];
    if (domainPolicy?.enabled === false || domainPolicy?.retired === true) return;

    const kind = inferNodeKind(summary, source);
    const fingerprint = semanticFingerprint(summary) || normalizeMemoryLine(summary);
    const existing = Object.values(this.store.nodes).find(
      (node) => node.actorId === actorId && node.domainId === domainId && node.semanticFingerprint === fingerprint,
    );

    const importance = this.computeImportance(summary, source, opts?.metadata);
    const confidence = this.computeConfidence(summary, opts?.metadata);

    if (existing) {
      const versionId = this.appendVersion(existing, summary, confidence, importance);
      existing.summary = summary;
      existing.currentVersionId = versionId;
      existing.lastAccessedAt = nowIso();
      existing.accessCount += 1;
      existing.frequencyScore = clamp(existing.frequencyScore + 0.12, 0, 5);
      existing.importance = Math.max(existing.importance, importance);
      existing.confidence = Math.max(existing.confidence, confidence);
      // 自动确认：反复 re-ingest（同一记忆被多次提及）说明是用户持续关注的有用信息
      // 与 buildRecall 的自动确认机制一致，阈值 AUTO_CONFIRM_THRESHOLD
      if (
        existing.correctness === "unknown" &&
        existing.accessCount >= AUTO_CONFIRM_THRESHOLD
      ) {
        existing.correctness = "confirmed";
      }
      existing.keywords = uniqueStrings([...existing.keywords, ...extractKeywords(summary)], 14);
      existing.entityTags = uniqueStrings([...existing.entityTags, ...extractEntityTags(summary)], 12);
      existing.sceneTags = uniqueStrings([...existing.sceneTags, ...inferSceneTags(source, context, domainId)], 8);
      existing.emotionTags = uniqueStrings([...existing.emotionTags, ...extractEmotionTags(summary)], 8);
      this.rebuildLinksForNode(existing);
      this.schedulePersist();
      this.recordWriteLatency(start);
      // 方案 C：re-ingest 时也异步更新 embedding（summary 可能已变）
      void this.enhanceNodeWithEmbedding(existing.id, summary);
      return;
    }

    const nodeId = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const versionId = this.createVersion(summary, null, confidence, importance);
    // 方案 C：ingest 时先存 normalizeMemoryLine 作为占位，再异步计算真 embedding 覆盖
    // 无 API key 时保持 normalizeMemoryLine（向后兼容旧节点）
    this.store.nodes[nodeId] = {
      id: nodeId,
      actorId,
      domainId,
      parentDomainId: domainPolicy?.parentDomainId ?? null,
      kind,
      source,
      sourceType: this.inferSourceType(source),
      context,
      summary,
      keywords: extractKeywords(summary),
      sceneTags: inferSceneTags(source, context, domainId),
      emotionTags: extractEmotionTags(summary),
      entityTags: extractEntityTags(summary),
      semanticFingerprint: fingerprint,
      vectorFingerprint: normalizeMemoryLine(summary),
      timestamp: nowIso(),
      lastAccessedAt: nowIso(),
      accessCount: 0,
      importance,
      confidence,
      frequencyScore: 0,
      recencyScore: 1,
      domainScore: domainPolicy?.recallWeight ?? 1,
      userFeedbackScore: 1,
      correctness: "unknown",
      deletionStage: "active",
      isArchived: false,
      currentVersionId: versionId,
      versionIds: [versionId],
      metadata: opts?.metadata,
    };
    this.rebuildLinksForNode(this.store.nodes[nodeId]!);
    this.rebuildCommunities(actorId, domainId);
    this.schedulePersist();
    this.recordWriteLatency(start);

    // 方案 C：异步计算真 embedding 覆盖 vectorFingerprint，并重建该节点边
    // 不阻塞主流程，计算完成后增强图谱语义关联质量
    void this.enhanceNodeWithEmbedding(nodeId, summary);
  }

  /**
   * 方案 C：异步计算节点 summary 的真 embedding，覆盖 vectorFingerprint 并重建边。
   * 无 API key 时跳过（保持 normalizeMemoryLine 占位）。
   * 设计意图：ingest 主流程不阻塞，embedding 计算完成后增强图谱语义关联质量。
   */
  private async enhanceNodeWithEmbedding(nodeId: string, summary: string): Promise<void> {
    const vec = await computeEmbedding(summary);
    if (!vec) return; // 无 API key 或计算失败，保持占位
    const node = this.store.nodes[nodeId];
    if (!node || node.summary !== summary) return; // 节点已变更，避免覆盖错误
    node.vectorFingerprint = serializeVector(vec);
    // 重建该节点的边（现在用真向量 cosine 算 similarity，边权重更准）
    this.rebuildLinksForNode(node);
    this.schedulePersist();
  }

  /**
   * 用户反馈回灌：按语义指纹匹配记忆节点，更新 userFeedbackScore（0-1）。
   * 由 MemoryCortex.recordMemoryFeedback 在记录用户反馈时调用。
   * 此前 userFeedbackScore 在 ingest 时固定为 1 且无任何更新路径，
   * 导致 retrieval 打分中的反馈分量（structureScore/penalty）从未生效。
   */
  applyUserFeedback(actorId: string, summary: string, score: number): void {
    const plain = summary.trim();
    if (!plain) return;
    const fingerprint = semanticFingerprint(plain) || normalizeMemoryLine(plain);
    const clamped = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;

    for (const node of Object.values(this.store.nodes)) {
      if (node.actorId !== actorId) continue;
      if (node.semanticFingerprint !== fingerprint) continue;
      node.userFeedbackScore = clamped;
      node.lastAccessedAt = nowIso();
      this.schedulePersist();
      break;
    }
  }

  async buildRecall(
    actorId: string,
    query: string,
    opts?: HumanLikeMemoryRecallOptions,
  ): Promise<HumanLikeMemoryRecallResult> {
    const start = Date.now();
    const cleanedQuery = query.trim();
    const domainId = opts?.explicitDomain ?? inferDomain(cleanedQuery, opts?.source ?? "chat", opts?.context ?? "main");
    const detailLevel = opts?.detailLevel ?? "summary";
    const limit = Math.max(1, opts?.limit ?? this.policy.retrieval.maxRecallItems);
    const mode = this.resolveRecallMode(cleanedQuery, domainId, opts?.crossDomain === true);
    if (mode === "single_domain") this.telemetry.routeSingleDomain += 1;
    else this.telemetry.routeCrossDomain += 1;

    // 方案 C：buildRecall 时算 query 的真 embedding，传给 hybridRetrieve 做真向量检索
    // 无 API key 时返回 null，hybridRetrieve 降级到 cosineLikeScore
    const queryVec = await computeEmbedding(cleanedQuery);

    const candidates = this.hybridRetrieve(actorId, cleanedQuery, domainId, mode, opts?.context, limit, queryVec);
    const selected = this.applyDiversityControl(candidates, limit, mode === "cross_domain");
    if (selected.length === 0) {
      this.telemetry.recallMisses += 1;
      this.recordRecallLatency(start);
      return { domainId, mode, recalledNodeIds: [], confidence: 0, text: "" };
    }

    for (const item of selected) {
      item.node.lastAccessedAt = nowIso();
      item.node.accessCount += 1;
      item.node.frequencyScore = clamp(item.node.frequencyScore + 0.06, 0, 5);
      item.node.recencyScore = 1;
      // 自动确认机制：反复命中（accessCount >= AUTO_CONFIRM_THRESHOLD）的"unknown"节点
      // 自动升级为 "confirmed" —— agent 对有用的记忆是牢固的，不会像人类一样想不起
      // 阈值设为 3：3 次召回说明这条记忆确实在被反复使用，应锁定不衰减
      if (
        item.node.correctness === "unknown" &&
        item.node.accessCount >= AUTO_CONFIRM_THRESHOLD
      ) {
        item.node.correctness = "confirmed";
      }
    }
    this.schedulePersist();

    const confidence = Number(
      (
        selected.reduce((sum, item) => sum + item.finalScore, 0) /
        Math.max(selected.length, 1)
      ).toFixed(3),
    );
    this.telemetry.recallHits += 1;
    this.recordRecallLatency(start);

    return {
      domainId,
      mode,
      recalledNodeIds: selected.map((item) => item.node.id),
      confidence,
      text: this.reconstructRecall(cleanedQuery, domainId, selected.map((item) => item.node), mode, detailLevel, confidence),
    };
  }

  async runSleepCycleForActors(actorIds: string[]): Promise<HumanLikeMemorySleepReport[]> {
    const reports: HumanLikeMemorySleepReport[] = [];
    for (const actorId of actorIds) {
      reports.push(await this.runSleepCycle(actorId));
    }
    return reports;
  }

  markConflict(actorId: string, memoryIdA: string, memoryIdB: string): void {
    const a = this.store.nodes[memoryIdA];
    const b = this.store.nodes[memoryIdB];
    if (!a || !b || a.actorId !== actorId || b.actorId !== actorId) return;
    const groupId = `conflict_${Date.now().toString(36)}`;
    a.conflictGroupId = groupId;
    b.conflictGroupId = groupId;
    a.correctness = "suspected_error";
    b.correctness = "suspected_error";
    this.schedulePersist();
  }

  forgetMemory(actorId: string, memoryId: string): void {
    const node = this.store.nodes[memoryId];
    if (!node || node.actorId !== actorId) return;
    node.deletionStage = "soft_deleted";
    this.schedulePersist();
  }

  archiveDomain(actorId: string, domainId: string): void {
    for (const node of Object.values(this.store.nodes)) {
      if (node.actorId === actorId && node.domainId === domainId && node.deletionStage === "active") {
        node.deletionStage = "cold";
        node.isArchived = true;
      }
    }
    this.schedulePersist();
  }

  /**
   * 获取指定 actor 的所有节点（供 ForgettingController.continuousScore 调用）。
   * 返回节点数组的浅拷贝，避免外部修改内部状态。
   * 排除 hard_deleted 节点（已彻底删除）。
   */
  getAllNodes(actorId: string): MemoryNodeRecord[] {
    return Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId && node.deletionStage !== "hard_deleted")
      .map((node) => ({ ...node }));
  }

  /**
   * 按记忆内容反查图节点 ID（联想种子语义化用）。
   *
   * MemoryRecallItem 不携带 nodeId，而联想扩散 spread 需要真实节点 ID 才能在
   * 图上命中。此方法对每条召回内容在节点 content 里做包含匹配（双向：
   * 节点内容包含查询片段，或查询片段包含节点内容前缀），返回命中的节点 ID。
   *
   * 纯内存扫描（节点量级 < 10^4），不触发持久化；无命中返回空数组。
   */
  findNodeIdsByContent(actorId: string, contents: string[], maxPerContent = 1): string[] {
    if (!contents || contents.length === 0) return [];
    const nodes = Object.values(this.store.nodes).filter(
      (node) =>
        node.actorId === actorId &&
        node.deletionStage !== "hard_deleted" &&
        typeof node.summary === "string" &&
        node.summary.length > 0,
    );
    const result: string[] = [];
    for (const raw of contents) {
      const query = (raw ?? "").trim();
      if (!query) continue;
      // 召回文本可能是"标题: 内容"或被截断的形式，取最长可匹配片段
      const fragments = [query, ...query.split(/[:：\n]/).map((s) => s.trim()).filter((s) => s.length >= 8)]
        .sort((a, b) => b.length - a.length);
      let matched = 0;
      for (const node of nodes) {
        if (matched >= maxPerContent) break;
        const summary = node.summary;
        const hit = fragments.some(
          (frag) => frag.length >= 8 && (summary.includes(frag.slice(0, 32)) || frag.includes(summary.slice(0, 32))),
        );
        if (hit && !result.includes(node.id)) {
          result.push(node.id);
          matched++;
        }
      }
    }
    return result.slice(0, 6);
  }

  /**
   * 更新节点 deletionStage（供 ForgettingController.continuousScore 调用）。
   * 写入后立即持久化到 store。
   */
  updateDeletionStage(actorId: string, nodeId: string, stage: MemoryDeletionStage): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] updateDeletionStage 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    node.deletionStage = stage;
    this.schedulePersist();
  }

  /**
   * 节点再唤醒（供 ForgettingController.reawakenAndStrengthen 调用）。
   * - frequencyScore += 0.3（远超普通 recall 的 +0.06，体现"再唤醒反弹"）
   * - deletionStage 回退一级：cold → downranked → active
   * - lastAccessedAt 更新为当前时间
   * - 写入后立即持久化
   */
  reawakenNode(actorId: string, nodeId: string): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] reawakenNode 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    node.frequencyScore = clamp(node.frequencyScore + 0.3, 0, 5);
    node.deletionStage = STAGE_REGRESS[node.deletionStage];
    node.lastAccessedAt = nowIso();
    this.schedulePersist();
  }

  /**
   * 清除节点所有 edge（供 ForgettingController.pruneConnections 调用）。
   * 保留节点本体供历史追溯，仅清除连接。
   * 写入后立即持久化。
   */
  pruneNodeEdges(actorId: string, nodeId: string): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] pruneNodeEdges 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    const edgeIds = Object.keys(this.store.edges).filter((edgeId) => {
      const edge = this.store.edges[edgeId]!;
      return edge.from === nodeId || edge.to === nodeId;
    });
    for (const edgeId of edgeIds) {
      delete this.store.edges[edgeId];
    }
    console.log(`[HumanLikeMemory] pruneNodeEdges 完成：删除 ${edgeIds.length} 条边 (nodeId=${nodeId})`);
    this.schedulePersist();
  }

  /**
   * 清空指定 actor 的全部记忆（节点 + 边 + 社区 + 版本），并落盘。
   * 供“删除全部聊天记录 / 清空记忆”类功能使用。返回被移除的节点数量。
   */
  clearActorMemory(actorId: string): number {
    const nodeIds = Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId)
      .map((node) => node.id);

    for (const nodeId of nodeIds) {
      const versionIds = this.store.nodes[nodeId]?.versionIds ?? [];
      for (const versionId of versionIds) {
        delete this.store.versions[versionId];
      }
      delete this.store.nodes[nodeId];
    }

    const edgeIds = Object.values(this.store.edges)
      .filter((edge) => edge.actorId === actorId)
      .map((edge) => edge.id);
    for (const edgeId of edgeIds) {
      delete this.store.edges[edgeId];
    }

    const communityIds = Object.values(this.store.communities)
      .filter((community) => community.actorId === actorId)
      .map((community) => community.id);
    for (const communityId of communityIds) {
      delete this.store.communities[communityId];
    }

    if (nodeIds.length > 0 || edgeIds.length > 0 || communityIds.length > 0) {
      this.schedulePersist();
    }

    console.log(
      `[HumanLikeMemory] clearActorMemory 完成：删除 ${nodeIds.length} 节点 / ${edgeIds.length} 条边 / ${communityIds.length} 个社区 (actorId=${actorId})`,
    );
    return nodeIds.length;
  }

  /**
   * 获取指定 actor 的所有边（供 MemoryAssociativeGraph.spread 扩散激活调用）。
   * 返回边数组的浅拷贝，避免外部修改内部状态。
   */
  getAllEdges(actorId: string): MemoryEdgeRecord[] {
    return Object.values(this.store.edges)
      .filter((edge) => edge.actorId === actorId)
      .map((edge) => ({ ...edge }));
  }

  /**
   * 获取指定 actor 指定 sceneTag 的所有节点（供 MemorySchemaFormation.extractSchema 调用）。
   * 排除 hard_deleted 节点。返回节点数组的浅拷贝。
   */
  getNodesBySceneTag(actorId: string, sceneTag: string): MemoryNodeRecord[] {
    return Object.values(this.store.nodes)
      .filter(
        (node) =>
          node.actorId === actorId &&
          node.deletionStage !== "hard_deleted" &&
          node.sceneTags.includes(sceneTag),
      )
      .map((node) => ({ ...node }));
  }

  /**
   * 获取单个节点（供 MemoryReconstructionValidator 校验与来源追溯调用）。
   * 节点不存在或 actorId 不匹配时返回 null。返回浅拷贝。
   */
  getNode(actorId: string, nodeId: string): MemoryNodeRecord | null {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) return null;
    return { ...node };
  }

  /**
   * 获取版本记录（供 MemoryReconstructionValidator.getProvenanceChain 来源链路追溯调用）。
   * 版本不存在时返回 null。返回浅拷贝。
   */
  getVersion(actorId: string, versionId: string): MemoryVersionRecord | null {
    const version = this.store.versions[versionId];
    if (!version) return null;
    // 版本记录不直接关联 actorId，通过节点链间接关联；
    // 此处不强制 actorId 校验（调用方已通过 getNode 确认归属）。
    void actorId; // 显式标记 actorId 保留供未来扩展
    return { ...version };
  }

  /**
   * 标记节点 correctness（供 MemoryReconstructionValidator 标记 suspected_error 调用）。
   * 写入后立即持久化。节点不存在或 actorId 不匹配时静默跳过。
   */
  markNodeCorrectness(actorId: string, nodeId: string, correctness: string): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] markNodeCorrectness 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    node.correctness = correctness as MemoryNodeRecord["correctness"];
    this.schedulePersist();
  }

  /**
   * 回写推理结论为新节点（供 MemoryInferenceEngine 高置信回写调用）。
   *
   * 设计要点：
   *   - kind="knowledge"（inferred 不是有效 MemoryNodeKind，用 knowledge 兜底 + metadata.inferred=true 标记）
   *   - confidence 直接用推理结论的 confidence（> 0.6 才会回写）
   *   - keywords 包含 "推理" + 从 conclusion 自动抽取，让召回时能按 "推理" 关键词找到
   *   - 创建从触发节点到推理节点的边（若可识别）
   *   - 调度持久化（异步）
   */
  ingestInferredNode(actorId: string, node: InferenceNode): void {
    const summary = node.conclusion.trim().replace(/\s+/g, " ");
    if (!summary) return;
    const domainId = "general";
    const domainPolicy = this.policy.domains[domainId];
    if (domainPolicy?.enabled === false || domainPolicy?.retired === true) return;

    const fingerprint = semanticFingerprint(summary) || normalizeMemoryLine(summary);
    // 已存在相同 fingerprint 的节点 → 跳过（避免重复回写）
    const existing = Object.values(this.store.nodes).find(
      (n) => n.actorId === actorId && n.semanticFingerprint === fingerprint,
    );
    if (existing) {
      // 已存在 → 只更新 confidence（取较大值）+ accessCount + 1
      existing.confidence = Math.max(existing.confidence, node.confidence);
      existing.accessCount += 1;
      existing.lastAccessedAt = nowIso();
      this.schedulePersist();
      return;
    }

    const nodeId = `inf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const versionId = this.createVersion(summary, null, node.confidence, 0.6);
    const keywords = uniqueStrings(["推理", ...extractKeywords(summary)], 14);
    this.store.nodes[nodeId] = {
      id: nodeId,
      actorId,
      domainId,
      parentDomainId: domainPolicy?.parentDomainId ?? null,
      kind: "knowledge",
      source: `inference:${node.evidence.rules.join(",")}`,
      sourceType: "system",
      context: "main",
      summary,
      keywords,
      sceneTags: inferSceneTags(`inference:${node.id}`, "main", domainId),
      emotionTags: [],
      entityTags: extractEntityTags(summary),
      semanticFingerprint: fingerprint,
      vectorFingerprint: normalizeMemoryLine(summary),
      timestamp: nowIso(),
      lastAccessedAt: nowIso(),
      accessCount: 0,
      importance: 0.6,
      confidence: node.confidence,
      frequencyScore: 0,
      recencyScore: 1,
      domainScore: domainPolicy?.recallWeight ?? 1,
      userFeedbackScore: 1,
      correctness: "unknown",
      deletionStage: "active",
      isArchived: false,
      currentVersionId: versionId,
      versionIds: [versionId],
      metadata: {
        inferred: true,
        inferenceId: node.id,
        reasoningChain: node.evidence.reasoningChain,
        clueCount: node.evidence.clues.length,
      },
    };
    this.rebuildLinksForNode(this.store.nodes[nodeId]!);
    this.rebuildCommunities(actorId, domainId);
    this.schedulePersist();

    // 异步计算真 embedding 覆盖 vectorFingerprint
    void this.enhanceNodeWithEmbedding(nodeId, summary);
  }

  private async loadStore(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HumanLikeMemoryStoreShape>;
      this.store = {
        version: typeof parsed.version === "number" ? parsed.version : DEFAULT_STORE.version,
        domains: { ...this.policy.domains, ...(parsed.domains ?? {}) },
        nodes: parsed.nodes ?? {},
        edges: parsed.edges ?? {},
        versions: parsed.versions ?? {},
        communities: parsed.communities ?? {},
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw error;
      this.store = structuredClone(DEFAULT_STORE);
    }
  }

  private async loadPolicy(): Promise<void> {
    try {
      const raw = await readFile(this.policyFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HumanLikeMemoryPolicyFile>;
      this.policy = {
        version: typeof parsed.version === "number" ? parsed.version : DEFAULT_POLICY.version,
        domains: { ...DEFAULT_POLICY.domains, ...(parsed.domains ?? {}) },
        retrieval: { ...DEFAULT_POLICY.retrieval, ...(parsed.retrieval ?? {}) },
        sleepAgent: { ...DEFAULT_POLICY.sleepAgent, ...(parsed.sleepAgent ?? {}) },
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw error;
      this.policy = structuredClone(DEFAULT_POLICY);
      await this.persistPolicy();
    }
    this.store.domains = { ...this.policy.domains, ...this.store.domains };
  }

  private startPolicyWatcher(): void {
    if (this.policyWatcher) return;
    try {
      this.policyWatcher = watch(this.policyFilePath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          void this.loadPolicy().catch((err) => {
            console.error("[HumanLikeMemory] Failed to reload policy:", err);
          });
        }, 200);
      });
    } catch {
      this.policyWatcher = null;
    }
  }

  /**
   * 关闭服务：释放文件监听 + 定时器，并等待挂起的持久化完成。
   *
   * 测试 helper（withMemoryService）在 finally 块中调用此方法做清理；
   * 未调用时 policyWatcher 会泄漏 FSWatcher，导致测试进程不退出。
   */
  async shutdown(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.policyWatcher) {
      try {
        this.policyWatcher.close();
      } catch {
        // ignore
      }
      this.policyWatcher = null;
    }
    // 等待挂起的持久化链完成，避免测试目录被 rm 时丢数据
    await this.persistChain;
  }

  private async persistPolicy(): Promise<void> {
    await mkdir(dirname(this.policyFilePath), { recursive: true });
    await writeFile(this.policyFilePath, `${JSON.stringify(this.policy, null, 2)}\n`, "utf8");
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(this.store, null, 2)}\n`, "utf8");
    });
  }

  private appendVersion(node: MemoryNodeRecord, summary: string, confidence: number, importance: number): string {
    const versionId = this.createVersion(summary, node.currentVersionId, confidence, importance);
    node.versionIds.push(versionId);
    node.versionIds = node.versionIds.slice(-20);
    return versionId;
  }

  private createVersion(
    summary: string,
    previousVersionId: string | null,
    confidence: number,
    importance: number,
  ): string {
    const versionId = `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.store.versions[versionId] = {
      versionId,
      previousVersionId,
      summary,
      createdAt: nowIso(),
      confidence,
      importance,
      correctness: "unknown",
    };
    return versionId;
  }

  private inferSourceType(source: string): MemoryNodeRecord["sourceType"] {
    if (source.startsWith("tool:")) return "tool";
    if (source.includes("digest")) return "digest";
    if (source.startsWith("world:")) return "world";
    if (source.startsWith("system:")) return "system";
    return "chat";
  }

  private computeImportance(text: string, source: string, metadata?: Record<string, unknown>): number {
    let score = 0.4;
    if (/重要|必须|务必|提醒|风险|警告|记住|偏好|生日|禁忌|流程|SOP/i.test(`${text} ${source}`)) score += 0.35;
    if (metadata?.highSignal === true) score += 0.2;
    return clamp(score, 0.1, 1);
  }

  private computeConfidence(text: string, metadata?: Record<string, unknown>): number {
    let score = 0.55;
    if (metadata?.highSignal === true) score += 0.15;
    if (/大概|可能|也许|不确定/.test(text)) score -= 0.18;
    if (/已经|确定|必须|务必/.test(text)) score += 0.1;
    return clamp(score, 0.1, 1);
  }

  private rebuildLinksForNode(node: MemoryNodeRecord): void {
    const candidates = Object.values(this.store.nodes)
      .filter((item) => item.id !== node.id && item.actorId === node.actorId && item.deletionStage !== "hard_deleted")
      .slice(-200);

    for (const candidate of candidates) {
      const relationScore = computeSimilarity(node, candidate);
      const sameDomainThreshold = 0.24;
      const crossDomainThreshold = 0.36;
      const finalWeight =
        node.domainId === candidate.domainId
          ? relationScore.score
          : clamp(relationScore.score * ((this.policy.domains[node.domainId]?.recallWeight ?? 1) + (this.policy.domains[candidate.domainId]?.recallWeight ?? 1)) / 2, 0, 1);
      const threshold = node.domainId === candidate.domainId ? sameDomainThreshold : crossDomainThreshold;
      if (finalWeight < threshold) continue;

      const edgeId = [node.actorId, ...[node.id, candidate.id].sort()].join(":");
      this.store.edges[edgeId] = {
        id: edgeId,
        actorId: node.actorId,
        from: node.id,
        to: candidate.id,
        relation: node.domainId === candidate.domainId ? "semantic" : "entity",
        weight: finalWeight,
        createdAt: this.store.edges[edgeId]?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        decayFactor: node.domainId === candidate.domainId ? 0.98 : 0.95,
        hopCost: node.domainId === candidate.domainId ? 1 : 1.4,
      };
    }
  }

  private rebuildCommunities(actorId: string, domainId: string): void {
    const nodes = Object.values(this.store.nodes).filter(
      (node) => node.actorId === actorId && node.domainId === domainId && node.deletionStage === "active",
    );
    const buckets = new Map<string, string[]>();
    for (const node of nodes) {
      const key = node.keywords.slice(0, 2).join("|") || "misc";
      const bucket = buckets.get(key) ?? [];
      bucket.push(node.id);
      buckets.set(key, bucket);
    }

    for (const [label, nodeIds] of buckets.entries()) {
      if (nodeIds.length < 3) continue;
      const id = `${actorId}:${domainId}:${label}`;
      this.store.communities[id] = {
        id,
        actorId,
        domainId,
        label,
        nodeIds,
        createdAt: this.store.communities[id]?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
    }
  }

  private resolveRecallMode(query: string, domainId: string, explicitCrossDomain: boolean): RecallMode {
    if (explicitCrossDomain) return "cross_domain";
    const tokens = extractKeywords(query);
    const domainHits = Object.values(this.store.nodes).filter(
      (node) => node.domainId === domainId && node.deletionStage === "active" && tokens.some((token) => node.keywords.includes(token)),
    ).length;
    const crossHits = Object.values(this.store.nodes).filter(
      (node) => node.domainId !== domainId && node.deletionStage === "active" && tokens.some((token) => node.keywords.includes(token)),
    ).length;
    return crossHits > 0 && domainHits / Math.max(crossHits, 1) < this.policy.retrieval.routeCrossDomainConfidenceThreshold
      ? "cross_domain"
      : "single_domain";
  }

  private hybridRetrieve(
    actorId: string,
    query: string,
    domainId: string,
    mode: RecallMode,
    context: MemoryContextKind | undefined,
    limit: number,
    queryVec: number[] | null = null,
  ): HybridRetrievalCandidate[] {
    const queryKeywords = extractKeywords(query);
    const queryEntities = extractEntityTags(query);
    const candidates = Object.values(this.store.nodes)
      .filter((node) => {
        if (node.actorId !== actorId) return false;
        if (node.deletionStage === "hard_deleted" || node.deletionStage === "soft_deleted") return false;
        const policy = this.policy.domains[node.domainId];
        if (!policy || !policy.enabled || policy.retired) return false;
        if (mode === "single_domain") return node.domainId === domainId;
        return node.domainId === domainId || !policy.retired;
      })
      .map((node) => {
        const structureScore =
          (node.domainId === domainId ? 0.34 : 0.08) +
          (context && node.context === context ? 0.08 : 0) +
          node.importance * 0.18 +
          node.confidence * 0.1 +
          node.frequencyScore * 0.06 +
          node.domainScore * 0.08 +
          node.userFeedbackScore * 0.08;
        const keywordScore =
          queryKeywords.filter((keyword) => node.keywords.includes(keyword)).length * 0.15 +
          queryEntities.filter((entity) => node.entityTags.includes(entity)).length * 0.12;
        // 方案 C：vectorScore 优先用真向量 cosine，无向量时降级到 cosineLikeScore
        let vectorScore: number;
        const nodeVec = parseVectorFingerprint(node.vectorFingerprint);
        if (queryVec && nodeVec) {
          // 新路径：真向量 cosine 相似度（0-1）
          vectorScore = Math.max(0, cosineSimilarity(queryVec, nodeVec)) * 0.26;
        } else {
          // 降级路径：旧节点无真向量或无 query 向量，用关键词集合 cosine
          vectorScore = cosineLikeScore(queryKeywords, node.keywords) * 0.26;
        }
        // W2 新增：inactivityPenalty — 长期未命中的节点在召回排序时降权
        // 与人类记忆"经常提起就记忆犹新，不提起就逐渐淡忘"机制一致
        // 使用 lastAccessedAt 计算距今天数，配合 forgettingFactor 域差异化
        // confirmed 节点不衰减（agent 对有用记忆是牢固的，不像人类会想不起）
        const policy = this.policy.domains[node.domainId];
        const forgettingFactor = policy?.forgettingFactor ?? 1.0;
        const lastAccessedTs = node.lastAccessedAt ? Date.parse(node.lastAccessedAt) : Date.parse(node.timestamp);
        const daysSinceAccess = Math.max(0, (Date.now() - lastAccessedTs) / 86_400_000);
        // 衰减曲线：7 天内无惩罚，7-30 天线性增长到 0.3，30 天以上封顶 0.3
        const inactivityPenalty =
          node.correctness === "confirmed"
            ? 0 // confirmed 节点不衰减（agent 对有用记忆是牢固的）
            : daysSinceAccess <= 7
              ? 0
              : Math.min(0.3, (daysSinceAccess - 7) * 0.015 * forgettingFactor);
        // confirmed 节点召回 boost：确保流程回复能稳定记住重要记忆
        // 设计意图：用户澄清"agent 对有用记忆是牢固的"指的是
        //   agent 在对话/流程回复中能够稳定召回这些记忆，而不是"想不起"
        //   通过 finalScore 加分让 confirmed 节点在排序中优先被选中
        const confirmedBoost = node.correctness === "confirmed" ? 0.25 : 0;
        const finalScore =
          structureScore +
          keywordScore +
          vectorScore +
          confirmedBoost - // confirmed 节点召回优先（流程回复能稳定记住）
          inactivityPenalty - // W2 新增：未命中惩罚
          (node.correctness === "rejected" ? 0.6 : 0) -
          (node.correctness === "suspected_error" ? 0.25 : 0) -
          (node.deletionStage === "cold" ? 0.18 : 0) -
          (node.userFeedbackScore < 0.5 ? this.policy.retrieval.userNegativeFeedbackPenalty : 0);
        return { node, structureScore, keywordScore, vectorScore, finalScore };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    if (mode === "cross_domain") {
      return this.expandByHops(actorId, candidates.slice(0, limit), domainId);
    }
    return candidates.slice(0, limit * 3);
  }

  private expandByHops(
    actorId: string,
    seeds: HybridRetrievalCandidate[],
    domainId: string,
  ): HybridRetrievalCandidate[] {
    const results = [...seeds];
    const seen = new Set(seeds.map((seed) => seed.node.id));
    let frontier = seeds.map((seed) => seed.node.id);
    const maxHops = this.policy.retrieval.maxHopCount;

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const outgoing = Object.values(this.store.edges)
          .filter((edge) => edge.actorId === actorId && (edge.from === current || edge.to === current))
          .sort((a, b) => b.weight - a.weight)
          .slice(0, this.policy.retrieval.maxCrossDomainItems);

        for (const edge of outgoing) {
          const neighborId = edge.from === current ? edge.to : edge.from;
          if (seen.has(neighborId)) continue;
          const node = this.store.nodes[neighborId];
          if (!node || node.deletionStage === "hard_deleted" || node.deletionStage === "soft_deleted") continue;
          seen.add(neighborId);
          nextFrontier.push(neighborId);
          results.push({
            node,
            structureScore: edge.weight * 0.2 + (node.domainId === domainId ? 0.12 : 0.06),
            keywordScore: 0,
            vectorScore: edge.weight * 0.12,
            finalScore: node.importance * 0.15 + node.confidence * 0.1 + edge.weight / hop,
          });
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
    return results.sort((a, b) => b.finalScore - a.finalScore);
  }

  private applyDiversityControl(
    candidates: HybridRetrievalCandidate[],
    limit: number,
    crossDomain: boolean,
  ): HybridRetrievalCandidate[] {
    const selected: HybridRetrievalCandidate[] = [];
    const usedDomains = new Map<string, number>();
    const usedKinds = new Map<MemoryNodeKind, number>();

    for (const candidate of candidates) {
      const domainPenalty = (usedDomains.get(candidate.node.domainId) ?? 0) * this.policy.retrieval.diversityPenalty;
      const kindPenalty = (usedKinds.get(candidate.node.kind) ?? 0) * this.policy.retrieval.diversityPenalty;
      if (candidate.finalScore - domainPenalty - kindPenalty < 0.18) continue;
      selected.push(candidate);
      usedDomains.set(candidate.node.domainId, (usedDomains.get(candidate.node.domainId) ?? 0) + 1);
      usedKinds.set(candidate.node.kind, (usedKinds.get(candidate.node.kind) ?? 0) + 1);
      if (selected.length >= limit) break;
      if (!crossDomain && selected.length >= limit) break;
    }

    return selected;
  }

  private reconstructRecall(
    query: string,
    domainId: string,
    nodes: MemoryNodeRecord[],
    mode: RecallMode,
    detailLevel: RecallDetailLevel,
    confidence: number,
  ): string {
    const header = `记忆重构结果 | 域=${domainId} | 模式=${mode} | 置信度=${confidence}`;
    const facts = nodes.map((node, index) => {
      const base = `${index + 1}. [${node.domainId}/${node.kind}] ${node.summary}`;
      if (detailLevel === "summary") return base;
      if (detailLevel === "detail") {
        return `${base} | 重要性=${node.importance.toFixed(2)} | 置信度=${node.confidence.toFixed(2)} | 访问=${node.accessCount}`;
      }
      return `${base} | 来源=${node.source} | 版本=${node.versionIds.length} | 最后访问=${node.lastAccessedAt}`;
    });
    return [
      header,
      `当前任务: ${query.slice(0, 120)}`,
      "以下内容为按当前任务裁剪后的柔性回忆，不是原始对话回放。",
      ...facts,
    ].join("\n");
  }

  private async runSleepCycle(actorId: string): Promise<HumanLikeMemorySleepReport> {
    const nodes = Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId && node.deletionStage !== "hard_deleted")
      .slice(0, this.policy.sleepAgent.maxNodesPerRun);

    const report: HumanLikeMemorySleepReport = {
      actorId,
      dailyCleanupCount: 0,
      weeklyMergedCount: 0,
      monthlyAbstractedCount: 0,
      consistencyFlagCount: 0,
      knowledgePromotedCount: 0,
      compressionRate: 0,
      estimatedRecallPrecision: 0,
      plannedActions: 0,
      executedActions: 0,
      stageReports: [],
    };
    if (!this.policy.sleepAgent.enabled || nodes.length === 0) return report;

    const actions: SleepAction[] = [];
    const now = Date.now();

    for (const node of nodes) {
      const policy = this.policy.domains[node.domainId];
      if (!policy) continue;
      // W1 修复：原 ageDays 基于 node.timestamp（创建时间），5 年前创建但昨天刚被召回的节点
      // 仍会按 5 年年龄判定 cold_storage —— 这是 bug。
      // 新策略：区分 ageSinceCreated 和 ageSinceAccessed，cold/soft_delete 判定用 ageSinceAccessed
      const ageSinceCreatedDays = Math.max(0, (now - Date.parse(node.timestamp)) / 86_400_000);
      const lastAccessedTs = node.lastAccessedAt ? Date.parse(node.lastAccessedAt) : Date.parse(node.timestamp);
      const ageSinceAccessedDays = Math.max(0, (now - lastAccessedTs) / 86_400_000);

      // W1 新增：长期未命中 → 连续衰减权重（decay_weight）
      // 原策略：frequencyScore / domainScore 只增不减（召回+0.06，ingest+0.12），
      //         只有 accessCount===0 时一次性 downrank，没有连续衰减
      // 新策略：距上次访问超过阈值（默认 7 天）的节点，每次 sleep cycle 衰减 frequencyScore
      //         使用 policy.forgettingFactor 调节衰减强度（0.6-1.6，域差异化）
      //         但已确认（confirmed）的高价值节点不衰减（agent 对有用记忆是牢固的）
      const INACTIVITY_DECAY_THRESHOLD_DAYS = 7;
      const INACTIVITY_DECAY_DELTA = 0.02; // 每次衰减 0.02（约 50 次 sleep cycle 后降到 0）
      if (
        ageSinceAccessedDays > INACTIVITY_DECAY_THRESHOLD_DAYS &&
        node.deletionStage === "active" &&
        node.correctness !== "confirmed" &&
        node.frequencyScore > 0.1 // 下限保护，避免衰减到 0
      ) {
        const decayDelta = INACTIVITY_DECAY_DELTA * (policy.forgettingFactor ?? 1.0);
        actions.push({
          type: "decay_weight",
          nodeId: node.id,
          stage: "daily_cleanup",
          reason: `inactivity_${ageSinceAccessedDays.toFixed(0)}d`,
          delta: decayDelta,
        });
      }

      // W1 修复：cold/soft_delete/hard_delete 判定改用 ageSinceAccessedDays
      if (ageSinceAccessedDays > policy.coldStorageAfterDays && node.deletionStage === "active" && node.accessCount <= 1) {
        actions.push({ type: "cold", nodeId: node.id, stage: "daily_cleanup", reason: "cold_storage_threshold" });
      }
      if (ageSinceAccessedDays > policy.softDeleteAfterDays && node.deletionStage === "cold" && node.correctness !== "confirmed") {
        actions.push({ type: "soft_delete", nodeId: node.id, stage: "daily_cleanup", reason: "soft_delete_threshold" });
      }
      // hard_delete 仍用 ageSinceCreatedDays（节点存在时间够久才能彻底删除）
      if (ageSinceCreatedDays > policy.hardDeleteAfterDays && node.deletionStage === "soft_deleted") {
        actions.push({ type: "hard_delete", nodeId: node.id, stage: "daily_cleanup", reason: "hard_delete_threshold" });
      }
      if (node.correctness === "suspected_error") {
        actions.push({ type: "mark_error", nodeId: node.id, stage: "consistency_audit", reason: "suspected_error" });
      }
      if (node.accessCount === 0 && node.deletionStage === "active") {
        actions.push({ type: "downrank", nodeId: node.id, stage: "daily_cleanup", reason: "unused_memory" });
      }
    }

    const groupedByFingerprint = new Map<string, MemoryNodeRecord[]>();
    for (const node of nodes) {
      const key = `${node.domainId}:${node.semanticFingerprint}`;
      const bucket = groupedByFingerprint.get(key) ?? [];
      bucket.push(node);
      groupedByFingerprint.set(key, bucket);
    }
    for (const bucket of groupedByFingerprint.values()) {
      if (bucket.length >= 2) {
        actions.push({
          type: "merge",
          nodeIds: bucket.map((node) => node.id),
          stage: "weekly_merge",
          reason: "duplicate_or_fragment_cluster",
        });
      }
    }

    const communityGroups = Object.values(this.store.communities).filter((community) => community.actorId === actorId);
    for (const community of communityGroups) {
      if (community.nodeIds.length >= 3) {
        const summaries = community.nodeIds.map((id) => this.store.nodes[id]?.summary).filter((value): value is string => Boolean(value));
        const experience = await llmExtractExperience(summaries);
        if (experience) {
          actions.push({
            type: "promote_knowledge",
            nodeIds: community.nodeIds.slice(0, 5),
            stage: "promote_knowledge",
            reason: `community:${community.label}`,
            summary: experience,
          });
        }
      }
    }

    const llmActions = await llmPlanSleepActions(actorId, nodes, this.policy);
    if (llmActions) actions.push(...llmActions);

    report.plannedActions = Math.min(actions.length, this.policy.sleepAgent.maxActionsPerRun);
    const beforeActive = nodes.filter((node) => node.deletionStage === "active").length;

    for (const action of actions.slice(0, this.policy.sleepAgent.maxActionsPerRun)) {
      if (await this.executeSleepAction(action, report)) {
        report.executedActions += 1;
      }
    }

    const afterActive = Object.values(this.store.nodes).filter(
      (node) => node.actorId === actorId && node.deletionStage === "active",
    ).length;
    report.compressionRate = beforeActive > 0 ? Number(((beforeActive - afterActive) / beforeActive).toFixed(3)) : 0;
    report.estimatedRecallPrecision = Number(
      clamp(
        Object.values(this.store.nodes)
          .filter((node) => node.actorId === actorId)
          .reduce((sum, node) => sum + node.confidence * (node.correctness === "confirmed" ? 1.1 : node.correctness === "rejected" ? 0.2 : 1), 0) /
          Math.max(Object.values(this.store.nodes).filter((node) => node.actorId === actorId).length, 1),
        0,
        1,
      ).toFixed(3),
    );
    this.schedulePersist();
    return report;
  }

  private async executeSleepAction(action: SleepAction, report: HumanLikeMemorySleepReport): Promise<boolean> {
    if ("nodeId" in action) {
      const node = this.store.nodes[action.nodeId];
      if (!node) return false;
      if (action.type === "downrank") {
        node.domainScore = clamp(node.domainScore - 0.12, 0.1, 3);
        node.deletionStage = "downranked";
        report.dailyCleanupCount += 1;
      } else if (action.type === "decay_weight") {
        // W1 新增：连续衰减权重（长期未命中）
        // 不改变 deletionStage，只调整 frequencyScore / recencyScore / domainScore
        // 下限保护：frequencyScore 不低于 0.1（保留召回可能性，不彻底丢失）
        const delta = action.delta;
        node.frequencyScore = clamp(node.frequencyScore - delta, 0.1, 5);
        // recencyScore 从 1 衰减为连续值：未访问越久衰减越多
        const daysSinceAccess = Math.max(0, (Date.now() - Date.parse(node.lastAccessedAt || node.timestamp)) / 86_400_000);
        node.recencyScore = clamp(Math.exp(-daysSinceAccess / 7), 0, 1);
        // domainScore 轻微衰减（不影响 deletionStage）
        node.domainScore = clamp(node.domainScore - delta * 0.3, 0.1, 3);
        report.dailyCleanupCount += 1;
      } else if (action.type === "cold") {
        node.deletionStage = "cold";
        node.isArchived = true;
        report.dailyCleanupCount += 1;
      } else if (action.type === "soft_delete") {
        node.deletionStage = "soft_deleted";
        report.dailyCleanupCount += 1;
      } else if (action.type === "hard_delete") {
        node.deletionStage = "hard_deleted";
        report.dailyCleanupCount += 1;
      } else if (action.type === "mark_error") {
        node.correctness = "suspected_error";
        report.consistencyFlagCount += 1;
      }
      this.bumpStageReport(report, action.stage, action.reason);
      return true;
    }

    if (action.type === "mark_conflict") {
      if (action.nodeIds.length < 2) return false;
      const conflictId = `conflict_${Date.now().toString(36)}`;
      for (const nodeId of action.nodeIds) {
        const node = this.store.nodes[nodeId];
        if (!node) continue;
        node.conflictGroupId = conflictId;
        node.correctness = "suspected_error";
      }
      report.consistencyFlagCount += action.nodeIds.length;
      this.bumpStageReport(report, action.stage, action.reason);
      return true;
    }

    const bucket = action.nodeIds
      .map((id) => this.store.nodes[id])
      .filter((node): node is MemoryNodeRecord => Boolean(node) && node.deletionStage !== "hard_deleted");
    if (bucket.length < 2) return false;

    if (action.type === "merge") {
      const merged = action.summary ? [action.summary] : await llmMergeLines(bucket.map((node) => node.summary));
      const fallback = dedupeMemoryLines(bucket.map((node) => node.summary), { preferLatest: true }).slice(-1);
      const mergedLines = merged && merged.length > 0 ? merged : fallback;
      const keeper = bucket.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence)[0]!;
      const versionId = this.appendVersion(keeper, mergedLines.join("；"), keeper.confidence, keeper.importance);
      keeper.summary = mergedLines.join("；");
      keeper.currentVersionId = versionId;
      keeper.kind = keeper.kind === "event" ? "knowledge" : keeper.kind;
      keeper.keywords = uniqueStrings([...keeper.keywords, ...extractKeywords(keeper.summary)], 14);
      for (const redundant of bucket.slice(1)) {
        redundant.deletionStage = "cold";
        redundant.isArchived = true;
      }
      report.weeklyMergedCount += bucket.length - 1;
      this.bumpStageReport(report, action.stage, action.reason);
      return true;
    }

    const nodeSummary = action.summary;
    const targetActor = bucket[0]!.actorId;
    const sourceNode = bucket[0]!;
    await this.ingest(targetActor, nodeSummary, "system:knowledge_promotion", {
      context: "main",
      domain: sourceNode.domainId === "temporary" ? "general" : sourceNode.domainId,
      metadata: { highSignal: true, promotedFromNodeIds: action.nodeIds, procedural: sourceNode.kind === "procedure" },
    });
    report.knowledgePromotedCount += 1;
    report.monthlyAbstractedCount += 1;
    this.bumpStageReport(report, action.stage, action.reason);
    return true;
  }

  private bumpStageReport(
    report: HumanLikeMemorySleepReport,
    stage: SleepAgentStage,
    note: string,
  ): void {
    const existing = report.stageReports.find((item) => item.stage === stage);
    if (existing) {
      existing.changed += 1;
      if (existing.notes.length < 6) existing.notes.push(note);
      return;
    }
    report.stageReports.push({ stage, changed: 1, notes: [note] });
  }

  private recordWriteLatency(start: number): void {
    this.telemetry.writes += 1;
    this.telemetry.writeLatencyMs.push(Date.now() - start);
    this.telemetry.writeLatencyMs = this.telemetry.writeLatencyMs.slice(-200);
  }

  private recordRecallLatency(start: number): void {
    this.telemetry.recallLatencyMs.push(Date.now() - start);
    this.telemetry.recallLatencyMs = this.telemetry.recallLatencyMs.slice(-200);
  }
}

let singleton: HumanLikeMemoryService | null = null;

export function getHumanLikeMemoryService(): HumanLikeMemoryService | null {
  return singleton;
}

export async function initHumanLikeMemoryService(): Promise<HumanLikeMemoryService> {
  if (singleton) return singleton;
  const service = new HumanLikeMemoryService();
  await service.load();
  singleton = service;
  return service;
}
