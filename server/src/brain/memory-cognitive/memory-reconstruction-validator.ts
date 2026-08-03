// 记忆重构校验器：在记忆合并/抽象后校验重构准确性，防止信息丢失与扭曲。
// 不让 LLM 自评 —— 所有校验通过程序化计算（字段保留率 + embedding cosine 距离）。
// 详见 spec: .trae/specs/extend-memory-cognitive-architecture/spec.md

import type { MemoryProvenance, ReconstructionValidation } from "../types.js";

/**
 * HumanLikeMemoryService 的最小化外观接口。
 * HumanLikeMemoryService 当前没有 getNode / getVersion / markNodeCorrectness 方法
 * （部分有但签名可能不同），本模块只依赖外观接口，不修改 HumanLikeMemoryService。
 */
export interface HumanLikeMemoryReconstructionLike {
  /** 获取指定 actor 的节点 */
  getNode(actorId: string, nodeId: string): {
    id: string;
    summary: string;
    keywords: string[];
    entityTags: string[];
    sceneTags: string[];
    emotionTags: string[];
    source: string;
    sourceType: string;
    correctness: string;
    currentVersionId: string;
    versionIds: string[];
  } | null;
  /** 获取版本记录 */
  getVersion(actorId: string, versionId: string): {
    versionId: string;
    previousVersionId: string | null;
    summary: string;
    confidence: number;
    importance: number;
    correctness: string;
  } | null;
  /** 标记节点 correctness */
  markNodeCorrectness(actorId: string, nodeId: string, correctness: string): void;
}

/** Embedding 提供方接口（用于 distortion 计算） */
export interface EmbeddingProvider {
  /** 计算文本 embedding（用于 distortion 计算） */
  computeEmbedding(text: string): Promise<number[] | null>;
}

/** 重构校验输入节点视图（mergedNode / sourceNodes 共用） */
export interface NodeFieldView {
  id: string;
  summary: string;
  keywords: string[];
  entityTags: string[];
  sceneTags: string[];
  emotionTags: string[];
}

/** 来源链路条目（recordSourceChain 记录，getProvenanceChain 读取） */
export interface SourceChainEntry {
  versionId: string;
  sourceNodeIds: string[];
  sourceSummary: string;
}

/** 真向量 cosine 相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 读取数值环境变量，缺省返回 fallback */
function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 是否启用重构校验（缺省启用，BRAIN_MEMORY_RECONSTRUCTION_ENABLED=0 时关闭） */
function isReconstructionEnabled(): boolean {
  const raw = process.env.BRAIN_MEMORY_RECONSTRUCTION_ENABLED?.trim();
  return raw !== "0";
}

/** 把多组字符串数组合并为去重并集 */
function unionStrings(arrays: string[][]): string[] {
  const set = new Set<string>();
  for (const arr of arrays) {
    for (const item of arr) {
      if (item) set.add(item);
    }
  }
  return [...set];
}

/**
 * 计算单类字段的保留率：merged 中保留的 sourceUnion 项数 / sourceUnion 总数。
 * sourceUnion 为空时返回 1（无信息可丢，保留率满）。
 */
function fieldRetentionRate(merged: string[], sourceUnion: string[]): number {
  if (sourceUnion.length === 0) return 1;
  const mergedSet = new Set(merged.filter(Boolean));
  let overlap = 0;
  for (const item of sourceUnion) {
    if (mergedSet.has(item)) overlap += 1;
  }
  return overlap / sourceUnion.length;
}

/**
 * 记忆重构校验器。
 *
 * 在睡眠巩固 weekly_merge / monthly_abstract 产出新节点后，
 * 自动校验重构准确性（accuracy + distortion），失败时标记 suspected_error。
 * 所有校验通过程序化计算，不调 LLM 自评。
 */
export class MemoryReconstructionValidator {
  private readonly humanLike: HumanLikeMemoryReconstructionLike | null;
  private readonly embeddingProvider: EmbeddingProvider | null;
  /** 内部来源链路存储：Map<actorId, Map<nodeId, SourceChainEntry[]>> */
  private readonly sourceChainStore = new Map<string, Map<string, SourceChainEntry[]>>();

  constructor(
    humanLike: HumanLikeMemoryReconstructionLike | null = null,
    embeddingProvider: EmbeddingProvider | null = null,
  ) {
    this.humanLike = humanLike;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * 重构校验：计算 accuracy / lostInfo / distortion，失败时标记 suspected_error。
   * 不调 LLM。
   *
   * - accuracy：4 类字段（keywords/entityTags/sceneTags/emotionTags）保留率平均
   * - lostInfo：source 有但 merged 无的关键字段（keywords + entityTags）
   * - distortion：embedding cosine 距离，无 embedding 时降级到关键词 overlap
   * - isValid：accuracy >= 阈值 && distortion < 阈值
   * - !isValid 时调用 markNodeCorrectness 标记 suspected_error（保留原版本回退路径）
   */
  async validateReconstruction(
    actorId: string,
    mergedNode: NodeFieldView,
    sourceNodes: NodeFieldView[],
  ): Promise<ReconstructionValidation> {
    const now = new Date().toISOString();
    // 降级开关：关闭时返回默认有效结果（不标记错误）
    if (!isReconstructionEnabled()) {
      return {
        accuracy: 1,
        lostInfo: [],
        distortion: 0,
        isValid: true,
        validatedAt: now,
      };
    }

    // ---- accuracy: 4 类字段保留率平均 ----
    const sourceKeywords = unionStrings(sourceNodes.map((n) => n.keywords));
    const sourceEntityTags = unionStrings(sourceNodes.map((n) => n.entityTags));
    const sourceSceneTags = unionStrings(sourceNodes.map((n) => n.sceneTags));
    const sourceEmotionTags = unionStrings(sourceNodes.map((n) => n.emotionTags));

    const keywordRate = fieldRetentionRate(mergedNode.keywords, sourceKeywords);
    const entityRate = fieldRetentionRate(mergedNode.entityTags, sourceEntityTags);
    const sceneRate = fieldRetentionRate(mergedNode.sceneTags, sourceSceneTags);
    const emotionRate = fieldRetentionRate(mergedNode.emotionTags, sourceEmotionTags);
    const accuracy = (keywordRate + entityRate + sceneRate + emotionRate) / 4;

    // ---- lostInfo: source 有但 merged 无的关键字段（keywords + entityTags）----
    const lostInfo: string[] = [];
    const mergedKeywordSet = new Set(mergedNode.keywords.filter(Boolean));
    const mergedEntitySet = new Set(mergedNode.entityTags.filter(Boolean));
    for (const kw of sourceKeywords) {
      if (!mergedKeywordSet.has(kw)) lostInfo.push(`keyword:${kw}`);
    }
    for (const tag of sourceEntityTags) {
      if (!mergedEntitySet.has(tag)) lostInfo.push(`entity:${tag}`);
    }

    // ---- distortion: embedding cosine 距离，无 embedding 时降级到关键词 overlap ----
    const distortion = await this.computeDistortion(mergedNode, sourceNodes);

    // ---- isValid ----
    const accuracyThreshold = readEnvNumber(
      "BRAIN_MEMORY_RECONSTRUCTION_ACCURACY_THRESHOLD",
      0.7,
    );
    const distortionThreshold = readEnvNumber(
      "BRAIN_MEMORY_RECONSTRUCTION_DISTORTION_THRESHOLD",
      0.3,
    );
    const isValid = accuracy >= accuracyThreshold && distortion < distortionThreshold;

    // ---- 失败时标记 suspected_error（保留原版本回退路径）----
    if (!isValid && this.humanLike) {
      this.humanLike.markNodeCorrectness(actorId, mergedNode.id, "suspected_error");
    }

    return {
      accuracy: Number(accuracy.toFixed(4)),
      lostInfo,
      distortion: Number(distortion.toFixed(4)),
      isValid,
      validatedAt: now,
    };
  }

  /**
   * 来源链路追溯：从节点 currentVersionId 开始，沿 previousVersionId 链向上追溯。
   * 每个版本构造 MemoryProvenance，直到 previousVersionId 为 null 或达到最大深度。
   * 不调 LLM。
   */
  async getProvenanceChain(actorId: string, nodeId: string): Promise<MemoryProvenance[]> {
    if (!isReconstructionEnabled() || !this.humanLike) return [];

    const node = this.humanLike.getNode(actorId, nodeId);
    if (!node) return [];

    // 节点的来源链路（recordSourceChain 记录）
    const sourceChain = this.getSourceChain(actorId, nodeId);

    const maxDepth = readEnvNumber("BRAIN_MEMORY_RECONSTRUCTION_MAX_CHAIN_DEPTH", 10);
    const chain: MemoryProvenance[] = [];
    let currentVersionId: string | null = node.currentVersionId;
    const visited = new Set<string>(); // 防环

    while (currentVersionId && chain.length < maxDepth) {
      if (visited.has(currentVersionId)) break;
      visited.add(currentVersionId);

      const version = this.humanLike.getVersion(actorId, currentVersionId);
      if (!version) break;

      chain.push({
        source: node.source,
        sourceType: node.sourceType as MemoryProvenance["sourceType"],
        capturedAt: new Date().toISOString(),
        sourceChain: sourceChain.length > 0 ? sourceChain : undefined,
      });

      currentVersionId = version.previousVersionId;
    }

    return chain;
  }

  /**
   * 记录来源链路：构造 sourceChain 条目存入内部映射。
   * 内部维护 Map<actorId, Map<nodeId, SourceChainEntry[]>>。
   * 不调 LLM。
   */
  recordSourceChain(
    actorId: string,
    nodeId: string,
    sourceNodeIds: string[],
    sourceSummary: string,
  ): void {
    if (!isReconstructionEnabled()) return;

    // 获取节点当前 versionId（humanLike 为 null 时用空串占位）
    let versionId = "";
    if (this.humanLike) {
      const node = this.humanLike.getNode(actorId, nodeId);
      if (node) versionId = node.currentVersionId;
    }

    const entry: SourceChainEntry = {
      versionId,
      sourceNodeIds,
      sourceSummary,
    };

    const actorMap = this.sourceChainStore.get(actorId) ?? new Map();
    const list = actorMap.get(nodeId) ?? [];
    list.push(entry);
    actorMap.set(nodeId, list);
    this.sourceChainStore.set(actorId, actorMap);
  }

  /** 计算 distortion（embedding cosine 距离，无 embedding 时降级到关键词 overlap） */
  private async computeDistortion(
    mergedNode: NodeFieldView,
    sourceNodes: NodeFieldView[],
  ): Promise<number> {
    const sourceSummary = sourceNodes.map((n) => n.summary).join("；");
    const sourceKeywords = unionStrings(sourceNodes.map((n) => n.keywords));

    // 尝试 embedding 路径
    if (this.embeddingProvider) {
      const [mergedVec, sourceVec] = await Promise.all([
        this.embeddingProvider.computeEmbedding(mergedNode.summary),
        this.embeddingProvider.computeEmbedding(sourceSummary),
      ]);
      if (mergedVec && sourceVec) {
        return 1 - cosineSimilarity(mergedVec, sourceVec);
      }
    }

    // 降级路径：关键词 overlap 估算（distortion = 1 - overlap）
    if (sourceKeywords.length === 0) return 0;
    const mergedKeywordSet = new Set(mergedNode.keywords.filter(Boolean));
    let overlap = 0;
    for (const kw of sourceKeywords) {
      if (mergedKeywordSet.has(kw)) overlap += 1;
    }
    const overlapRate = overlap / sourceKeywords.length;
    return 1 - overlapRate;
  }

  /** 读取节点已记录的来源链路 */
  private getSourceChain(actorId: string, nodeId: string): SourceChainEntry[] {
    return this.sourceChainStore.get(actorId)?.get(nodeId) ?? [];
  }
}
