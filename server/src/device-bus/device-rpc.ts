/**
 * WS 设备 RPC 桥梁
 *
 * 解决「远程 WS 设备的同步 invoke + 异步流式数据」问题。
 * 适配器（phone / desktop / glasses / tablet）持有此桥，把 device.invoke / device.stream_open
 * 下发到远程设备，等待 device.invoke_result / device.stream_data 回包。
 *
 * 流程：
 *   invoke:
 *     adapter.invoke(action, params)
 *       → bridge.invoke(action, params)
 *         → connection.send("device.invoke", { jobId, action, params })
 *         → 远程设备执行 → 回传 "device.invoke_result" { jobId, ok, data, error }
 *         → ws 路由层调用 bridge.handleInvokeResult(jobId, payload)
 *         → Promise resolve
 *
 *   openStream:
 *     adapter.openStream(streamId, params)
 *       → bridge.openStream(streamId, params)
 *         → connection.send("device.stream_open", { streamId, params })
 *         → 远程设备推流 → 多次回传 "device.stream_data" { streamId, kind, data }
 *         → ws 路由层调用 bridge.handleStreamData(streamId, chunk)
 *         → AsyncGenerator yield
 *         → 流结束回传 kind="end" → generator return
 *
 * 桥与一台远程设备的 connection 一一对应；设备断连时调用 dispose() 清理所有 pending。
 */
import type { DeviceInvokeResult, DeviceStreamChunk } from "./device-model.js";
import type { DeviceConnection } from "./device-adapter.js";

export interface WsDeviceRpcBridgeOptions {
  /** invoke 超时 ms；超时返回 ok=false + INVOKE_TIMEOUT。默认 30s。 */
  invokeTimeoutMs?: number;
  /** 日志回调；不传则静默。 */
  log?: (level: "warn" | "info", msg: string, ctx?: Record<string, unknown>) => void;
}

interface PendingInvoke {
  resolve: (r: DeviceInvokeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingStream {
  /** 已到达但尚未被消费的 chunks。 */
  queue: DeviceStreamChunk[];
  /** 等待下一个 chunk 的消费者；null 表示无人在等。 */
  waiter: ((chunk: DeviceStreamChunk | null) => void) | null;
  done: boolean;
}

export class WsDeviceRpcBridge {
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  private readonly invokeTimeoutMs: number;
  private readonly log: WsDeviceRpcBridgeOptions["log"];
  private disposed = false;

  constructor(
    private readonly connection: DeviceConnection,
    private readonly deviceId: string,
    options: WsDeviceRpcBridgeOptions = {},
  ) {
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 30_000;
    this.log = options.log;
  }

  /** 适配器入口：下发 invoke，等待远程设备回包。 */
  invoke(action: string, params: Record<string, unknown>): Promise<DeviceInvokeResult> {
    if (this.disposed) {
      return Promise.resolve({
        ok: false,
        error: { code: "BRIDGE_DISPOSED", message: "设备桥已释放" },
      });
    }
    const jobId = makeJobId(this.deviceId);
    const startedAt = Date.now();

    return new Promise<DeviceInvokeResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingInvokes.has(jobId)) return;
        this.pendingInvokes.delete(jobId);
        this.log?.("warn", "device.invoke timeout", { deviceId: this.deviceId, jobId, action });
        resolve({
          ok: false,
          error: {
            code: "INVOKE_TIMEOUT",
            message: `设备 ${this.deviceId} 调用 ${action} 超时 (${this.invokeTimeoutMs}ms)`,
          },
          elapsedMs: Date.now() - startedAt,
        });
      }, this.invokeTimeoutMs);

      this.pendingInvokes.set(jobId, { resolve, timer });

      const sent = this.connection.send("device.invoke", { jobId, action, params });
      if (!sent) {
        clearTimeout(timer);
        this.pendingInvokes.delete(jobId);
        resolve({
          ok: false,
          error: { code: "DEVICE_DISCONNECTED", message: "设备连接已断开" },
          elapsedMs: Date.now() - startedAt,
        });
      }
    });
  }

  /** WS 路由层入口：收到 device.invoke_result 时调用。 */
  handleInvokeResult(jobId: string, payload: DeviceInvokeResult): void {
    const pending = this.pendingInvokes.get(jobId);
    if (!pending) return; // 已超时或已取消
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(jobId);
    pending.resolve(payload);
  }

  /** 适配器入口：开一条流，返回 AsyncGenerator。 */
  openStream(
    streamId: string,
    params: Record<string, unknown>,
  ): AsyncIterable<DeviceStreamChunk> {
    if (this.disposed) {
      return singleChunk({
        streamId,
        kind: "error",
        error: { code: "BRIDGE_DISPOSED", message: "设备桥已释放" },
      });
    }
    const sent = this.connection.send("device.stream_open", { streamId, params });
    if (!sent) {
      return singleChunk({
        streamId,
        kind: "error",
        error: { code: "DEVICE_DISCONNECTED", message: "设备连接已断开" },
      });
    }

    this.pendingStreams.set(streamId, { queue: [], waiter: null, done: false });

    return this.consumeStream(streamId);
  }

  /** WS 路由层入口：收到 device.stream_data 时调用。 */
  handleStreamData(streamId: string, chunk: DeviceStreamChunk): void {
    const pending = this.pendingStreams.get(streamId);
    if (!pending || pending.done) return;
    const normalized: DeviceStreamChunk = { ...chunk, streamId };
    if (pending.waiter) {
      const waiter = pending.waiter;
      pending.waiter = null;
      waiter(normalized);
    } else {
      pending.queue.push(normalized);
    }
    if (normalized.kind === "end" || normalized.kind === "error") {
      pending.done = true;
      // 唤醒正在等待的消费者，让它退出循环
      if (pending.waiter) {
        const waiter: (chunk: DeviceStreamChunk | null) => void = pending.waiter;
        pending.waiter = null;
        waiter(null);
      }
      this.pendingStreams.delete(streamId);
    }
  }

  /** 主动关闭流（消费者取消 / 适配器 dispose）。 */
  closeStream(streamId: string, reason: string = "client_cancelled"): void {
    const pending = this.pendingStreams.get(streamId);
    if (!pending) return;
    pending.done = true;
    if (pending.waiter) {
      const waiter = pending.waiter;
      pending.waiter = null;
      waiter(null);
    }
    this.pendingStreams.delete(streamId);
    if (!this.disposed) {
      this.connection.send("device.stream_close", { streamId, reason });
    }
  }

  /** WS 路由层入口：收到设备主动上报事件时，返回事件给订阅者（适配器可暴露为 adapter.events）。 */
  handleDeviceEvent(event: { type: string; payload: Record<string, unknown> }): void {
    // 简化实现：直接转发给事件监听器（若有）。Phase 3 适配器可在此挂载。
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响主流程
      }
    }
  }

  private readonly eventListeners = new Set<(e: { type: string; payload: Record<string, unknown> }) => void>();
  /** 订阅设备主动上报事件。返回取消订阅函数。 */
  onDeviceEvent(listener: (e: { type: string; payload: Record<string, unknown> }) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * 释放桥：拒绝所有 pending invoke，关闭所有 pending stream。
   * 设备 WS 断连时必须调用，避免悬挂 Promise。
   */
  dispose(reason: string = "connection_closed"): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const [jobId, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: { code: "DEVICE_DISCONNECTED", message: reason },
      });
    }
    this.pendingInvokes.clear();

    for (const [streamId, pending] of this.pendingStreams) {
      pending.done = true;
      if (pending.waiter) {
        const waiter: (chunk: DeviceStreamChunk | null) => void = pending.waiter;
        pending.waiter = null;
        waiter(null);
      }
    }
    this.pendingStreams.clear();
    this.eventListeners.clear();
  }

  private async *consumeStream(streamId: string): AsyncGenerator<DeviceStreamChunk> {
    while (true) {
      const pending = this.pendingStreams.get(streamId);
      if (!pending) break;
      if (pending.queue.length > 0) {
        const chunk = pending.queue.shift()!;
        yield chunk;
        if (chunk.kind === "end" || chunk.kind === "error") break;
        continue;
      }
      if (pending.done) break;
      // 等待新 chunk
      const chunk = await new Promise<DeviceStreamChunk | null>((resolve) => {
        const p = this.pendingStreams.get(streamId);
        if (!p) {
          resolve(null);
          return;
        }
        if (p.queue.length > 0) {
          resolve(p.queue.shift()!);
        } else if (p.done) {
          resolve(null);
        } else {
          p.waiter = resolve;
        }
      });
      if (chunk === null) break;
      yield chunk;
      if (chunk.kind === "end" || chunk.kind === "error") break;
    }
    // 兜底清理：若 generator 提前 break（消费者取消），关掉流
    this.closeStream(streamId, "consumer_cancelled");
  }
}

// ---------- 工具 ----------

function makeJobId(deviceId: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${deviceId}-${Date.now().toString(36)}-${rand}`;
}

function singleChunk(chunk: DeviceStreamChunk): AsyncIterable<DeviceStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield chunk;
    },
  };
}
