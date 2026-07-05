/**
 * WS 远程设备适配器基类
 *
 * 抽象「通过 WS 与远程设备做 RPC + 事件流」的通用逻辑，
 * phone / desktop / glasses / tablet / watch 适配器复用此基类，
 * 只需声明各自的默认能力清单。
 *
 * 内部组合 WsDeviceRpcBridge 完成 invoke / openStream；
 * 用 EventQueue 把 bridge 的回调式 onDeviceEvent 转成 AsyncIterable。
 */
import type {
  DeviceAdapter,
  DeviceAdapterFactory,
  DeviceAdapterInit,
  AdapterStaticInfo,
  DeviceConnection,
} from "../device-adapter.js";
import type {
  CapabilityDeclaration,
  DeviceInvokeResult,
  DeviceKind,
  DeviceStreamChunk,
} from "../device-model.js";
import { WsDeviceRpcBridge } from "../device-rpc.js";

/** 设备主动上报事件的载体。 */
export type DeviceEventPayload = { type: string; payload: Record<string, unknown> };

/**
 * 回调 → AsyncIterable 转换器。
 * 用法：queue.push(event) 推入；消费方用 for await 遍历。
 */
class EventQueue implements AsyncIterable<DeviceEventPayload> {
  private queue: DeviceEventPayload[] = [];
  private waiter: ((v: IteratorResult<DeviceEventPayload>) => void) | null = null;
  private done = false;

  push(event: DeviceEventPayload): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<DeviceEventPayload> {
    return {
      next: (): Promise<IteratorResult<DeviceEventPayload>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<DeviceEventPayload>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async (): Promise<IteratorResult<DeviceEventPayload>> => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

/**
 * WS 远程适配器基类。
 * 子类只需声明 kind + defaultCapabilities；其余逻辑复用。
 */
export abstract class WsRemoteAdapter implements DeviceAdapter {
  abstract readonly kind: DeviceAdapter["kind"];
  readonly deviceId: string;
  protected bridge: WsDeviceRpcBridge | null = null;
  protected connection: DeviceConnection | undefined;
  private readonly eventQueue = new EventQueue();
  private unsubscribeEvent: (() => void) | null = null;

  /** 子类声明的默认能力清单；工厂注册时与 descriptor 取并集。 */
  protected abstract readonly defaultCapabilities: { id: string; actions?: string[]; streams?: string[] }[];

  constructor(init: DeviceAdapterInit) {
    this.deviceId = init.descriptor.deviceId;
    this.connection = init.connection;
  }

  initialize(init: DeviceAdapterInit): void {
    if (!init.connection) {
      throw new Error(`WsRemoteAdapter(kind=${this.kind}) 需要 connection`);
    }
    this.connection = init.connection;
    this.bridge = new WsDeviceRpcBridge(init.connection, this.deviceId);
    this.unsubscribeEvent = this.bridge.onDeviceEvent((e) => {
      this.eventQueue.push(e);
    });
  }

  async invoke(action: string, params: Record<string, unknown>): Promise<DeviceInvokeResult> {
    if (!this.bridge) {
      return { ok: false, error: { code: "NOT_INITIALIZED", message: "适配器未初始化" } };
    }
    return this.bridge.invoke(action, params);
  }

  openStream(streamId: string, params: Record<string, unknown>): AsyncIterable<DeviceStreamChunk> {
    if (!this.bridge) {
      return singleErrorStream(streamId, "NOT_INITIALIZED", "适配器未初始化");
    }
    return this.bridge.openStream(streamId, params);
  }

  /** 设备主动上报事件流；订阅者通过 for await 消费。 */
  get events(): AsyncIterable<DeviceEventPayload> {
    return this.eventQueue;
  }

  dispose(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
    this.bridge?.dispose("adapter_disposed");
    this.bridge = null;
    this.eventQueue.close();
  }

  /** WS 路由层入口：收到 device.invoke_result 时调用。 */
  handleInvokeResult(jobId: string, payload: DeviceInvokeResult): void {
    this.bridge?.handleInvokeResult(jobId, payload);
  }

  /** WS 路由层入口：收到 device.stream_data 时调用。 */
  handleStreamData(streamId: string, chunk: DeviceStreamChunk): void {
    this.bridge?.handleStreamData(streamId, chunk);
  }

  /** WS 路由层入口：收到 device.event 时调用。 */
  handleDeviceEvent(event: DeviceEventPayload): void {
    this.bridge?.handleDeviceEvent(event);
  }
}

function singleErrorStream(streamId: string, code: string, message: string): AsyncIterable<DeviceStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { streamId, kind: "error", error: { code, message } };
    },
  };
}

/**
 * 通用 WS 远程适配器工厂。
 *
 * tablet / glasses / watch 等移动设备族直接复用此工厂，只需传入 kind + 默认能力清单。
 * phone / desktop 因能力清单较长且需独立文档化，仍各自保留独立文件。
 */
export function createWsRemoteAdapterFactory(
  kind: DeviceKind,
  capabilities: CapabilityDeclaration[],
): DeviceAdapterFactory & AdapterStaticInfo {
  class GenericWsRemoteAdapter extends WsRemoteAdapter {
    readonly kind = kind;
    protected readonly defaultCapabilities = capabilities;
  }
  return Object.assign(
    (init: DeviceAdapterInit): DeviceAdapter => new GenericWsRemoteAdapter(init),
    {
      kind,
      requiresConnection: true,
      defaultCapabilities: capabilities,
    },
  );
}
