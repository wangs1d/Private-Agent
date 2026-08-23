// ProactivityHub —— 通用感知层（PerceptionFeed）
//
// 感知是可插拔的通用流：任何源（对话轮 / 日程 / 节律 / 任务事件 / 桌面 presence /
// 情绪信号……）都把观察推成统一格式的 Observation，滚动窗口保留。
// InitiativeEngine 周期性消费"自上次评估以来的新观察"（无新观察不调 LLM，零开销）。
//
// 设计约束：
// - 纯内存、纯逻辑可单测，不依赖任何具体服务
// - 每 actor 滚动窗口（默认 40 条），旧观察挤掉
// - consumeWindow 增量消费（记录已消费水位），窗口本身不清空——
//   近期旧观察仍可作为 LLM 决策的背景上下文（recent()）
import type { Observation } from "./proactivity-types.js";

export type { Observation } from "./proactivity-types.js";

/** 每 actor 滚动窗口容量 */
const WINDOW_SIZE = 40;
/** recent() 默认返回条数（LLM 决策的背景上下文） */
const DEFAULT_RECENT = 12;

export class PerceptionFeed {
  private readonly actors = new Map<string, Observation[]>();
  /** 每 actor 已消费水位（consumeWindow 只返回此下标之后的新观察） */
  private readonly consumedAt = new Map<string, number>();

  /** 推入一条观察（滚动窗口，超出容量丢最旧） */
  push(observation: Observation): void {
    const list = this.actors.get(observation.actorId) ?? [];
    list.push(observation);
    if (list.length > WINDOW_SIZE) list.splice(0, list.length - WINDOW_SIZE);
    this.actors.set(observation.actorId, list);
  }

  /** 便捷构造并推入 */
  pushObservation(
    actorId: string,
    type: string,
    content: string,
    salience: Observation["salience"] = "medium",
    now: number = Date.now(),
    metadata?: Record<string, unknown>,
  ): void {
    this.push({ actorId, type, content, salience, observedAt: now, ...(metadata ? { metadata } : {}) });
  }

  /**
   * 增量消费：返回自上次消费以来的新观察（含水位推进）。
   * 无新观察返回空数组（调用方据此跳过 LLM 评估，零 token 开销）。
   */
  consumeWindow(actorId: string): Observation[] {
    const list = this.actors.get(actorId) ?? [];
    const from = this.consumedAt.get(actorId) ?? 0;
    const fresh = list.slice(from);
    this.consumedAt.set(actorId, list.length);
    return fresh;
  }

  /** 只读最近 N 条（背景上下文，不推进水位） */
  recent(actorId: string, limit: number = DEFAULT_RECENT): Observation[] {
    const list = this.actors.get(actorId) ?? [];
    return list.slice(-limit);
  }

  /** 未消费观察数（诊断/测试用） */
  pendingCount(actorId: string): number {
    const list = this.actors.get(actorId) ?? [];
    return list.length - (this.consumedAt.get(actorId) ?? 0);
  }
}
