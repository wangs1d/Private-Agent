// Agent Brain Center — 世界模型转移样本持久化层
//
// 职责：存储 (state_before, action, state_after) 三元组转移样本，
// 供世界模型在线学习（update 时记录 prediction error）和离线训练使用。
//
// 设计要点：
//   1. 内存缓冲区 + 可选 JSONL 文件持久化（双写，文件是可选的灾备）
//   2. 自动清理：内存保留最近 N 条（默认 5000），文件按天轮转
//   3. 不调 LLM，纯数据存储，零延迟
//   4. BRAIN_WORLD_MODEL_ENABLED=0 时不实例化，零开销
//   5. 查询接口支持 actorId / tool / 时间范围过滤
//
// 与 WorldModel.update 的关系：
//   - WorldModel.update(state, action, nextState) 计算 prediction error
//   - 调 TransitionStore.record(sample) 持久化样本
//   - 未来神经网络世界模型从 TransitionStore 批量拉样本做离线训练

import type { TransitionSample, WorldState, WorldAction } from "./world-model-types.js";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * 转移样本查询选项。
 */
export interface TransitionQueryOpts {
  actorId?: string;
  /** 按工具名过滤（前缀匹配） */
  toolPrefix?: string;
  /** 起始时间（ISO8601） */
  since?: string;
  /** 截止时间（ISO8601） */
  until?: string;
  /** 最大返回条数 */
  limit?: number;
}

/**
 * 转移样本统计信息。
 */
export interface TransitionStoreStats {
  /** 总样本数（内存） */
  totalCount: number;
  /** 各工具的样本数 */
  toolCounts: Record<string, number>;
  /** 平均预测误差 */
  averageError: number;
  /** 最近一次记录时间 */
  lastRecordAt: string | null;
}

/**
 * 世界模型转移样本持久化存储。
 *
 * 内存缓冲区 + 可选 JSONL 文件持久化。
 * 内存保留最近 maxInMemory 条（默认 5000），超出时 FIFO 淘汰。
 * 文件持久化路径由 BRAIN_WORLD_MODEL_TRANSITION_DIR 环境变量控制（不设则不写文件）。
 */
export class WorldModelTransitionStore {
  private samples: TransitionSample[] = [];
  private readonly maxInMemory: number;
  private readonly fileDir: string | null;
  private readonly fileDate: string; // YYYY-MM-DD，用于按天轮转
  private toolCounts: Record<string, number> = {};
  private totalError = 0;
  private errorCount = 0;
  private lastRecordAt: string | null = null;

  constructor(opts?: {
    maxInMemory?: number;
    fileDir?: string | null;
  }) {
    this.maxInMemory = opts?.maxInMemory ?? 5000;
    const envDir = process.env.BRAIN_WORLD_MODEL_TRANSITION_DIR;
    this.fileDir = opts?.fileDir ?? (envDir && envDir.trim().length > 0 ? envDir.trim() : null);
    this.fileDate = new Date().toISOString().slice(0, 10);
  }

  /**
   * 记录一条转移样本。
   *
   * @param stateBefore 动作前状态
   * @param action 执行的动作
   * @param stateAfter 动作后状态
   * @param predictionError 预测误差（可选，由 WorldModel.update 计算）
   * @param success 动作是否成功
   * @param actorId 关联的 actor id
   */
  record(
    stateBefore: WorldState,
    action: WorldAction,
    stateAfter: WorldState,
    opts?: {
      predictionError?: number;
      success?: boolean;
      actorId?: string;
    },
  ): TransitionSample {
    const sample: TransitionSample = {
      id: `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stateBefore,
      action,
      stateAfter,
      predictionError: opts?.predictionError,
      success: opts?.success,
      timestamp: new Date().toISOString(),
      actorId: opts?.actorId,
    };

    // 写入内存缓冲区
    this.samples.push(sample);
    if (this.samples.length > this.maxInMemory) {
      this.samples.shift(); // FIFO 淘汰
    }

    // 更新统计
    const toolKey = action.tool;
    this.toolCounts[toolKey] = (this.toolCounts[toolKey] ?? 0) + 1;
    if (typeof opts?.predictionError === "number") {
      this.totalError += opts.predictionError;
      this.errorCount++;
    }
    this.lastRecordAt = sample.timestamp;

    // 可选：写入 JSONL 文件
    if (this.fileDir) {
      this.persistToFile(sample);
    }

    return sample;
  }

  /**
   * 查询转移样本。
   */
  query(opts?: TransitionQueryOpts): TransitionSample[] {
    let result = [...this.samples];

    if (opts?.actorId) {
      result = result.filter((s) => s.actorId === opts.actorId);
    }
    if (opts?.toolPrefix) {
      const prefix = opts.toolPrefix.toLowerCase();
      result = result.filter((s) => s.action.tool.toLowerCase().startsWith(prefix));
    }
    if (opts?.since) {
      result = result.filter((s) => s.timestamp >= opts.since!);
    }
    if (opts?.until) {
      result = result.filter((s) => s.timestamp <= opts.until!);
    }

    // 按时间倒序（最近在前）
    result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (opts?.limit && opts.limit > 0) {
      result = result.slice(0, opts.limit);
    }

    return result;
  }

  /**
   * 获取某 actor 最近的 N 条样本。
   */
  getRecent(actorId: string, limit = 10): TransitionSample[] {
    return this.query({ actorId, limit });
  }

  /**
   * 获取统计信息。
   */
  getStats(): TransitionStoreStats {
    return {
      totalCount: this.samples.length,
      toolCounts: { ...this.toolCounts },
      averageError: this.errorCount > 0 ? this.totalError / this.errorCount : 0,
      lastRecordAt: this.lastRecordAt,
    };
  }

  /**
   * 从 JSONL 文件加载历史样本（启动时可选调用）。
   * 只加载当天文件，避免内存爆炸。
   */
  loadFromFile(): number {
    if (!this.fileDir) return 0;
    const filePath = this.getFilePath();
    if (!existsSync(filePath)) return 0;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      let count = 0;
      for (const line of lines) {
        try {
          const sample = JSON.parse(line) as TransitionSample;
          this.samples.push(sample);
          count++;
        } catch {
          // 跳过损坏行
        }
      }
      // 截断到 maxInMemory
      if (this.samples.length > this.maxInMemory) {
        this.samples = this.samples.slice(-this.maxInMemory);
      }
      console.log(`[TransitionStore] 从文件加载 ${count} 条样本`);
      return count;
    } catch (e) {
      console.log(`[TransitionStore] 加载文件失败: ${e}`);
      return 0;
    }
  }

  /** 清空内存缓冲区（文件不受影响） */
  clear(): void {
    this.samples = [];
    this.toolCounts = {};
    this.totalError = 0;
    this.errorCount = 0;
    this.lastRecordAt = null;
  }

  // ---- 内部方法 ----

  private getFilePath(): string {
    return join(this.fileDir!, `transitions-${this.fileDate}.jsonl`);
  }

  private persistToFile(sample: TransitionSample): void {
    try {
      const filePath = this.getFilePath();
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(filePath, JSON.stringify(sample) + "\n", "utf-8");
    } catch (e) {
      // 文件写入失败不阻塞主流程
      console.log(`[TransitionStore] 文件写入失败（忽略）: ${e}`);
    }
  }
}

// ============================================================
// 单例工厂
// ============================================================

let singleton: WorldModelTransitionStore | null = null;

/**
 * 获取转移样本存储单例。
 *
 * 首次调用时创建，后续调用返回同一实例。
 * BRAIN_WORLD_MODEL_ENABLED=0 时返回 null（不创建存储）。
 */
export function getTransitionStore(): WorldModelTransitionStore | null {
  const enabled = process.env.BRAIN_WORLD_MODEL_ENABLED;
  if (enabled === "0" || enabled === "false" || enabled === "off") {
    return null;
  }
  if (!singleton) {
    singleton = new WorldModelTransitionStore();
  }
  return singleton;
}
