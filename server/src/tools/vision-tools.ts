import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { DeviceRegistry } from "../device-bus/device-registry.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type { VisionPeriodicScheduler } from "../vision/vision-periodic-scheduler.js";
import { fetchHttpVisionFrame } from "../vision/fetch-http-vision-frame.js";
import type { VisionFrame } from "../external-model/types.js";

const INJECT_KEY = "_injectVisionUserMessage";

/**
 * 视觉能力（cap=id="vision.*"）前缀：用于按 capability 检索"能看"的设备。
 * 涵盖：IP 摄像头（camera.*）、手机摄像头（phone.camera.*）、
 *      电脑屏幕（screen_capture.*）、智能眼镜（glasses.display.* 含摄像头）。
 */
const VISION_CAPABILITY_PREFIXES = ["camera", "screen_capture", "glasses.display"];

/**
 * Desktop Bridge 虚拟设备 ID。当桌面通过 desktop-bridge-coordinator 注册
 * （而非 device-bus 的 device.register 路径）时，用此 ID 作为 vision.see_device
 * 的入口，让 LLM 能看到这条路径接入的桌面。
 */
const DESKTOP_BRIDGE_DEVICE_ID = "desktop:bridge";

/**
 * 把设备调用返回的图像 data 转成 {@link VisionFrame}，用于注入下一轮模型上下文。
 * device.use('camera:xxx', 'camera.take_photo') 返回的 data 形如：
 *   { mimeType: "image/jpeg", base64: "...", sizeBytes: 12345 }
 */
function devicePhotoDataToVisionFrame(
  data: unknown,
  deviceId: string,
): VisionFrame | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const base64 = typeof obj.base64 === "string" ? obj.base64 : null;
  const mimeType = typeof obj.mimeType === "string" ? obj.mimeType : "image/jpeg";
  if (!base64) return null;
  return {
    sourceKind: "device_camera",
    sourceId: deviceId,
    mimeType,
    dataBase64: base64,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * 把 desktop-bridge 截图结果（含 imageBase64 字段）转成 {@link VisionFrame}。
 */
function bridgeScreenshotToVisionFrame(
  imageBase64: string,
  mimeType: string | undefined,
): VisionFrame {
  return {
    sourceKind: "device_camera",
    sourceId: DESKTOP_BRIDGE_DEVICE_ID,
    mimeType: mimeType ?? "image/png",
    dataBase64: imageBase64,
    capturedAt: new Date().toISOString(),
  };
}

export function registerVisionTools(
  registry: ToolRegistry,
  periodic: VisionPeriodicScheduler,
  deviceRegistry?: DeviceRegistry,
  desktopBridgeCoordinator?: DesktopBridgeCoordinator,
): void {
  registry.register("vision.http_pull", async (input, ctx) => {
    const url = String(input.url ?? "").trim();
    if (!url) {
      return { ok: false, error: "需要 url" };
    }
    const sourceId = input.sourceId != null ? String(input.sourceId).trim().slice(0, 160) : undefined;
    try {
      const frame = await fetchHttpVisionFrame(url, "external_stream", sourceId);
      return {
        ok: true,
        mimeType: frame.mimeType,
        byteLength: Buffer.byteLength(frame.dataBase64, "base64"),
        sourceKind: frame.sourceKind,
        sourceId: frame.sourceId,
        hint: "图像已注入紧随其后的模型上下文（用于视觉描述），请勿重复下载同一 URL 除非场景变化。",
        [INJECT_KEY]: [frame],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("vision.periodic_start", async (input, ctx) => {
    const actorId = resolveActorId(ctx);
    const url = String(input.url ?? "").trim();
    const intervalSeconds = Number(input.intervalSeconds);
    const prompt = input.prompt != null ? String(input.prompt) : undefined;
    const r = periodic.startJob(actorId, { url, intervalSeconds, prompt });
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    return {
      ok: true,
      jobId: r.jobId,
      message: "已启动服务端定时拉流抓帧；每个周期会向模型发送带图消息（需 WebSocket 在线接收回复）。",
    };
  });

  registry.register("vision.periodic_stop", async (input, ctx) => {
    const actorId = resolveActorId(ctx);
    const jobId = String(input.jobId ?? "").trim();
    if (!jobId) {
      return { ok: false, error: "需要 jobId" };
    }
    const r = periodic.stopJob(actorId, jobId);
    if (!r.ok) {
      return { ok: false, error: r.reason ?? "停止失败" };
    }
    return { ok: true, message: "已停止该定时视觉任务" };
  });

  registry.register("vision.periodic_stop_all", async (_input, ctx) => {
    const actorId = resolveActorId(ctx);
    const n = periodic.stopAllForActor(actorId);
    return { ok: true, stoppedCount: n };
  });

  registry.register("vision.periodic_list", async (_input, ctx) => {
    const actorId = resolveActorId(ctx);
    const jobs = periodic.listForActor(actorId);
    return { ok: true, jobs };
  });

  /**
   * vision.list_cameras：列出当前用户所有"能看"的在线设备。
   *
   * 视觉能力 = 具备下列任一 capability 前缀：
   *   - camera.*           → IP 摄像头 / 手机摄像头（take_photo / list_cameras / get_info）
   *   - screen_capture.*   → 电脑屏幕（screenshot）
   *   - glasses.display.*  → 智能眼镜（含摄像头）
   *
   * 与 device.list 区别：
   *   - device.list 返回所有设备（含纯传感器 / 执行器 / 智能家居等）
   *   - vision.list_cameras 只返回"能看"的设备，让 LLM 快速知道视觉感知边界
   *
   * 返回每个设备的 deviceId / kind / name / capabilities / 在线状态，
   * 以及每个设备支持的视觉 action 清单（如 camera.take_photo）。
   */
  registry.register("vision.list_cameras", async (_input, ctx) => {
    if (!deviceRegistry) {
      return {
        ok: false,
        error: "DeviceRegistry 未注入，无法列举视觉设备",
      };
    }
    const actorId = resolveActorId(ctx);
    const devices = [];
    const seen = new Set<string>();

    for (const prefix of VISION_CAPABILITY_PREFIXES) {
      const matches = deviceRegistry.findUserCapability(actorId, prefix, {
        prefix: true,
        onlyOnline: true,
      });
      for (const desc of matches) {
        if (seen.has(desc.deviceId)) continue;
        seen.add(desc.deviceId);
        // 提取该设备的视觉相关 capability 与 action
        const visionCapabilities = desc.capabilities
          .filter((c) =>
            VISION_CAPABILITY_PREFIXES.some((p) => c.id === p || c.id.startsWith(`${p}.`)),
          )
          .map((c) => ({
            id: c.id,
            actions: c.actions ?? [],
            streams: c.streams ?? [],
          }));
        devices.push({
          deviceId: desc.deviceId,
          kind: desc.kind,
          name: desc.name,
          status: desc.status,
          lastSeenAt: desc.lastSeenAt,
          visionCapabilities,
          // 标注最常用的拍照 action（便于 LLM 直接调 vision.see_device）
          primaryTakePhotoAction: pickTakePhotoAction(visionCapabilities),
        });
      }
    }

    // 追加 desktop-bridge 桌面（独立路径，不进 device-registry）
    if (desktopBridgeCoordinator?.hasExecutor(actorId)) {
      if (!seen.has(DESKTOP_BRIDGE_DEVICE_ID)) {
        seen.add(DESKTOP_BRIDGE_DEVICE_ID);
        devices.push({
          deviceId: DESKTOP_BRIDGE_DEVICE_ID,
          kind: "desktop",
          name: "本机桌面（desktop-bridge）",
          status: "online",
          lastSeenAt: Date.now(),
          visionCapabilities: [{
            id: "screen_capture",
            actions: ["screenshot"],
            streams: ["screen"],
          }],
          primaryTakePhotoAction: "screenshot",
        });
      }
    }

    return {
      ok: true,
      ownerUserId: actorId,
      deviceCount: devices.length,
      devices,
      hint: devices.length === 0
        ? "当前没有在线的视觉设备。可调 device.list 查看所有设备状态，或提醒用户接入摄像头/开启手机端桥接。"
        : "调用 vision.see_device 取当前画面（desktop:bridge 取桌面截图，其他 deviceId 取摄像头画面）。",
    };
  });

  /**
   * vision.see_device：从指定设备取一帧当前画面并注入下一轮模型上下文。
   *
   * 支持两条桌面接入路径：
   *   1. device-bus 路径：device.register 注册的 desktop 设备（cap=screen_capture）
   *   2. desktop-bridge-coordinator 路径：通过 desktop_bridge_register 注册的桌面
   *      —— 用 device_id="desktop:bridge" 触发，调 coordinator.invoke({action:"screenshot"})
   *
   * 与 vision.http_pull 区别：
   *   - http_pull 拉远程 URL（公网/局域网快照接口）
   *   - see_device 调 device-bus 接入的设备（IP 摄像头 / 手机摄像头 / 智能眼镜等）
   *     或 desktop-bridge 桌面，是真正的「看真实世界」
   *
   * 与 device.use('camera.take_photo') 区别：
   *   - device.use 返回 data（含 base64），但不会让 LLM "看到"图像
   *   - see_device 把拍到的图像通过 _injectVisionUserMessage 注入下一轮上下文，
   *     让视觉模型直接理解画面
   *
   * 流程：
   *   1. 校验 deviceId 属于当前用户或 system（或 desktop:bridge 虚拟设备）
   *   2. desktop:bridge → 走 desktopBridgeCoordinator.invoke({action:"screenshot"})
   *      其他 deviceId → 走 deviceRegistry.invoke(deviceId, action)
   *   3. 转 VisionFrame + 注入下一轮上下文
   *   4. 返回简要元数据（不重复 base64，避免上下文膨胀）
   */
  registry.register("vision.see_device", async (input, ctx) => {
    const actorId = resolveActorId(ctx);
    const deviceId = String(input.device_id ?? input.deviceId ?? "").trim();
    if (!deviceId) {
      return { ok: false, error: "缺少 device_id（从 vision.list_cameras 结果中选取）" };
    }

    // ---------- 路径 A：desktop-bridge-coordinator ----------
    if (deviceId === DESKTOP_BRIDGE_DEVICE_ID) {
      if (!desktopBridgeCoordinator) {
        return {
          ok: false,
          deviceId,
          error: "DesktopBridgeCoordinator 未注入，无法走桌面桥接路径",
        };
      }
      if (!desktopBridgeCoordinator.hasExecutor(actorId)) {
        return {
          ok: false,
          deviceId,
          error: "桌面桥接未在线：请在本机运行桌面桥接客户端（session.init 带 desktopBridge:true）",
        };
      }

      const region = Array.isArray(input.region) && input.region.length === 4
        ? input.region as [number, number, number, number]
        : undefined;
      const timeoutMs = typeof input.timeoutMs === "number"
        ? Math.min(120_000, Math.max(5_000, input.timeoutMs))
        : 60_000;

      try {
        const remote = await desktopBridgeCoordinator.invoke(
          actorId,
          { action: "screenshot", region: region ?? null },
          timeoutMs,
        );
        if (!remote || !remote.ok || !remote.imageBase64) {
          return {
            ok: false,
            deviceId,
            error: remote?.error ?? "桌面桥接截图失败",
          };
        }

        const frame = bridgeScreenshotToVisionFrame(remote.imageBase64, remote.mimeType);
        return {
          ok: true,
          deviceId,
          deviceKind: "desktop",
          deviceName: "本机桌面（desktop-bridge）",
          action: "screenshot",
          mimeType: frame.mimeType,
          width: remote.width,
          height: remote.height,
          byteLength: Buffer.byteLength(frame.dataBase64, "base64"),
          capturedAt: remote.capturedAt ?? frame.capturedAt,
          hint: `已注入桌面当前画面（${remote.width ?? "?"}x${remote.height ?? "?"}）到模型上下文，请基于图像描述场景并回答用户问题。`,
          [INJECT_KEY]: [frame],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, deviceId, error: `桌面桥接调用失败：${msg}` };
      }
    }

    // ---------- 路径 B：device-bus ----------
    if (!deviceRegistry) {
      return {
        ok: false,
        error: "DeviceRegistry 未注入，无法从设备取画面",
      };
    }

    const desc = deviceRegistry.get(deviceId);
    if (!desc) {
      return { ok: false, error: `设备 ${deviceId} 未注册或离线` };
    }
    if (desc.ownerUserId !== actorId && desc.ownerUserId !== "system") {
      return { ok: false, error: `无权访问他人设备 ${deviceId}` };
    }
    if (desc.status === "offline") {
      return { ok: false, error: `设备 ${deviceId} 当前离线` };
    }

    // 自动选择 action：优先用 action 参数，否则按 capability 推断
    const actionInput = String(input.action ?? "").trim();
    const action = actionInput || pickTakePhotoAction(
      desc.capabilities
        .filter((c) =>
          VISION_CAPABILITY_PREFIXES.some((p) => c.id === p || c.id.startsWith(`${p}.`)),
        )
        .map((c) => ({ id: c.id, actions: c.actions ?? [], streams: c.streams ?? [] })),
    );
    if (!action) {
      return {
        ok: false,
        error: `设备 ${deviceId}（kind=${desc.kind}）未声明视觉 action，请显式传 action 参数`,
      };
    }

    const params = (input.params && typeof input.params === "object")
      ? input.params as Record<string, unknown>
      : {};

    try {
      const result = await deviceRegistry.invoke(deviceId, action, params);
      if (!result.ok) {
        return {
          ok: false,
          deviceId,
          action,
          error: result.error?.message ?? "调用设备 action 失败",
          elapsedMs: result.elapsedMs,
        };
      }

      const frame = devicePhotoDataToVisionFrame(result.data, deviceId);
      if (!frame) {
        return {
          ok: false,
          deviceId,
          action,
          error: "设备返回数据无可识别图像（缺 base64/mimeType 字段）",
          elapsedMs: result.elapsedMs,
        };
      }

      return {
        ok: true,
        deviceId,
        deviceKind: desc.kind,
        deviceName: desc.name,
        action,
        mimeType: frame.mimeType,
        byteLength: Buffer.byteLength(frame.dataBase64, "base64"),
        capturedAt: frame.capturedAt,
        elapsedMs: result.elapsedMs,
        hint: `已注入 ${desc.name || deviceId} 当前画面到模型上下文，请基于图像描述场景并回答用户问题。`,
        [INJECT_KEY]: [frame],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, deviceId, action, error: `视觉调用失败：${msg}` };
    }
  });
}

/**
 * 从设备的视觉 capability 列表里挑出最常用的"拍照"action。
 * 优先级：camera.take_photo > screen_capture.screenshot > glasses.display.capture >
 *         list_cameras 中第一个带 take/capture/snapshot 关键词的 action。
 */
function pickTakePhotoAction(
  caps: Array<{ id: string; actions: string[]; streams: string[] }>,
): string | undefined {
  const candidates = [
    { capId: "camera", action: "camera.take_photo" },
    { capId: "screen_capture", action: "screen_capture.screenshot" },
    { capId: "glasses.display", action: "glasses.display.capture" },
  ];
  for (const c of candidates) {
    const cap = caps.find((x) => x.id === c.capId || x.id.startsWith(`${c.capId}.`));
    if (cap && cap.actions.includes(c.action.slice(c.capId.length + 1))) {
      return c.action;
    }
  }
  // 兜底：扫描所有 action，找含 take_photo / capture / snapshot 的
  for (const cap of caps) {
    for (const a of cap.actions) {
      const full = `${cap.id}.${a}`;
      if (/take_photo|capture|snapshot/i.test(full)) return full;
    }
  }
  return undefined;
}
