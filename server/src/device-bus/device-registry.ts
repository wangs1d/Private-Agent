/**
 * 设备注册表 —— 终端互连平台的核心路由层。
 *
 * 与现有 WsConnectionRegistry 共存、互不依赖：
 *  - WsConnectionRegistry 仍承载「主用户会话」（chat / embodiment / wallet 等单连接语义）
 *  - DeviceRegistry 承载「多设备并存」：一个 ownerUserId 下可挂 N 台设备，按 deviceId 路由
 *
 * 索引结构：
 *  - byDeviceId:   deviceId -> DeviceEntry  （O(1) 查找 / 调用）
 *  - byOwner:      ownerUserId -> Set<deviceId>  （列出某用户所有设备）
 *  - byCapability: capabilityId -> Set<deviceId>  （「哪些设备有 camera」）
 *
 * 上下线广播通过 onDeviceChange hook 暴露，由 ws 层订阅推送 device.online / device.offline。
 */
import type {
  CapabilityDeclaration,
  CapabilityId,
  DeviceDescriptor,
  DeviceInvokeResult,
  DeviceKind,
  DeviceStreamChunk,
} from "./device-model.js";
import type {
  AdapterStaticInfo,
  DeviceAdapter,
  DeviceAdapterFactory,
  DeviceAdapterInit,
  DeviceConnection,
} from "./device-adapter.js";

interface DeviceEntry {
  descriptor: DeviceDescriptor;
  adapter: DeviceAdapter;
  /** 注册时传入的连接句柄；本地服务适配器可为 undefined。 */
  connection?: DeviceConnection;
  /** 流会话计数器，用于生成唯一 streamId。 */
  streamSeq: number;
}

/** 设备变更事件，供 ws 层订阅广播。 */
export type DeviceChangeEvent =
  | { kind: "online"; descriptor: DeviceDescriptor }
  | { kind: "offline"; deviceId: string; ownerUserId: string; reason?: string }
  | { kind: "capability_changed"; deviceId: string; ownerUserId: string; capabilities: CapabilityDeclaration[] }
  | { kind: "status_changed"; deviceId: string; ownerUserId: string; status: DeviceDescriptor["status"] };

export type DeviceChangeListener = (event: DeviceChangeEvent) => void;

export class DeviceRegistry {
  private readonly byDeviceId = new Map<string, DeviceEntry>();
  private readonly byOwner = new Map<string, Set<string>>();
  private readonly byCapability = new Map<string, Set<string>>();
  private readonly factories = new Map<DeviceKind, DeviceAdapterFactory & AdapterStaticInfo>();
  private readonly listeners = new Set<DeviceChangeListener>();

  // ---------- 适配器工厂 ----------

  /**
   * 注册适配器工厂。每种 DeviceKind 只能注册一次。
   * Phase 3 之后由各 adapter 模块在 bootstrap 时调用。
   */
  registerFactory(factory: DeviceAdapterFactory & AdapterStaticInfo): void {
    if (this.factories.has(factory.kind)) {
      throw new Error(`DeviceAdapter factory for kind="${factory.kind}" already registered`);
    }
    this.factories.set(factory.kind, factory);
  }

  getRegisteredKinds(): DeviceKind[] {
    return Array.from(this.factories.keys());
  }

  // ---------- 设备生命周期 ----------

  /**
   * 注册一台设备。
   *  - 若 deviceId 已存在且 owner 一致：视为重连，更新 descriptor + connection，触发 capability_changed
   *  - 若 deviceId 已存在但 owner 不同：拒绝（deviceId 全局唯一约束）
   *  - 若工厂未注册该 kind：拒绝
   *  - 初始化失败：回滚（不保留 entry），向上抛错
   */
  async register(
    descriptor: DeviceDescriptor,
    connection?: DeviceConnection,
  ): Promise<DeviceDescriptor> {
    const factory = this.factories.get(descriptor.kind);
    if (!factory) {
      throw new Error(`No DeviceAdapter factory for kind="${descriptor.kind}"`);
    }
    if (factory.requiresConnection && !connection) {
      throw new Error(`Device kind="${descriptor.kind}" requires a connection`);
    }

    const existing = this.byDeviceId.get(descriptor.deviceId);
    if (existing && existing.descriptor.ownerUserId !== descriptor.ownerUserId) {
      throw new Error(
        `deviceId="${descriptor.deviceId}" already owned by another user`,
      );
    }

    // 合并默认能力，避免每个适配器都要手写完整能力清单
    const mergedCapabilities = mergeCapabilities(
      factory.defaultCapabilities,
      descriptor.capabilities,
    );
    const normalizedDescriptor: DeviceDescriptor = {
      ...descriptor,
      capabilities: mergedCapabilities,
      lastSeenAt: Date.now(),
      status: descriptor.status === "offline" ? "offline" : "online",
    };

    if (existing) {
      // 重连：先释放旧 adapter，再创建新的
      await safeDispose(existing.adapter);
    }

    const adapter = factory({
      descriptor: normalizedDescriptor,
      connection,
    });
    await adapter.initialize({ descriptor: normalizedDescriptor, connection });

    const entry: DeviceEntry = {
      descriptor: normalizedDescriptor,
      adapter,
      connection,
      streamSeq: 0,
    };
    this.byDeviceId.set(normalizedDescriptor.deviceId, entry);
    this.indexOwner(normalizedDescriptor.ownerUserId, normalizedDescriptor.deviceId);
    for (const cap of normalizedDescriptor.capabilities) {
      this.indexCapability(cap.id, normalizedDescriptor.deviceId);
    }

    this.emit({
      kind: existing ? "capability_changed" : "online",
      ...(existing
        ? {
            deviceId: normalizedDescriptor.deviceId,
            ownerUserId: normalizedDescriptor.ownerUserId,
            capabilities: normalizedDescriptor.capabilities,
          }
        : { descriptor: normalizedDescriptor }),
    } as DeviceChangeEvent);

    return normalizedDescriptor;
  }

  /**
   * 注销设备。释放适配器资源，清理索引，广播 offline。
   * reason 用于审计 / UI 提示（如 "heartbeat_timeout" / "user_logout"）。
   */
  async unregister(deviceId: string, reason?: string): Promise<void> {
    const entry = this.byDeviceId.get(deviceId);
    if (!entry) return;
    await safeDispose(entry.adapter);
    this.byDeviceId.delete(deviceId);
    this.unindexOwner(entry.descriptor.ownerUserId, deviceId);
    for (const cap of entry.descriptor.capabilities) {
      this.unindexCapability(cap.id, deviceId);
    }
    this.emit({
      kind: "offline",
      deviceId,
      ownerUserId: entry.descriptor.ownerUserId,
      reason,
    });
  }

  /**
   * 标记设备为离线但保留注册信息（如手机断网短暂掉线）。
   * 重连时调用 register 即可恢复。
   */
  markOffline(deviceId: string, reason?: string): void {
    const entry = this.byDeviceId.get(deviceId);
    if (!entry) return;
    if (entry.descriptor.status === "offline") return;
    entry.descriptor = { ...entry.descriptor, status: "offline", lastSeenAt: Date.now() };
    this.emit({
      kind: "status_changed",
      deviceId,
      ownerUserId: entry.descriptor.ownerUserId,
      status: "offline",
    });
    // 不主动 unregister；让重连覆盖。但调用方可通过 onDeviceChange 感知掉线。
    if (reason) {
      // reason 暂只用于日志，不进事件 payload
    }
  }

  /** 更新设备状态（busy / online / error）。 */
  setStatus(deviceId: string, status: DeviceDescriptor["status"]): void {
    const entry = this.byDeviceId.get(deviceId);
    if (!entry) return;
    if (entry.descriptor.status === status) return;
    entry.descriptor = { ...entry.descriptor, status, lastSeenAt: Date.now() };
    this.emit({
      kind: "status_changed",
      deviceId,
      ownerUserId: entry.descriptor.ownerUserId,
      status,
    });
  }

  /** 设备心跳：刷新 lastSeenAt。桥接器应在收到设备 ping 时调用。 */
  heartbeat(deviceId: string): void {
    const entry = this.byDeviceId.get(deviceId);
    if (!entry) return;
    entry.descriptor.lastSeenAt = Date.now();
  }

  // ---------- 查询 ----------

  get(deviceId: string): DeviceDescriptor | undefined {
    return this.byDeviceId.get(deviceId)?.descriptor;
  }

  /**
   * 取出设备的适配器实例。WS 路由层用它把 device.invoke_result / device.stream_data
   * 等回包事件直接路由到对应适配器（WsRemoteAdapter.handleInvokeResult 等）。
   * 业务代码一般不需要直接调用适配器；应通过 invoke() / openStream() 走标准路径。
   */
  getAdapter(deviceId: string): DeviceAdapter | undefined {
    return this.byDeviceId.get(deviceId)?.adapter;
  }

  listByOwner(ownerUserId: string): DeviceDescriptor[] {
    const ids = this.byOwner.get(ownerUserId);
    if (!ids || ids.size === 0) return [];
    const out: DeviceDescriptor[] = [];
    for (const id of ids) {
      const entry = this.byDeviceId.get(id);
      if (entry) out.push(entry.descriptor);
    }
    return out;
  }

  /**
   * 按能力检索在线设备。
   *  - capabilityPrefix=true 时按前缀匹配（如 "sensor." 命中所有传感器）
   *  - onlyOnline=true 时只返回 online 设备
   */
  findByCapability(
    capability: CapabilityId,
    options?: { prefix?: boolean; onlyOnline?: boolean; ownerUserId?: string },
  ): DeviceDescriptor[] {
    const ids = options?.prefix
      ? this.collectByCapabilityPrefix(capability)
      : this.byCapability.get(capability) ?? new Set<string>();
    const out: DeviceDescriptor[] = [];
    for (const id of ids) {
      const entry = this.byDeviceId.get(id);
      if (!entry) continue;
      if (options?.onlyOnline && entry.descriptor.status !== "online") continue;
      if (options?.ownerUserId && entry.descriptor.ownerUserId !== options.ownerUserId) continue;
      out.push(entry.descriptor);
    }
    return out;
  }

  private collectByCapabilityPrefix(prefix: string): Set<string> {
    const out = new Set<string>();
    for (const [cap, ids] of this.byCapability) {
      if (cap.startsWith(prefix)) {
        for (const id of ids) out.add(id);
      }
    }
    return out;
  }

  /** 列出某用户具备某能力的所有设备（最常用的 Agent 查询）。 */
  findUserCapability(
    ownerUserId: string,
    capability: CapabilityId,
    options?: { prefix?: boolean; onlyOnline?: boolean },
  ): DeviceDescriptor[] {
    return this.findByCapability(capability, {
      ...(options ?? {}),
      ownerUserId,
    });
  }

  // ---------- 调用 ----------

  /** 调用设备的某个 action。设备不存在或离线时返回 ok=false。 */
  async invoke(
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<DeviceInvokeResult> {
    const entry = this.byDeviceId.get(deviceId);
    if (!entry) {
      return { ok: false, error: { code: "DEVICE_NOT_FOUND", message: `设备 ${deviceId} 未注册` } };
    }
    if (entry.descriptor.status === "offline") {
      return { ok: false, error: { code: "DEVICE_OFFLINE", message: `设备 ${deviceId} 离线` } };
    }
    const startedAt = Date.now();
    try {
      const result = await entry.adapter.invoke(action, params);
      return {
        ...result,
        elapsedMs: result.elapsedMs ?? Date.now() - startedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "ADAPTER_THROW",
          message: err instanceof Error ? err.message : String(err),
        },
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * 打开一条数据流。返回 (streamId, asyncIterable)。
   * 调用方按需消费 chunks；流自然结束或出错时自动关闭。
   */
  openStream(
    deviceId: string,
    params: Record<string, unknown>,
  ): { ok: boolean; streamId?: string; stream?: AsyncIterable<DeviceStreamChunk>; error?: { code: string; message: string } } {
    const entry = this.byDeviceId.get(deviceId);
    if (!entry) {
      return { ok: false, error: { code: "DEVICE_NOT_FOUND", message: `设备 ${deviceId} 未注册` } };
    }
    if (entry.descriptor.status === "offline") {
      return { ok: false, error: { code: "DEVICE_OFFLINE", message: `设备 ${deviceId} 离线` } };
    }
    const streamId = `${deviceId}#${++entry.streamSeq}`;
    const stream = entry.adapter.openStream(streamId, params);
    return { ok: true, streamId, stream };
  }

  // ---------- 事件订阅 ----------

  /** 订阅设备变更事件。返回取消订阅函数。 */
  subscribe(listener: DeviceChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DeviceChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响注册表状态；后续可加 app.log.warn
      }
    }
  }

  // ---------- 索引维护 ----------

  private indexOwner(ownerUserId: string, deviceId: string): void {
    let set = this.byOwner.get(ownerUserId);
    if (!set) {
      set = new Set();
      this.byOwner.set(ownerUserId, set);
    }
    set.add(deviceId);
  }

  private unindexOwner(ownerUserId: string, deviceId: string): void {
    const set = this.byOwner.get(ownerUserId);
    if (!set) return;
    set.delete(deviceId);
    if (set.size === 0) this.byOwner.delete(ownerUserId);
  }

  private indexCapability(capability: CapabilityId, deviceId: string): void {
    let set = this.byCapability.get(capability);
    if (!set) {
      set = new Set();
      this.byCapability.set(capability, set);
    }
    set.add(deviceId);
  }

  private unindexCapability(capability: CapabilityId, deviceId: string): void {
    const set = this.byCapability.get(capability);
    if (!set) return;
    set.delete(deviceId);
    if (set.size === 0) this.byCapability.delete(capability);
  }
}

// ---------- 工具函数 ----------

async function safeDispose(adapter: DeviceAdapter): Promise<void> {
  try {
    await adapter.dispose();
  } catch {
    // 释放失败不阻塞后续注册
  }
}

/** 合并默认能力与设备声明能力，按 id 去重，设备声明优先。 */
function mergeCapabilities(
  defaults: CapabilityDeclaration[],
  declared: CapabilityDeclaration[],
): CapabilityDeclaration[] {
  const map = new Map<string, CapabilityDeclaration>();
  for (const cap of defaults) map.set(cap.id, cap);
  for (const cap of declared) map.set(cap.id, cap); // 覆盖默认
  return Array.from(map.values());
}
