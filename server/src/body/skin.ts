// Agent Body Center — Skin 皮肤/体感传感器
//
// 职责（纯感知，无下行工具、无感官查询）：
//   订阅智能家居设备状态变化 → body.skin.device_change 信号
//   （消费方：AwarenessCortex 活动推断 / RhythmCore 活跃标记 / HomeostasisCore 活动量估算）
//
// 与人体器官对照：皮肤感知触压/温度等体感信号；
// 在 Agent Body 中对应智能家居设备状态变化。
//
// 注：
//   - smart_home.* 下行控制工具由 tools/smart-home-tools.ts 直接注册到 ToolRegistry
//     （避免同一工具双注册互相覆盖）。
//   - 传感器数据流订阅已移除：body.skin.sensor_reading 此前无任何消费方，
//     传感器数据由 tools/device-tools.ts 按需读取。
//
// 设计原则：
//   - 子系统缺失时优雅降级：smartHome 缺失时仅日志提示，不抛错
//   - 信号广播：感知事件发布 body.skin.device_change 信号到 BodyBus
//   - 资源释放：stop() 取消所有订阅

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
} from "./types.js";

// ---- 外观接口（与具体实现解耦）-----------------------------------------

/**
 * 智能家居服务外观接口。
 *
 * 与 services/smart-home-service.ts 的 SmartHomeService 解耦：
 * Skin 只依赖此接口，便于测试 mock 与未来替换为非 HA 实现。
 */
export interface SmartHomeLike {
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
 * Skin 依赖注入参数。
 */
export interface SkinDeps {
  bodyBus: BodyBus;
  smartHomeService?: SmartHomeLike;
}

// ---- Skin 主类 -------------------------------------------------

/**
 * 皮肤/体感传感器：智能家居设备状态感知入口。
 *
 * 与 BodyCenter 的关系：
 *  - BodyCenter 通过 setSkin(this) 注入
 *  - 无下行工具路由（act 仅返回不支持，感知事件走 BodyBus 上行）
 */
export class Skin implements BodyModuleLike {
  readonly name = "skin" as const;
  readonly label = "皮肤/体感传感器";
  readonly tools: string[] = [];

  private readonly bodyBus: BodyBus;
  private readonly smartHome?: SmartHomeLike;

  private online = false;
  private lastActivityAt: string | null = null;

  // 事件订阅取消函数列表（onStateChange 等）
  private unsubscribers: Array<() => void> = [];

  constructor(deps: SkinDeps) {
    this.bodyBus = deps.bodyBus;
    this.smartHome = deps.smartHomeService;
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  /**
   * 启动体感皮层：
   *  - 标记 online=true
   *  - smartHome 可用且有 onStateChange：订阅设备状态变化 → body.skin.device_change
   */
  async start(): Promise<void> {
    if (this.online) {
      console.log("[Skin] 已启动，跳过重复 start");
      return;
    }
    console.log("[Skin] 正在启动...");

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

    this.online = true;
    console.log("[Skin] 启动完成");
  }

  /**
   * 停止体感皮层：取消所有事件订阅，标记 online=false。
   */
  async stop(): Promise<void> {
    if (!this.online) {
      console.log("[Skin] 未启动，跳过 stop");
      return;
    }
    console.log("[Skin] 正在停止...");

    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        console.log(`[Skin] 取消订阅异常（忽略）: ${err}`);
      }
    }
    this.unsubscribers = [];

    this.online = false;
    console.log("[Skin] 已停止");
  }

  // ─── 动作执行 ────────────────────────────────────────────────

  /**
   * Skin 无下行工具（控制类工具由 tools/smart-home-tools.ts 等直接承接）。
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

  /** Skin 无感官查询（设备状态走 smart_home.get_state 工具按需读取）。 */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
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
