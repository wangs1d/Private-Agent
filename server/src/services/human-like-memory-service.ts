import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import OpenAI from "openai";

import { dedupeMemoryLines, normalizeMemoryLine, semanticFingerprint } from "./memory-record-utils.js";

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
  | "promote_knowledge";

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

type SleepAction =
  | { type: "downrank"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "cold"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "soft_delete"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "hard_delete"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "merge"; nodeIds: string[]; stage: SleepAgentStage; reason: string; summary?: string }
  | { type: "promote_knowledge"; nodeIds: string[]; stage: SleepAgentStage; reason: string; summary: string }
  | { type: "mark_error"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "mark_conflict"; nodeIds: string[]; stage: SleepAgentStage; reason: string };

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
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || lines.length < 2) return null;

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_SLEEP_AGENT_MODEL?.trim() || "gpt-4.1-mini",
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
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || lines.length < 3) return null;

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_SLEEP_AGENT_MODEL?.trim() || "gpt-4.1-mini",
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
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || !policy.sleepAgent.llmPlannerEnabled || nodes.length === 0) return null;

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MEMORY_SLEEP_AGENT_MODEL?.trim() || "gpt-4.1-mini",
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
      existing.keywords = uniqueStrings([...existing.keywords, ...extractKeywords(summary)], 14);
      existing.entityTags = uniqueStrings([...existing.entityTags, ...extractEntityTags(summary)], 12);
      existing.sceneTags = uniqueStrings([...existing.sceneTags, ...inferSceneTags(source, context, domainId)], 8);
      existing.emotionTags = uniqueStrings([...existing.emotionTags, ...extractEmotionTags(summary)], 8);
      this.rebuildLinksForNode(existing);
      this.schedulePersist();
      this.recordWriteLatency(start);
      return;
    }

    const nodeId = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const versionId = this.createVersion(summary, null, confidence, importance);
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

    const candidates = this.hybridRetrieve(actorId, cleanedQuery, domainId, mode, opts?.context, limit);
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
        const vectorScore = cosineLikeScore(queryKeywords, node.keywords) * 0.26;
        const finalScore =
          structureScore +
          keywordScore +
          vectorScore -
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
      const ageDays = Math.max(0, (now - Date.parse(node.timestamp)) / 86_400_000);

      if (ageDays > policy.coldStorageAfterDays && node.deletionStage === "active" && node.accessCount <= 1) {
        actions.push({ type: "cold", nodeId: node.id, stage: "daily_cleanup", reason: "cold_storage_threshold" });
      }
      if (ageDays > policy.softDeleteAfterDays && node.deletionStage === "cold" && node.correctness !== "confirmed") {
        actions.push({ type: "soft_delete", nodeId: node.id, stage: "daily_cleanup", reason: "soft_delete_threshold" });
      }
      if (ageDays > policy.hardDeleteAfterDays && node.deletionStage === "soft_deleted") {
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
