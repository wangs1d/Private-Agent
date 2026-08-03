// Agent Body Center —— VestibularApparatus 前庭器/平衡器官
//
// 职责：
//  1. 维护 Agent 在多设备上的"渲染存在"状态（哪台设备正在显示球形身体 / 当前情绪）
//  2. 路由 embodiment.* 工具族到 emitEmbodimentPatch / pushEmbodimentCommand
//  3. 设备上下线时切换渲染主体，发布 body.vestibular.device_switch 信号
//  4. 提供 where_am_i / vestibular.devices 两种 sense 查询
//
// 设计原则：
//  - 子系统缺失时优雅降级：wsRegistry 不可用 -> ok=false + errorMessage
//  - 不持有 LLM，所有智能判断在 BrainCenter 侧
//  - BodyBus 信号 fire-and-forget，不阻塞 act
//  - EmbodimentMood / EmbodimentPatch / emitEmbodimentPatch / EmbodimentCommand 复用
//    agent-embodiment.ts 中已有实现，不重复造轮子（pushEmbodimentCommand 因依赖
//    具体 WsConnectionRegistry 类型，本模块改用 WsRegistryLike.trySend 直接发送）

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyToolRegistry,
} from "./types.js";
import {
  emitEmbodimentPatch,
  type EmbodimentCommand,
  type EmbodimentMood,
  type EmbodimentPatch,
} from "../services/agent-embodiment.js";

// ---- 外观接口（解耦具体 WsConnectionRegistry / EmbodimentAutonomyService）--

/** WsConnectionRegistry 的最小外观：只需 trySend 即可 */
export interface WsRegistryLike {
  trySend(sessionId: string, json: string): boolean;
}

/** EmbodimentAutonomyService 的最小外观：仅需 onPatch 等可选方法 */
export interface EmbodimentAutonomyLike {
  onPatch?(sessionId: string, patch: EmbodimentPatch, send?: (json: string) => void): void;
  registerSession?(sessionId: string): void;
  unregisterSession?(sessionId: string): void;
  setProcessing?(
    sessionId: string,
    processing: boolean,
    send?: (json: string) => void,
  ): void;
}

/** VestibularApparatus 构造依赖 */
export interface VestibularApparatusDeps {
  bodyBus: BodyBus;
  wsRegistry?: WsRegistryLike;
  embodimentAutonomy?: EmbodimentAutonomyLike;
}

// ---- 设备存在状态 ------------------------------------------------------

/** 单台设备上 Agent 形象的渲染状态 */
export interface DevicePresence {
  /** 设备 id，如 "desktop" / "phone" / "glasses" / "tablet" */
  deviceId: string;
  /** 设备大类，与 device-bus DeviceKind 对齐 */
  kind: string;
  /** 是否在线 */
  online: boolean;
  /** 该设备是否正在渲染 agent 形象 */
  rendering: boolean;
  /** 当前情绪基调 */
  mood: EmbodimentMood;
  /** 屏幕短文案 */
  caption: string | null;
  /** 屏幕归一化坐标（window_place 用），0-1 */
  screenX?: number;
  screenY?: number;
  /** 3D 场景坐标（roam/move 用） */
  x?: number;
  y?: number;
  z?: number;
  /** 最后更新时间 ISO */
  lastUpdatedAt: string;
}

// ---- 辅助函数 ----------------------------------------------------------

/** 当前 ISO 时间戳 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 安全 clamp 数值到 [min, max] */
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 合法 mood 枚举校验 */
const VALID_MOODS: EmbodimentMood[] = [
  "idle",
  "listening",
  "thinking",
  "happy",
  "alert",
];

function normalizeMood(raw: unknown): EmbodimentMood {
  if (typeof raw === "string" && VALID_MOODS.includes(raw as EmbodimentMood)) {
    return raw as EmbodimentMood;
  }
  return "idle";
}

// ---- VestibularApparatus 主类 --------------------------------------------

/**
 * 前庭器/平衡器官 —— 维护 Agent 在多设备上的渲染存在与位置。
 *
 * 与人体前庭神经对照：
 *  - 人耳前庭掌管平衡 / 空间定位
 *  - Agent 前庭掌管"我此刻在哪台设备上 / 在屏幕哪个位置 / 是什么姿态"
 */
export class VestibularApparatus implements BodyModuleLike {
  readonly name = "vestibular" as const;
  readonly label = "前庭器/平衡器官";
  readonly tools = [
    "embodiment.roam",
    "embodiment.move",
    "embodiment.stop",
    "embodiment.set_state",
    "embodiment.excite",
    "embodiment.window_roam",
    "embodiment.window_place",
    "embodiment.observe",
  ];

  private readonly bodyBus: BodyBus;
  private readonly wsRegistry: WsRegistryLike | null;
  private readonly embodimentAutonomy: EmbodimentAutonomyLike | null;

  /** 已知设备表：deviceId -> DevicePresence。初始含 desktop / phone 两条 */
  private readonly devices = new Map<string, DevicePresence>();

  /** 模块是否已启动 */
  private started = false;

  /** 最近一次活动时间（ISO），无活动时为 null */
  private lastActivityAt: string | null = null;

  /** 取消 embodimentAutonomy patch 订阅的函数（如未来扩展需要） */
  private unsubscribeAutonomy: (() => void) | null = null;

  constructor(deps: VestibularApparatusDeps) {
    this.bodyBus = deps.bodyBus;
    this.wsRegistry = deps.wsRegistry ?? null;
    this.embodimentAutonomy = deps.embodimentAutonomy ?? null;

    // 初始化 desktop / phone 两条占位记录
    const now = nowIso();
    this.devices.set("desktop", {
      deviceId: "desktop",
      kind: "desktop",
      online: true,
      rendering: true,
      mood: "idle",
      caption: null,
      lastUpdatedAt: now,
    });
    this.devices.set("phone", {
      deviceId: "phone",
      kind: "phone",
      online: true,
      rendering: false,
      mood: "idle",
      caption: null,
      lastUpdatedAt: now,
    });
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  /**
   * 启动模块。
   *
   * 当前实现：标记 started=true；若 embodimentAutonomy 可用，
   * 订阅 BodyBus 上的 body.vestibular.* 信号（便于后续扩展自主意识联动）。
   */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[VestibularApparatus] 已启动，跳过重复 start");
      return;
    }
    console.log("[VestibularApparatus] 正在启动...");
    this.started = true;

    // 若 embodimentAutonomy 可用，订阅 vestibular 自身的 moved 信号做后续联动
    // 当前留作占位：自主意识已在 emitEmbodimentPatch 内部被 onPatch 触发，
    // 此处仅作日志采样，便于调试
    try {
      this.unsubscribeAutonomy = this.bodyBus.subscribe(
        "body.vestibular.*",
        (signal) => {
          if (!this.embodimentAutonomy) return;
          // 仅日志，不阻塞信号通路
          console.log(
            `[VestibularApparatus] 自主意识采样 signal=${signal.kind} ` +
              `payload=${JSON.stringify(signal.payload).slice(0, 80)}`,
          );
        },
      );
    } catch (err) {
      console.log(`[VestibularApparatus] 订阅 body.vestibular.* 失败（不阻断）: ${err}`);
    }

    console.log("[VestibularApparatus] 启动完成");
  }

  /**
   * 停止模块：取消自主意识订阅，标记 started=false。
   */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[VestibularApparatus] 未启动，跳过 stop");
      return;
    }
    console.log("[VestibularApparatus] 正在停止...");
    if (this.unsubscribeAutonomy) {
      try {
        this.unsubscribeAutonomy();
      } catch {
        // 取消订阅失败不阻断
      }
      this.unsubscribeAutonomy = null;
    }
    this.started = false;
    console.log("[VestibularApparatus] 已停止");
  }

  // ─── 工具执行 ────────────────────────────────────────────────

  /**
   * 执行 embodiment.* 工具调用。
   *
   * 按 action.tool 路由：
   *  - embodiment.window_place -> emitEmbodimentPatch + screenX/screenY
   *  - embodiment.set_state    -> emitEmbodimentPatch mood/energy/caption
   *  - embodiment.roam / move / stop / excite / window_roam -> pushEmbodimentCommand
   *  - embodiment.observe      -> 返回当前渲染设备状态快照
   *
   * wsRegistry 不可用时返回 ok=false + errorMessage="ws registry offline"。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    const startTime = Date.now();
    const tool = action.tool;
    const args = action.args ?? {};
    const sessionId =
      typeof args.sessionId === "string"
        ? args.sessionId
        : (action.actorId ?? "");
    const deviceId =
      typeof args.deviceId === "string" ? args.deviceId : "desktop";

    try {
      switch (tool) {
        case "embodiment.window_place":
          return await this.actWindowPlace(sessionId, deviceId, args, startTime);
        case "embodiment.set_state":
          return await this.actSetState(sessionId, deviceId, args, startTime);
        case "embodiment.roam":
          return await this.actCommand(
            sessionId,
            deviceId,
            {
              action: "roam",
              strength:
                typeof args.strength === "number" && Number.isFinite(args.strength)
                  ? clamp(args.strength, 0.2, 2)
                  : 1,
              source: "tool:embodiment.roam",
            },
            startTime,
          );
        case "embodiment.move":
          return await this.actMove(sessionId, deviceId, args, startTime);
        case "embodiment.stop":
          return await this.actCommand(
            sessionId,
            deviceId,
            { action: "stop", source: "tool:embodiment.stop" },
            startTime,
          );
        case "embodiment.excite":
          return await this.actCommand(
            sessionId,
            deviceId,
            {
              action: "excite",
              strength:
                typeof args.strength === "number" && Number.isFinite(args.strength)
                  ? clamp(args.strength, 0.5, 2)
                  : 1.4,
              source: "tool:embodiment.excite",
            },
            startTime,
          );
        case "embodiment.window_roam":
          return await this.actCommand(
            sessionId,
            deviceId,
            { action: "window_roam", source: "tool:embodiment.window_roam" },
            startTime,
          );
        case "embodiment.observe":
          return await this.actObserve(deviceId, startTime);
        default:
          return {
            ok: false,
            result: { error: `unknown_tool:${tool}` },
            errorMessage: `unknown_tool:${tool}`,
            durationMs: Date.now() - startTime,
          };
      }
    } catch (err) {
      const errMsg = String(err).slice(0, 120);
      console.log(`[VestibularApparatus] act 异常 tool=${tool} err=${errMsg}`);
      return {
        ok: false,
        result: { error: errMsg },
        errorMessage: errMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** embodiment.window_place —— 屏幕归一化坐标 */
  private async actWindowPlace(
    sessionId: string,
    deviceId: string,
    args: Record<string, unknown>,
    startTime: number,
  ): Promise<BodyActionResult> {
    const screenX =
      typeof args.screenX === "number" && Number.isFinite(args.screenX)
        ? clamp(args.screenX, 0, 1)
        : undefined;
    const screenY =
      typeof args.screenY === "number" && Number.isFinite(args.screenY)
        ? clamp(args.screenY, 0, 1)
        : undefined;
    if (screenX === undefined || screenY === undefined) {
      return {
        ok: false,
        result: { error: "需要 screenX 与 screenY（0～1）" },
        errorMessage: "需要 screenX 与 screenY（0～1）",
        durationMs: Date.now() - startTime,
      };
    }

    if (!this.wsRegistry) {
      return this.offlineResult(
        { screenX, screenY },
        startTime,
      );
    }

    const patch: EmbodimentPatch = {
      mood: undefined,
      source: "tool:embodiment.window_place",
    };
    const delivered = this.sendPatch(sessionId, patch);
    // 同时下发 window_place 指令（与现有 embodiment-tools 保持一致）
    const cmdDelivered = this.sendCommand(sessionId, {
      action: "window_place",
      screenX,
      screenY,
      source: "tool:embodiment.window_place",
    });

    const ok = delivered || cmdDelivered;
    this.updateDevice(deviceId, {
      screenX,
      screenY,
      mood: undefined,
    });
    this.publishMoved(deviceId, { screenX, screenY });

    return {
      ok,
      result: { delivered: ok, screenX, screenY, deviceId },
      errorMessage: ok ? undefined : "ws registry offline",
      durationMs: Date.now() - startTime,
    };
  }

  /** embodiment.set_state —— 设置 mood/energy/caption */
  private async actSetState(
    sessionId: string,
    deviceId: string,
    args: Record<string, unknown>,
    startTime: number,
  ): Promise<BodyActionResult> {
    const mood = normalizeMood(args.mood);
    const energy =
      typeof args.energy === "number" && Number.isFinite(args.energy)
        ? clamp(args.energy, 0, 1)
        : undefined;
    const captionRaw = args.caption;
    const caption =
      captionRaw === "" || captionRaw === null
        ? null
        : typeof captionRaw === "string"
          ? captionRaw.slice(0, 120)
          : undefined;

    if (!this.wsRegistry) {
      return this.offlineResult({ mood, energy, caption }, startTime);
    }

    const patch: EmbodimentPatch = {
      mood,
      energy,
      caption,
      source: "tool:embodiment.set_state",
    };
    const delivered = this.sendPatch(sessionId, patch);
    this.updateDevice(deviceId, { mood, caption });
    this.publishMoved(deviceId, { mood });

    return {
      ok: delivered,
      result: { delivered, mood, energy, caption, deviceId },
      errorMessage: delivered ? undefined : "ws registry offline",
      durationMs: Date.now() - startTime,
    };
  }

  /** embodiment.move —— 3D 场景坐标移动 */
  private async actMove(
    sessionId: string,
    deviceId: string,
    args: Record<string, unknown>,
    startTime: number,
  ): Promise<BodyActionResult> {
    const x = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : 0;
    const z = typeof args.z === "number" && Number.isFinite(args.z) ? args.z : 0;
    const y =
      typeof args.y === "number" && Number.isFinite(args.y)
        ? clamp(args.y, 0.8, 2.6)
        : 1.6;

    if (!this.wsRegistry) {
      return this.offlineResult({ x, y, z }, startTime);
    }

    const delivered = this.sendCommand(sessionId, {
      action: "move",
      x: clamp(x, -2.4, 2.4),
      y,
      z: clamp(z, -2.4, 2.4),
      source: "tool:embodiment.move",
    });
    this.updateDevice(deviceId, { x, y, z });

    return {
      ok: delivered,
      result: { delivered, x, y, z, deviceId },
      errorMessage: delivered ? undefined : "ws registry offline",
      durationMs: Date.now() - startTime,
    };
  }

  /** 通用 command 路由（roam / stop / excite / window_roam） */
  private async actCommand(
    sessionId: string,
    deviceId: string,
    command: EmbodimentCommand,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (!this.wsRegistry) {
      return this.offlineResult({ action: command.action }, startTime);
    }
    const delivered = this.sendCommand(sessionId, command);
    return {
      ok: delivered,
      result: {
        delivered,
        action: command.action,
        strength: command.strength,
        deviceId,
      },
      errorMessage: delivered ? undefined : "ws registry offline",
      durationMs: Date.now() - startTime,
    };
  }

  /** embodiment.observe —— 返回当前渲染设备状态快照 */
  private async actObserve(
    deviceId: string,
    startTime: number,
  ): Promise<BodyActionResult> {
    const device =
      this.devices.get(deviceId) ?? this.getCurrentRenderingDevice();
    if (!device) {
      return {
        ok: false,
        result: { error: "no_rendering_device" },
        errorMessage: "no_rendering_device",
        durationMs: Date.now() - startTime,
      };
    }
    return {
      ok: true,
      result: {
        device: device.deviceId,
        screenX: device.screenX,
        screenY: device.screenY,
        x: device.x,
        y: device.y,
        z: device.z,
        mood: device.mood,
        caption: device.caption,
        rendering: device.rendering,
        online: device.online,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // ─── 感官查询 ────────────────────────────────────────────────

  /**
   * 感官查询。
   *
   * 支持的 query.kind：
   *  - "where_am_i"        -> 当前正在渲染的设备状态（rendering=true 的第一个）
   *  - "vestibular.devices"-> 所有 DevicePresence 列表
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind;
    if (kind === "where_am_i" || kind.startsWith("where_am_i")) {
      const device = this.getCurrentRenderingDevice();
      if (!device) {
        return {
          ok: false,
          data: { error: "no_rendering_device" },
          module: "vestibular",
          errorMessage: "no_rendering_device",
        };
      }
      return {
        ok: true,
        data: {
          device: device.deviceId,
          screenX: device.screenX,
          screenY: device.screenY,
          mood: device.mood,
          caption: device.caption,
          rendering: device.rendering,
        },
        module: "vestibular",
      };
    }
    if (kind === "vestibular.devices" || kind.startsWith("vestibular.devices")) {
      return {
        ok: true,
        data: { devices: this.listDevices() },
        module: "vestibular",
      };
    }
    return {
      ok: false,
      data: { error: `unknown_query:${kind}` },
      module: "vestibular",
      errorMessage: `unknown_query:${kind}`,
    };
  }

  // ─── 快照 ────────────────────────────────────────────────────

  /**
   * 模块快照。
   *
   * metadata 字段含：
   *  - devices: 全部 DevicePresence 列表
   *  - currentDevice: 当前渲染设备 id（供 BodyGateway 聚合到 state.currentDevice）
   *  - mood: 当前渲染设备 mood（P0-3: 渲染态/fallback；权威 mood 来源已迁至 HomeostasisCore，
   *          body-gateway 在 homeostasis mood 不可用时取此值）
   *  - rendering: 是否正在渲染（供 BodyGateway 聚合到 state.rendering）
   */
  snapshot(): BodyModuleSnapshot {
    const renderingDevice = this.getCurrentRenderingDevice();
    return {
      name: "vestibular",
      label: this.label,
      tools: [...this.tools],
      online: this.started,
      subsystems: [],
      lastActivityAt: this.lastActivityAt,
      metadata: {
        devices: this.listDevices(),
        currentDevice: renderingDevice?.deviceId,
        mood: renderingDevice?.mood,
        rendering: Boolean(renderingDevice?.rendering),
      },
    };
  }

  // ─── 工具注册 ────────────────────────────────────────────────

  /**
   * 把 embodiment.roam / embodiment.move / embodiment.stop / embodiment.set_state /
   * embodiment.excite / embodiment.window_roam / embodiment.window_place /
   * embodiment.observe 工具挂到外部 ToolRegistry，handler 内部委托 this.act()。
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

  // ─── 设备上下线（供 device-bus 调用） ─────────────────────────

  /**
   * 设备上线时调用。
   * - 已存在：刷新 online=true / kind
   * - 新设备：插入一条 online 但 rendering=false 的记录
   */
  onDeviceOnline(deviceId: string, kind: string): void {
    const existing = this.devices.get(deviceId);
    const now = nowIso();
    if (existing) {
      existing.online = true;
      existing.kind = kind;
      existing.lastUpdatedAt = now;
      return;
    }
    this.devices.set(deviceId, {
      deviceId,
      kind,
      online: true,
      rendering: false,
      mood: "idle",
      caption: null,
      lastUpdatedAt: now,
    });
  }

  /**
   * 设备下线时调用。
   * - 若下线设备正在 rendering：把 rendering 标志迁移到下一个 online 设备
   * - 同时转移 mood / caption 到新设备
   * - 发布 body.vestibular.device_switch 信号（含 fromDevice / toDevice / mood / caption）
   */
  onDeviceOffline(deviceId: string): void {
    const cur = this.devices.get(deviceId);
    if (!cur) return;
    const wasRendering = cur.rendering;
    cur.online = false;
    cur.rendering = false;
    cur.lastUpdatedAt = nowIso();

    if (!wasRendering) return;

    // 找下一个 online 且非当前的设备作为渲染主体
    let next: DevicePresence | null = null;
    for (const d of this.devices.values()) {
      if (d.deviceId === deviceId) continue;
      if (d.online) {
        next = d;
        break;
      }
    }
    if (!next) {
      // 没有备选设备：仅发布信号，标记当前无渲染
      this.publishDeviceSwitch(deviceId, null, cur.mood, cur.caption);
      return;
    }
    next.rendering = true;
    next.mood = cur.mood;
    next.caption = cur.caption;
    next.lastUpdatedAt = nowIso();
    this.lastActivityAt = nowIso();
    this.publishDeviceSwitch(deviceId, next.deviceId, cur.mood, cur.caption);
  }

  /** 返回当前正在渲染的设备（rendering=true 的第一个），无则 null */
  getCurrentRenderingDevice(): DevicePresence | null {
    for (const d of this.devices.values()) {
      if (d.rendering && d.online) return d;
    }
    // 退化：online 但 rendering 标志丢失时返回第一个 online 设备
    for (const d of this.devices.values()) {
      if (d.online) return d;
    }
    return null;
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  /** 列出所有 DevicePresence（浅拷贝，避免外部篡改） */
  private listDevices(): DevicePresence[] {
    return Array.from(this.devices.values()).map((d) => ({ ...d }));
  }

  /** 发送 embodiment patch（走 emitEmbodimentPatch，触发 autonomy.onPatch） */
  private sendPatch(sessionId: string, patch: EmbodimentPatch): boolean {
    if (!this.wsRegistry) return false;
    const send = (json: string): void => {
      this.wsRegistry?.trySend(sessionId, json);
    };
    try {
      emitEmbodimentPatch(send, sessionId, patch);
      return true;
    } catch (err) {
      console.log(`[VestibularApparatus] sendPatch 异常: ${err}`);
      return false;
    }
  }

  /** 发送 embodiment command（通过 WsRegistryLike.trySend，与 pushEmbodimentCommand 行为等价） */
  private sendCommand(sessionId: string, command: EmbodimentCommand): boolean {
    if (!this.wsRegistry) return false;
    try {
      // pushEmbodimentCommand 依赖具体 WsConnectionRegistry 类型，
      // 此处通过 WsRegistryLike 外观直接组装同款 JSON 并调用 trySend
      const json = JSON.stringify({
        type: "agent.embodiment.command",
        payload: { sessionId, ...command },
      });
      return this.wsRegistry.trySend(sessionId, json);
    } catch (err) {
      console.log(`[VestibularApparatus] sendCommand 异常: ${err}`);
      return false;
    }
  }

  /** 更新指定设备的部分字段（不存在则忽略） */
  private updateDevice(
    deviceId: string,
    patch: Partial<
      Pick<
        DevicePresence,
        "screenX" | "screenY" | "x" | "y" | "z" | "mood" | "caption"
      >
    >,
  ): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    if (patch.screenX !== undefined) d.screenX = patch.screenX;
    if (patch.screenY !== undefined) d.screenY = patch.screenY;
    if (patch.x !== undefined) d.x = patch.x;
    if (patch.y !== undefined) d.y = patch.y;
    if (patch.z !== undefined) d.z = patch.z;
    if (patch.mood !== undefined) d.mood = patch.mood;
    if (patch.caption !== undefined) d.caption = patch.caption;
    d.lastUpdatedAt = nowIso();
    this.lastActivityAt = d.lastUpdatedAt;
  }

  /** 发布 body.vestibular.moved 信号 */
  private publishMoved(
    deviceId: string,
    extra: { screenX?: number; screenY?: number; mood?: EmbodimentMood },
  ): void {
    const device = this.devices.get(deviceId);
    this.bodyBus.publish({
      kind: "body.vestibular.moved",
      module: "vestibular",
      payload: {
        device: deviceId,
        screenX: extra.screenX ?? device?.screenX,
        screenY: extra.screenY ?? device?.screenY,
        mood: extra.mood ?? device?.mood,
      },
      timestamp: nowIso(),
    });
  }

  /** 发布 body.vestibular.device_switch 信号 */
  private publishDeviceSwitch(
    fromDevice: string,
    toDevice: string | null,
    mood: EmbodimentMood,
    caption: string | null,
  ): void {
    this.bodyBus.publish({
      kind: "body.vestibular.device_switch",
      module: "vestibular",
      payload: {
        fromDevice,
        toDevice,
        mood,
        caption,
      },
      timestamp: nowIso(),
    });
  }

  /** wsRegistry 不可用时的统一兜底返回 */
  private offlineResult(
    extra: Record<string, unknown>,
    startTime: number,
  ): BodyActionResult {
    return {
      ok: false,
      result: { delivered: false, ...extra },
      errorMessage: "ws registry offline",
      durationMs: Date.now() - startTime,
    };
  }
}
