// Agent Body Center — Skin 皮肤/触觉与环境传感器
//
// 职责：
//   1. 智能家居控制：smart_home.control_device / smart_home.scene / smart_home.get_state
//   2. 设备传感器读取：device.sensor.read
//   3. 设备状态变化订阅 → body.skin.device_change 信号
//   4. 传感器读数流订阅 → body.skin.sensor_reading 信号
//
// 与人体器官对照：皮肤感知触压/温度/疼痛等体感信号；
// 在 Agent Body 中对应智能家居设备状态与传感器读数。
//
// 设计原则：
//   - 子系统缺失时优雅降级：smartHome / deviceRegistry 任一缺失时仅日志提示，不抛错
//   - async/await：所有 I/O 走 async/await，不依赖 callback
//   - 信号广播：所有动作执行后发布 body.skin.* 信号到 BodyBus
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
  BodyToolRegistry,
} from "./types.js";

// ---- 外观接口（与具体实现解耦）-----------------------------------------

/**
 * 智能家居服务外观接口。
 *
 * 与 services/smart-home-service.ts 的 SmartHomeService 解耦：
 * Skin 只依赖此接口，便于测试 mock 与未来替换为非 HA 实现。
 */
export interface SmartHomeLike {
  /** 控制单个设备（开关/调亮度/调温度等） */
  controlDevice?(opts: {
    deviceId?: string;
    entityType?: string;
    entityId?: string;
    action?: string;
    params?: Record<string, unknown>;
  }): Promise<{ ok: boolean; state?: Record<string, unknown> }>;
  /** 激活场景 */
  activateScene?(sceneId: string): Promise<{ ok: boolean }>;
  /** 查询单个设备状态 */
  getState?(entityId: string): Promise<{ state: Record<string, unknown> } | null>;
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
 * 仅暴露 Skin 需要的查询/调用/流订阅能力。
 */
export interface DeviceRegistryLike {
  /** 按能力前缀列出设备（如 "sensor." 命中所有传感器） */
  listByCapability?(cap: string): Array<{ deviceId: string; kind: string }>;
  /** 调用设备的某个 action */
  invoke(
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown }>;
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
 * 皮肤/触觉与环境传感器：智能家居 + 设备传感器入口。
 *
 * 与 BodyCenter 的关系：
 *  - BodyCenter 通过 setSkin(this) 注入
 *  - BodyGateway 通过 registerModule + registerToolRoute("smart_home." → skin) 路由
 *
 * 信号广播（发布到 BodyBus）：
 *  - body.skin.device_change：设备状态变化（来自 smartHome.onStateChange）
 *  - body.skin.sensor_reading：传感器读数（来自 deviceRegistry.openStream）
 *  - body.skin.device_control：control_device 动作执行后
 *  - body.skin.scene_activated：scene 动作执行后
 *  - body.skin.state_query：get_state 动作执行后
 *  - body.skin.sensor_read：sensor.read 动作执行后
 */
export class Skin implements BodyModuleLike {
  readonly name = "skin" as const;
  readonly label = "皮肤/触觉与环境传感器";
  readonly tools = [
    "smart_home.control_device",
    "smart_home.scene",
    "smart_home.get_state",
    "device.sensor.read",
  ];

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
   * 执行动作：按 action.tool 分发到对应子系统。
   *
   * - smart_home.control_device → smartHome.controlDevice
   * - smart_home.scene          → smartHome.activateScene
   * - smart_home.get_state      → smartHome.getState
   * - device.sensor.read        → deviceRegistry.invoke(deviceId, "sensor.read", params)
   *
   * 未识别的 tool 返回 ok=false + tool_not_supported。
   * 子系统缺失时返回 ok=false + subsystem_unavailable。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    const startedAt = Date.now();
    const args = action.args ?? {};

    try {
      switch (action.tool) {
        case "smart_home.control_device":
          return await this.actControlDevice(args, startedAt);
        case "smart_home.scene":
          return await this.actScene(args, startedAt);
        case "smart_home.get_state":
          return await this.actGetState(args, startedAt);
        case "device.sensor.read":
          return await this.actSensorRead(args, startedAt);
        default:
          return {
            ok: false,
            result: { error: `tool_not_supported:${action.tool}` },
            errorMessage: `tool_not_supported:${action.tool}`,
            durationMs: Date.now() - startedAt,
          };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[Skin] act 异常 tool=${action.tool} err=${errMsg}`);
      return {
        ok: false,
        result: { error: errMsg },
        errorMessage: errMsg,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** smart_home.control_device：委托 smartHome.controlDevice */
  private async actControlDevice(
    args: Record<string, unknown>,
    startedAt: number,
  ): Promise<BodyActionResult> {
    if (!this.smartHome || !this.smartHome.controlDevice) {
      return this.unavailable("smart_home.control_device", startedAt);
    }
    const entityId = this.pickString(args, ["entityId", "entity_id"]);
    const actionStr = this.pickString(args, ["action"]);
    const result = await this.smartHome.controlDevice({
      deviceId: this.pickString(args, ["deviceId", "device_id"]),
      entityType: this.pickString(args, ["entityType", "entity_type"]),
      entityId,
      action: actionStr,
      params: args,
    });
    this.publishSignal("body.skin.device_control", {
      tool: "smart_home.control_device",
      entityId,
      action: actionStr,
      result,
    });
    this.markActivity();
    return {
      ok: result.ok,
      result: { ...result } as Record<string, unknown>,
      durationMs: Date.now() - startedAt,
    };
  }

  /** smart_home.scene：委托 smartHome.activateScene */
  private async actScene(
    args: Record<string, unknown>,
    startedAt: number,
  ): Promise<BodyActionResult> {
    if (!this.smartHome || !this.smartHome.activateScene) {
      return this.unavailable("smart_home.scene", startedAt);
    }
    const sceneId = this.pickString(args, ["sceneId", "scene_name", "sceneName"]) ?? "";
    if (!sceneId) {
      return {
        ok: false,
        result: { error: "scene_id_required" },
        errorMessage: "scene_id_required",
        durationMs: Date.now() - startedAt,
      };
    }
    const result = await this.smartHome.activateScene(sceneId);
    this.publishSignal("body.skin.scene_activated", {
      tool: "smart_home.scene",
      sceneId,
      result,
    });
    this.markActivity();
    return {
      ok: result.ok,
      result: { sceneId, ...result } as Record<string, unknown>,
      durationMs: Date.now() - startedAt,
    };
  }

  /** smart_home.get_state：委托 smartHome.getState */
  private async actGetState(
    args: Record<string, unknown>,
    startedAt: number,
  ): Promise<BodyActionResult> {
    if (!this.smartHome || !this.smartHome.getState) {
      return this.unavailable("smart_home.get_state", startedAt);
    }
    const entityId = this.pickString(args, ["entityId", "entity_id"]) ?? "";
    if (!entityId) {
      return {
        ok: false,
        result: { error: "entity_id_required" },
        errorMessage: "entity_id_required",
        durationMs: Date.now() - startedAt,
      };
    }
    const state = await this.smartHome.getState(entityId);
    this.publishSignal("body.skin.state_query", {
      tool: "smart_home.get_state",
      entityId,
      state,
    });
    this.markActivity();
    return {
      ok: true,
      result: { entityId, state } as Record<string, unknown>,
      durationMs: Date.now() - startedAt,
    };
  }

  /** device.sensor.read：委托 deviceRegistry.invoke(deviceId, "sensor.read", params) */
  private async actSensorRead(
    args: Record<string, unknown>,
    startedAt: number,
  ): Promise<BodyActionResult> {
    if (!this.deviceRegistry) {
      return this.unavailable("device.sensor.read", startedAt);
    }
    const deviceId = this.pickString(args, ["deviceId", "device_id"]) ?? "";
    if (!deviceId) {
      return {
        ok: false,
        result: { error: "device_id_required" },
        errorMessage: "device_id_required",
        durationMs: Date.now() - startedAt,
      };
    }
    const params = (args.params as Record<string, unknown> | undefined) ?? {};
    const result = await this.deviceRegistry.invoke(deviceId, "sensor.read", params);
    this.publishSignal("body.skin.sensor_read", {
      tool: "device.sensor.read",
      deviceId,
      result,
    });
    this.markActivity();
    return {
      ok: result.ok,
      result: { deviceId, ...result } as Record<string, unknown>,
      durationMs: Date.now() - startedAt,
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

  // ─── 工具注册 ────────────────────────────────────────────────

  /**
   * 把 smart_home.control_device / smart_home.scene / smart_home.get_state /
   * device.sensor.read 工具挂到外部 ToolRegistry，handler 内部委托 this.act()。
   *
   * actorId 暂时无法获取（BodyToolRegistry 接口未传 context），保持 undefined。
   * 返回值：成功 { ok: true, ...result.result }；失败 { ok: false, error, ...result.result }。
   */
  registerTools(registry: BodyToolRegistry): void {
    for (const toolName of this.tools) {
      registry.register(toolName, async (input) => {
        const result = await this.act({
          tool: toolName,
          args: input,
          source: "body_module",
        });
        if (!result.ok) {
          return {
            ok: false,
            error:
              result.errorMessage ??
              result.reason ??
              "body module action failed",
            ...result.result,
          };
        }
        return { ok: true, ...result.result };
      });
    }
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  /** 发布 body.skin.* 信号到 BodyBus */
  private publishSignal(kind: string, payload: Record<string, unknown>): void {
    this.bodyBus.publish({
      kind,
      module: "skin",
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  /** 标记最近一次活动时间 */
  private markActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }

  /** 子系统缺失时返回标准错误 */
  private unavailable(tool: string, startedAt: number): BodyActionResult {
    return {
      ok: false,
      result: { error: `subsystem_unavailable:${tool}` },
      errorMessage: `subsystem_unavailable:${tool}`,
      durationMs: Date.now() - startedAt,
    };
  }

  /** 从 args 中按优先级取出字符串值（兼容 snake_case / camelCase） */
  private pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const val = args[key];
      if (typeof val === "string" && val.length > 0) return val;
      if (typeof val === "number" && Number.isFinite(val)) return String(val);
    }
    return undefined;
  }
}
