// Agent Body Center — Skin 皮肤/触觉与环境传感器
//
// 职责（纯感知，无下行工具）：
//   1. 设备状态变化订阅 → body.skin.device_change 信号
//   2. 传感器读数流订阅 → body.skin.sensor_reading 信号
//   3. 感官查询：skin.devices / skin.sensor_history / skin.last_change
//
// 与人体器官对照：皮肤感知触压/温度/疼痛等体感信号；
// 在 Agent Body 中对应智能家居设备状态与传感器读数。
//
// 注：smart_home.control_device / smart_home.scene / smart_home.get_state /
//     device.sensor.read 等下行控制工具已移除，统一由 tools/smart-home-tools.ts /
//     tools/device-tools.ts 直接注册到 ToolRegistry（避免同一工具双注册互相覆盖）。
//
// 设计原则：
//   - 子系统缺失时优雅降级：smartHome / deviceRegistry 任一缺失时仅日志提示，不抛错
//   - async/await：所有 I/O 走 async/await，不依赖 callback
//   - 信号广播：感知事件发布 body.skin.* 信号到 BodyBus（AwarenessCortex 订阅消费）
//   - 资源释放：stop() 取消所有订阅与活跃的流消费任务

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodySignal,
} from "./types.js";

// ---- 外观接口（与具体实现解耦）-----------------------------------------

/**
 * 智能家居服务外观接口。
 *
 * 与 services/smart-home-service.ts 的 SmartHomeService 解耦：
 * Skin 只依赖此接口，便于测试 mock 与未来替换为非 HA 实现。
 */
export interface SmartHomeLike {
  /** 查询所有设备状态快照 */
  getAllStates?(): Promise<Record<string, Record<string, unknown>>>;
  /** 订阅设备状态变化事件；返回取消订阅函数 */
  onStateChange?(
    handler: (event: {
      entityId: string;
      oldState?: Record<string, unknown>;
      newState: Record<string, unknown>;
      domain?: string;
    }) => void,
  ): () => void;
}

/**
 * 设备注册表外观接口。
 *
 * 与 device-bus/device-registry.ts 的 DeviceRegistry 解耦：
 * 仅暴露 Skin 需要的流订阅能力。
 */
export interface DeviceRegistryLike {
  /** 按能力前缀列出设备（如 "sensor." 命中所有传感器） */
  listByCapability?(cap: string): Array<{ deviceId: string; kind: string }>;
  /** 打开数据流；返回 AsyncIterable，调用方按需消费 */
  openStream?(
    deviceId: string,
    streamId: string,
    params: Record<string, unknown>,
  ): AsyncIterable<{ type: string; payload: Record<string, unknown> }>;
}

/**
 * Skin 依赖注入参数。
 */
export interface SkinDeps {
  bodyBus: BodyBus;
  smartHomeService?: SmartHomeLike;
  deviceRegistry?: DeviceRegistryLike;
}

// ---- Skin 主类 -------------------------------------------------

/**
 * 皮肤/触觉与环境传感器：智能家居 + 设备传感器感知入口。
 *
 * 与 BodyCenter 的关系：
 *  - BodyCenter 通过 setSkin(this) 注入
 *  - 无下行工具路由（act 仅返回不支持，感知事件走 BodyBus 上行）
 *
 * 信号广播（发布到 BodyBus）：
 *  - body.skin.device_change：设备状态变化（来自 smartHome.onStateChange）
 *  - body.skin.sensor_reading：传感器读数（来自 deviceRegistry.openStream）
 */
export class Skin implements BodyModuleLike {
  readonly name = "skin" as const;
  readonly label = "皮肤/触觉与环境传感器";
  readonly tools: string[] = [];

  private readonly bodyBus: BodyBus;
  private readonly smartHome?: SmartHomeLike;
  private readonly deviceRegistry?: DeviceRegistryLike;

  private online = false;
  private lastActivityAt: string | null = null;

  // 事件订阅取消函数列表（onStateChange 等）
  private unsubscribers: Array<() => void> = [];
  // 活跃的传感器流迭代器；stop() 时调用 return() 取消
  private streamIterators: AsyncIterator<{
    type: string;
    payload: Record<string, unknown>;
  }>[] = [];

  constructor(deps: SkinDeps) {
    this.bodyBus = deps.bodyBus;
    this.smartHome = deps.smartHomeService;
    this.deviceRegistry = deps.deviceRegistry;
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  /**
   * 启动体感皮层：
   *  - 标记 online=true
   *  - smartHome 可用且有 onStateChange：订阅设备状态变化 → body.skin.device_change
   *  - deviceRegistry 可用且有 openStream：订阅 sensor.* 设备的流 → body.skin.sensor_reading
   */
  async start(): Promise<void> {
    if (this.online) {
      console.log("[Skin] 已启动，跳过重复 start");
      return;
    }
    console.log("[Skin] 正在启动...");

    // 1. 订阅智能家居设备状态变化
    if (this.smartHome?.onStateChange) {
      try {
        const unsubscribe = this.smartHome.onStateChange((event) => {
          this.markActivity();
          this.bodyBus.publish({
            kind: "body.skin.device_change",
            module: "skin",
            payload: {
              entityId: event.entityId,
              oldState: event.oldState,
              newState: event.newState,
              domain: event.domain,
            },
            timestamp: new Date().toISOString(),
          });
        });
        this.unsubscribers.push(unsubscribe);
        console.log("[Skin] 已订阅 smartHome.onStateChange");
      } catch (err) {
        console.log(`[Skin] 订阅 smartHome.onStateChange 失败（降级）: ${err}`);
      }
    } else if (this.smartHome) {
      console.log("[Skin] smartHome 提供，但未实现 onStateChange，跳过状态订阅");
    }

    // 2. 订阅 sensor.* 设备的数据流
    if (this.deviceRegistry?.openStream && this.deviceRegistry.listByCapability) {
      try {
        const sensors = this.deviceRegistry.listByCapability("sensor.");
        for (const sensor of sensors) {
          this.startSensorStream(sensor.deviceId);
        }
        console.log(`[Skin] 已订阅 ${sensors.length} 个 sensor.* 设备的数据流`);
      } catch (err) {
        console.log(`[Skin] 订阅 sensor.* 设备流失败（降级）: ${err}`);
      }
    } else if (this.deviceRegistry) {
      console.log(
        "[Skin] deviceRegistry 提供，但未实现 openStream/listByCapability，跳过流订阅",
      );
    }

    this.online = true;
    console.log("[Skin] 启动完成");
  }

  /** 内部：启动单个传感器设备的流消费 */
  private startSensorStream(deviceId: string): void {
    if (!this.deviceRegistry?.openStream) return;
    let stream: AsyncIterable<{ type: string; payload: Record<string, unknown> }>;
    try {
      stream = this.deviceRegistry.openStream(deviceId, "sensor", {});
    } catch (err) {
      console.log(`[Skin] openStream 失败 device=${deviceId} err=${err}`);
      return;
    }
    const iter = stream[Symbol.asyncIterator]();
    this.streamIterators.push(iter);
    void this.consumeSensorStream(deviceId, iter);
  }

  /** 消费传感器流，逐块发布 body.skin.sensor_reading 信号 */
  private async consumeSensorStream(
    deviceId: string,
    iter: AsyncIterator<{ type: string; payload: Record<string, unknown> }>,
  ): Promise<void> {
    try {
      while (true) {
        const result = await iter.next();
        if (result.done) break;
        const chunk = result.value;
        this.markActivity();
        this.bodyBus.publish({
          kind: "body.skin.sensor_reading",
          module: "skin",
          payload: {
            deviceId,
            type: chunk.type,
            payload: chunk.payload,
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.log(`[Skin] 传感器流异常 device=${deviceId} err=${err}`);
    }
  }

  /**
   * 停止体感皮层：
   *  - 取消所有事件订阅
   *  - 取消所有活跃的传感器流消费
   *  - 标记 online=false
   */
  async stop(): Promise<void> {
    if (!this.online) {
      console.log("[Skin] 未启动，跳过 stop");
      return;
    }
    console.log("[Skin] 正在停止...");

    // 1. 取消事件订阅
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        console.log(`[Skin] 取消订阅异常（忽略）: ${err}`);
      }
    }
    this.unsubscribers = [];

    // 2. 取消活跃的传感器流（调用迭代器 return 触发流终止）
    for (const iter of this.streamIterators) {
      try {
        await iter.return?.();
      } catch (err) {
        console.log(`[Skin] 关闭流迭代器异常（忽略）: ${err}`);
      }
    }
    this.streamIterators = [];

    this.online = false;
    console.log("[Skin] 已停止");
  }

  // ─── 动作执行 ────────────────────────────────────────────────

  /**
   * Skin 已无下行工具（控制类工具由 tools/smart-home-tools.ts 等直接承接）。
   * 保留 act 以满足 BodyModuleLike 接口；万一被路由到时优雅返回。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    return {
      ok: false,
      result: {},
      errorMessage: `skin is sense-only; tool not routed here: ${action.tool ?? "(none)"}`,
    };
  }

  // ─── 感官查询 ────────────────────────────────────────────────

  /**
   * 感官查询：返回体感皮层当前感知。
   *
   * - skin.devices        → 所有设备状态快照
   * - skin.sensor_history → 最近 N 条 sensor_reading 信号
   * - skin.last_change    → 最近一次 device_change 信号
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const params = query.params ?? {};

    if (query.kind === "skin.devices") {
      if (!this.smartHome || !this.smartHome.getAllStates) {
        return {
          ok: false,
          data: { error: "subsystem_unavailable:smartHome.getAllStates" },
          module: "skin",
          errorMessage: "subsystem_unavailable:smartHome.getAllStates",
        };
      }
      try {
        const states = await this.smartHome.getAllStates();
        return {
          ok: true,
          data: { states, count: Object.keys(states).length },
          module: "skin",
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          data: { error: errMsg },
          module: "skin",
          errorMessage: errMsg,
        };
      }
    }

    if (query.kind === "skin.sensor_history") {
      const limitRaw = Number(params.limit ?? 20);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 20;
      const recent = this.bodyBus.getRecentSignals(limit * 4);
      const readings = recent
        .filter((s) => s.kind === "body.skin.sensor_reading")
        .slice(-limit);
      return {
        ok: true,
        data: { readings, count: readings.length },
        module: "skin",
      };
    }

    if (query.kind === "skin.last_change") {
      const recent = this.bodyBus.getRecentSignals(200);
      let last: BodySignal | null = null;
      for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].kind === "body.skin.device_change") {
          last = recent[i];
          break;
        }
      }
      return {
        ok: true,
        data: { change: last },
        module: "skin",
      };
    }

    return {
      ok: false,
      data: { error: `unknown_query:${query.kind}` },
      module: "skin",
      errorMessage: `unknown_query:${query.kind}`,
    };
  }

  // ─── 快照 ────────────────────────────────────────────────────

  snapshot(): BodyModuleSnapshot {
    const subsystems: string[] = [];
    if (this.smartHome) subsystems.push("smart-home");
    if (this.deviceRegistry) subsystems.push("device-registry");
    return {
      name: "skin",
      label: this.label,
      tools: [...this.tools],
      online: this.online,
      subsystems,
      lastActivityAt: this.lastActivityAt,
      metadata: {},
    };
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  /** 标记最近一次活动时间 */
  private markActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }
}
