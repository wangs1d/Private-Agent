/**
 * TaskOutbox —— 任务面结果的离线投递箱（2026-09-08）。
 *
 * 缺口（本模块闭合）：后台任务（dispatchBackgroundTask）完成后经
 * wsRegistry.trySend 推送 chat.assistant_done，用户离线时 trySend 返回
 * false，事件被静默丢弃；而客户端不拉取服务端 thread 历史——离线期间
 * 完成的结果在客户端视角永久丢失。
 *
 * 契约：
 *   - 入箱：pushDone 投递失败（离线/registry 缺失）时 enqueue；
 *   - 重放：客户端重连（ws/connection session.init 注册连接后）调用
 *     replayFor，按 FIFO 原样重推 chat.assistant_done（messageId 不变，
 *     客户端幂等）；
 *   - 防泄漏：入箱 TTL（默认 24h，过期丢弃——用户一天都没上线视为放弃）
 *     + 每会话上限（默认 20 条，超限丢最旧）；
 *   - 进程内单例（与 TaskHub 同风格）：服务器重启时执行中的任务本身不
 *     恢复，无结果可投递；结果文本已由 appendThreadTurn 落 thread。
 */

import { ServerEventType } from "../protocol.js";

export type TaskOutboxEntry = {
  sessionId: string;
  messageId: string;
  finalText: string;
  /** 任务面媒体卡片：照片/视频结果与 finalText 同生命周期，重放必须原样携带。 */
  mediaCards?: Array<Record<string, unknown>>;
  enqueuedAt: number;
};

const ENTRY_TTL_MS = 24 * 60 * 60_000;
const MAX_PER_SESSION = 20;

export class TaskOutbox {
  private readonly entries = new Map<string, TaskOutboxEntry[]>();

  /** 投递失败入箱（同 messageId 去重——同一结果只补投一次）。 */
  enqueue(
    sessionId: string,
    entry: { messageId: string; finalText: string; mediaCards?: Array<Record<string, unknown>> },
  ): void {
    if (!sessionId || !entry.messageId || !entry.finalText) return;
    let queue = this.entries.get(sessionId);
    if (!queue) {
      queue = [];
      this.entries.set(sessionId, queue);
    }
    if (queue.some((e) => e.messageId === entry.messageId)) return;
    queue.push({
      sessionId,
      messageId: entry.messageId,
      finalText: entry.finalText,
      ...(entry.mediaCards && entry.mediaCards.length > 0 ? { mediaCards: entry.mediaCards } : {}),
      enqueuedAt: Date.now(),
    });
    if (queue.length > MAX_PER_SESSION) queue.splice(0, queue.length - MAX_PER_SESSION);
  }

  /** 取出并清空该会话的待投递条目（FIFO）。 */
  drain(sessionId: string): TaskOutboxEntry[] {
    this.pruneExpired();
    const queue = this.entries.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.entries.delete(sessionId);
    return queue;
  }

  /** 待投递条数（运维/测试观测）。 */
  pendingCount(sessionId: string): number {
    this.pruneExpired();
    return this.entries.get(sessionId)?.length ?? 0;
  }

  /**
   * 重连重放：把离线期间入箱的任务面结果按 FIFO 原样重推。
   * 事件格式与 dispatchBackgroundTask.pushDone 完全一致（含 source:
   * "task_plane"），客户端按普通 assistant 消息收尾入列表。
   */
  replayFor(sessionId: string, socket: { send(data: string): void }): number {
    const batch = this.drain(sessionId);
    for (const entry of batch) {
      try {
        socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: {
              sessionId,
              messageId: entry.messageId,
              finalText: entry.finalText,
              toolCalls: [],
              source: "task_plane",
              ...(entry.mediaCards && entry.mediaCards.length > 0
                ? { mediaCards: entry.mediaCards }
                : {}),
            },
          }),
        );
      } catch {
        // 单条失败重新入箱，剩余批次继续（部分网络抖动不吞结果）
        this.enqueue(sessionId, {
          messageId: entry.messageId,
          finalText: entry.finalText,
          mediaCards: entry.mediaCards,
        });
      }
    }
    return batch.length;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, queue] of this.entries) {
      const alive = queue.filter((e) => now - e.enqueuedAt <= ENTRY_TTL_MS);
      if (alive.length === 0) this.entries.delete(sessionId);
      else if (alive.length !== queue.length) this.entries.set(sessionId, alive);
    }
  }

  /** 供运维/测试：清空全部条目。 */
  reset(): void {
    this.entries.clear();
  }
}

const globalForTaskOutbox = globalThis as unknown as { __taskPlaneOutbox?: TaskOutbox };

/** 进程级单例。 */
export function getTaskOutbox(): TaskOutbox {
  globalForTaskOutbox.__taskPlaneOutbox ??= new TaskOutbox();
  return globalForTaskOutbox.__taskPlaneOutbox;
}
