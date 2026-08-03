// Agent Brain Center — BrainStemAutoInferer（无意识触发 / 自动推理）
//
// 职责：在 BrainStem 45s 心跳里自动跑推理，不等人显式调用。
//   模拟人脑"无意识推理"——后台自动整合记忆，产生直觉。
//
// 核心原则：
//   1. 无意识：推理结果只存入缓存，不主动发消息给用户
//   2. 限频：每 N 次心跳才跑一次（默认 2 次，即 90s），避免过频
//   3. 容错：失败只记日志，不影响 BrainStem 节律
//   4. 不调 LLM：推理委托 MemoryInferenceEngine.inferFromClues（纯算法）
//
// 集成方式：
//   - BrainStem 已有 onHeartbeat(callback) 回调机制
//   - 装配阶段：brainStem.onHeartbeat(() => { for (actorId of knownActors) autoInferer.onHeartbeat(actorId) })
//   - 每次 onHeartbeat 检查计数器，达到 interval 才真正跑推理
//
// 详见 task: 4 项仿人推理能力新增

import type { InferenceClue } from "../types.js";
import type {
  HumanLikeMemoryInferenceLike,
  MemoryInferenceEngine,
} from "./memory-inference-engine.js";

// ============================================================
// 常量
// ============================================================

/** 默认心跳间隔：每 2 次心跳跑一次（避免 45s 一次太频繁） */
const DEFAULT_INTERVAL = 2;
/** 从最近记忆中取多少条作为线索 */
const MAX_CLUES_PER_ACTOR = 3;

// ============================================================
// BrainStemAutoInferer 主类
// ============================================================

/**
 * 无意识自动推理器：BrainStem 心跳触发后台推理。
 *
 * 每次心跳从 humanLike 取该 actor 最近的 N 条记忆作为线索，
 * 调用 inferenceEngine.inferFromClues 进行推理。
 * 推理结果存入 inferenceEngine 缓存（不主动通知用户，无意识！）。
 *
 * 限频：每 interval 次心跳才跑一次（默认 2 次 = 90s）。
 */
export class BrainStemAutoInferer {
  private readonly inferenceEngine: MemoryInferenceEngine;
  private readonly humanLike: HumanLikeMemoryInferenceLike;
  private readonly interval: number;
  /** actor → 心跳计数器（用于限频） */
  private readonly heartbeatCounters = new Map<string, number>();
  /** 统计：累计自动推理触发次数 */
  private totalAutoInferences = 0;
  /** 统计：累计跳过次数（未到 interval） */
  private totalSkipped = 0;

  constructor(opts: {
    inferenceEngine: MemoryInferenceEngine;
    humanLike: HumanLikeMemoryInferenceLike;
    interval?: number;
  }) {
    this.inferenceEngine = opts.inferenceEngine;
    this.humanLike = opts.humanLike;
    this.interval = opts.interval ?? DEFAULT_INTERVAL;
  }

  /**
   * 心跳回调（注册到 BrainStem.onHeartbeat）。
   *
   * 每次心跳递增该 actor 的计数器，达到 interval 时才真正跑推理。
   * 推理失败只记日志，不抛异常（不影响 BrainStem 节律）。
   *
   * @param actorId 当前 actor
   */
  async onHeartbeat(actorId: string): Promise<void> {
    // 限频：每 interval 次心跳才跑一次
    const counter = (this.heartbeatCounters.get(actorId) ?? 0) + 1;
    this.heartbeatCounters.set(actorId, counter);

    if (counter < this.interval) {
      this.totalSkipped++;
      return;
    }

    // 达到 interval，重置计数器
    this.heartbeatCounters.set(actorId, 0);

    try {
      const clues = this.extractClues(actorId);
      if (clues.length < 2) return; // 线索不足 2 条，不推理

      // 调用推理引擎（结果自动存入 inferenceEngine 缓存）
      const result = await this.inferenceEngine.inferFromClues(actorId, clues);
      this.totalAutoInferences++;

      if (result.inferences.length > 0) {
        console.log(
          `[BrainStemAutoInferer] 无意识推理触发 actor=${actorId}：` +
            `生成 ${result.inferences.length} 条结论（缓存已更新，不通知用户）`,
        );
      }
    } catch (err) {
      // 容错：失败只记日志，不影响 BrainStem 节律
      console.error(`[BrainStemAutoInferer] 自动推理失败 actor=${actorId}:`, err);
    }
  }

  /**
   * 获取某 actor 的记忆线索（基于情感显著性筛选，而非简单最近 N 条）。
   *
   * 改进点（v2）：
   *   1. 不再只取"最近 N 条"——人脑无意识推理会被"情感显著"的记忆吸引
   *   2. 显著性评分 = confidence * 0.5 + recencyScore * 0.3 + frequencyScore * 0.2
   *      - confidence：记忆本身的置信度（高置信 = 显著）
   *      - recencyScore：最近访问过的记忆更显著（衰减函数）
   *      - frequencyScore：频繁访问的记忆更显著（frequencyScore 字段）
   *   3. 取显著性 Top-N 作为线索
   *   4. 兜底：若所有节点都没 confidence/frequencyScore 字段，退化为按时间排序
   *
   * 这样无意识推理更接近人类：会被印象深刻的事吸引，而不是机械的"最近发生的"。
   */
  private extractClues(actorId: string): InferenceClue[] {
    const nodes = this.humanLike.getAllNodes(actorId);
    if (nodes.length === 0) return [];

    // 计算每个节点的显著性评分
    const now = Date.now();
    const scored = nodes.map(node => {
      const confidence = (node as { confidence?: number }).confidence ?? 0.5;
      const lastAccessedAt = (node as { lastAccessedAt?: string }).lastAccessedAt;
      const frequencyScore = (node as { frequencyScore?: number }).frequencyScore ?? 0;
      // 时间衰减：7 天前 → 0.1，1 天前 → 0.7，刚刚 → 1.0
      const recencyScore = lastAccessedAt
        ? Math.max(0.1, 1 - Math.min(1, (now - new Date(lastAccessedAt).getTime()) / (7 * 24 * 3600 * 1000)))
        : 0.3;
      const salience = confidence * 0.5 + recencyScore * 0.3 + Math.min(1, frequencyScore / 3) * 0.2;
      return { node, salience };
    });

    // 按显著性降序，取 Top-N
    scored.sort((a, b) => b.salience - a.salience);
    const top = scored.slice(0, MAX_CLUES_PER_ACTOR);

    const clues: InferenceClue[] = [];
    for (const { node, salience } of top) {
      const text = node.summary?.trim();
      if (!text) continue;
      clues.push({
        text,
        source: "memory_recalled",
        // 显著性高的线索权重更高（影响推理置信度）
        weight: Math.max(0.5, Math.min(1.0, salience)),
      });
    }
    return clues;
  }

  /** 获取统计信息（debug 用） */
  getStats(): {
    totalAutoInferences: number;
    totalSkipped: number;
    trackedActors: number;
  } {
    return {
      totalAutoInferences: this.totalAutoInferences,
      totalSkipped: this.totalSkipped,
      trackedActors: this.heartbeatCounters.size,
    };
  }
}
