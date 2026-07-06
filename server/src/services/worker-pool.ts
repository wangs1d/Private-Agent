/**
 * Worker 线程池：基于 node:worker_threads 的通用任务分发器。
 *
 * 用于将慢能力（code.run / image.generate）放到独立 worker 线程执行，
 * 实现故障隔离——worker 崩溃不影响主进程。
 *
 * 设计要点：
 *   - 每个 worker 处理一种任务类型（code / image）
 *   - 主进程通过 postMessage 提交任务，worker 执行后 postMessage 返回结果
 *   - worker 崩溃后自动重启
 *   - 任务有序列化开销，仅用于真正的慢任务（>100ms）
 *
 * 通信协议：
 *   主→Worker: { id, type, payload }
 *   Worker→主: { id, ok, result | error }
 */

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type WorkerTaskType = "code.run" | "image.generate";

export interface WorkerTaskRequest {
  id: string;
  type: WorkerTaskType;
  payload: unknown;
}

export interface WorkerTaskResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type PendingTask = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 主进程侧的 Worker 池管理器。
 * 每个 WorkerTaskType 对应一个 Worker 实例。
 */
class WorkerPoolManager {
  private workers = new Map<WorkerTaskType, Worker>();
  private pending = new Map<string, PendingTask>();
  private workerBusy = new Map<WorkerTaskType, boolean>();
  private taskQueue = new Map<WorkerTaskType, Array<() => void>>();

  /**
   * 提交一个任务到 worker 线程执行。
   * 如果 worker 忙，排队等待。
   */
  async submit<T>(type: WorkerTaskType, payload: unknown, timeoutMs = 120_000): Promise<T> {
    // 确保 worker 已启动
    this.ensureWorker(type);

    return new Promise<T>((resolve, reject) => {
      const task = async () => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Worker[${type}] 任务超时 (${timeoutMs}ms)`));
        }, timeoutMs);

        this.pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result as T);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          timer,
        });

        const worker = this.workers.get(type)!;
        worker.postMessage({ id, type, payload } satisfies WorkerTaskRequest);
      };

      // 如果 worker 空闲，立即执行；否则入队
      if (!this.workerBusy.get(type)) {
        this.workerBusy.set(type, true);
        task();
      } else {
        const queue = this.taskQueue.get(type) ?? [];
        queue.push(task);
        this.taskQueue.set(type, queue);
      }
    });
  }

  private ensureWorker(type: WorkerTaskType): void {
    if (this.workers.has(type)) return;

    const workerScript = this.resolveWorkerScript(type);
    const worker = new Worker(workerScript, {
      workerData: { type },
    });

    worker.on("message", (msg: WorkerTaskResponse) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);

      // 标记 worker 空闲，处理下一个排队任务
      this.workerBusy.set(type, false);
      this.drainQueue(type);

      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error ?? "worker 执行失败"));
      }
    });

    worker.on("error", (err) => {
      console.error(`[worker-pool] Worker[${type}] 崩溃:`, err.message);
      // 拒绝所有 pending 任务
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Worker[${type}] 崩溃: ${err.message}`));
      }
      this.pending.clear();
      this.workerBusy.set(type, false);
      this.workers.delete(type);
      // 重启 worker（下次 submit 时会 ensureWorker）
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        console.warn(`[worker-pool] Worker[${type}] 退出 code=${code}`);
      }
      this.workers.delete(type);
      this.workerBusy.set(type, false);
    });

    this.workers.set(type, worker);
    this.workerBusy.set(type, false);
  }

  private drainQueue(type: WorkerTaskType): void {
    const queue = this.taskQueue.get(type);
    if (!queue || queue.length === 0) return;
    if (this.workerBusy.get(type)) return;

    const next = queue.shift()!;
    this.workerBusy.set(type, true);
    next();
  }

  private resolveWorkerScript(type: WorkerTaskType): string {
    // Worker 脚本按类型映射到对应文件
    const scriptMap: Record<WorkerTaskType, string> = {
      "code.run": join(__dirname, "workers", "code-worker.mjs"),
      "image.generate": join(__dirname, "workers", "image-worker.mjs"),
    };
    return scriptMap[type];
  }

  /** 销毁所有 worker（优雅关闭）。 */
  async terminate(): Promise<void> {
    for (const [type, worker] of this.workers) {
      await worker.terminate();
      this.workers.delete(type);
      this.workerBusy.set(type, false);
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("worker pool 已终止"));
    }
    this.pending.clear();
  }

  /** 获取 worker 池状态（供监控）。 */
  getStats() {
    const stats: Record<string, { busy: boolean; queued: number }> = {};
    for (const type of this.workers.keys()) {
      stats[type] = {
        busy: this.workerBusy.get(type) ?? false,
        queued: this.taskQueue.get(type)?.length ?? 0,
      };
    }
    return stats;
  }
}

// 全局单例
export const workerPool = new WorkerPoolManager();
