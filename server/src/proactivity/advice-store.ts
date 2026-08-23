// ProactivityHub —— advise 模式载体（AdviceStore）
//
// 主动建议不入消息流（不打扰），而是排队等下一轮对话时注入 prompt
// 【Agent 主动建议】块，由 agent 在正常回复中自然带出。
// 内存态 + 48h 过期 + 每 actor 上限 3 条（旧建议被新建议挤掉）。
import type { ProactiveIntent } from "./proactivity-types.js";

const MAX_PER_ACTOR = 3;
const EXPIRE_MS = 48 * 60 * 60 * 1000;

export type AdviceItem = {
  kind: ProactiveIntent["kind"];
  text: string;
  createdAt: number;
};

export class AdviceStore {
  private readonly actors = new Map<string, AdviceItem[]>();

  /** 入队一条主动建议；超出上限时丢最旧 */
  push(actorId: string, item: Omit<AdviceItem, "createdAt">): void {
    const queue = this.actors.get(actorId) ?? [];
    queue.push({ ...item, createdAt: Date.now() });
    while (queue.length > MAX_PER_ACTOR) queue.shift();
    this.actors.set(actorId, queue);
  }

  /** 取走全部未过期建议（取出即清空，避免重复注入） */
  drain(actorId: string): AdviceItem[] {
    const queue = this.actors.get(actorId) ?? [];
    this.actors.set(actorId, []);
    const now = Date.now();
    return queue.filter((item) => now - item.createdAt < EXPIRE_MS);
  }

  /** 查看队列长度（诊断用） */
  sizeOf(actorId: string): number {
    return this.actors.get(actorId)?.length ?? 0;
  }
}
