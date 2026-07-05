/**
 * 网络摄像头适配器 —— HTTP/ONVIF 协议
 *
 * 与 phone / desktop / glasses 不同，IP Cam 不走 WS 长连接，而是 HTTP 拉取：
 *  - 截图：GET http://<cam>/snap.jpg（Basic Auth 或无认证）
 *  - PTZ：GET http://<cam>/ptz?action=left&step=N（厂商私有 API，本适配器只做透传）
 *  - 视频流：返回 RTSP URL，由调用方（如 Flutter 端）自行用播放器拉流
 *
 * 设备注册时通过 metadata 提供连接信息：
 *  - baseUrl（必填）：如 "http://192.168.1.50:8080"
 *  - snapshotPath（可选）：默认 "/snap.jpg"
 *  - username / password（可选）：Basic Auth 凭据
 *  - streamUrl（可选）：RTSP URL，如 "rtsp://user:pass@192.168.1.50:554/stream"
 *  - ptzPath（可选）：PTZ 控制路径，默认 "/ptz"
 *
 * 不复用 WsRemoteAdapter 基类（无 WS 连接、无 device.invoke_result 回包）。
 */
import type {
  DeviceAdapter,
  DeviceAdapterFactory,
  DeviceAdapterInit,
  AdapterStaticInfo,
} from "../device-adapter.js";
import type {
  CapabilityDeclaration,
  DeviceInvokeResult,
  DeviceStreamChunk,
} from "../device-model.js";

const CAMERA_DEFAULT_CAPABILITIES: CapabilityDeclaration[] = [
  {
    id: "camera",
    actions: ["take_photo", "list_cameras", "get_info"],
    streams: ["snapshot", "video"],
  },
  {
    id: "sensor.motion",
    actions: ["get_motion_state", "enable_motion_detect", "disable_motion_detect"],
    streams: ["motion"],
  },
  // PTZ 控制（若设备支持）
  {
    id: "ptz",
    actions: ["move_left", "move_right", "move_up", "move_down", "zoom_in", "zoom_out", "stop", "goto_preset"],
  },
];

interface CameraConfig {
  baseUrl: string;
  snapshotPath: string;
  username?: string;
  password?: string;
  streamUrl?: string;
  ptzPath: string;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 2_000; // snapshot 流默认 2 秒一帧
const STREAM_TIMEOUT_MS = 5 * 60 * 1_000; // 单条流最长 5 分钟

class CameraAdapter implements DeviceAdapter {
  readonly deviceId: string;
  readonly kind = "camera" as const;
  private config: CameraConfig | null = null;

  constructor(init: DeviceAdapterInit) {
    this.deviceId = init.descriptor.deviceId;
  }

  initialize(init: DeviceAdapterInit): void {
    const meta = init.descriptor.metadata ?? {};
    const baseUrl = String(meta.baseUrl ?? "").replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("CameraAdapter 注册时 metadata.baseUrl 必填（如 http://192.168.1.50:8080）");
    }
    this.config = {
      baseUrl,
      snapshotPath: String(meta.snapshotPath ?? "/snap.jpg"),
      username: meta.username != null ? String(meta.username) : undefined,
      password: meta.password != null ? String(meta.password) : undefined,
      streamUrl: meta.streamUrl != null ? String(meta.streamUrl) : undefined,
      ptzPath: String(meta.ptzPath ?? "/ptz"),
    };
  }

  private authHeaders(): Record<string, string> {
    if (!this.config?.username) return {};
    const token = Buffer.from(`${this.config.username}:${this.config.password ?? ""}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  async invoke(action: string, params: Record<string, unknown>): Promise<DeviceInvokeResult> {
    if (!this.config) {
      return { ok: false, error: { code: "NOT_INITIALIZED", message: "摄像头适配器未初始化" } };
    }
    const startedAt = Date.now();
    try {
      if (action === "camera.take_photo") {
        return await this.takePhoto();
      }
      if (action === "camera.list_cameras" || action === "camera.get_info") {
        return {
          ok: true,
          data: {
            deviceId: this.deviceId,
            baseUrl: this.config.baseUrl,
            streamUrl: this.config.streamUrl,
            snapshotUrl: this.config.baseUrl + this.config.snapshotPath,
          },
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (action.startsWith("ptz.")) {
        return await this.invokePtz(action, params);
      }
      if (action === "sensor.motion.get_motion_state") {
        // 简化：返回不支持，端侧可自行实现
        return {
          ok: false,
          error: { code: "NOT_SUPPORTED", message: "motion 状态查询需端侧扩展" },
          elapsedMs: Date.now() - startedAt,
        };
      }
      return {
        ok: false,
        error: { code: "BAD_ACTION", message: `摄像头不支持 action: ${action}` },
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: { code: "CAMERA_INVOKE_ERROR", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  private async takePhoto(): Promise<DeviceInvokeResult> {
    if (!this.config) throw new Error("no config");
    const url = this.config.baseUrl + this.config.snapshotPath;
    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: { code: "SNAPSHOT_FAILED", message: `HTTP ${res.status}: ${body.slice(0, 200)}` } };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    return {
      ok: true,
      data: {
        mimeType: contentType,
        base64: buf.toString("base64"),
        sizeBytes: buf.length,
      },
    };
  }

  private async invokePtz(action: string, params: Record<string, unknown>): Promise<DeviceInvokeResult> {
    if (!this.config) throw new Error("no config");
    const command = action.slice("ptz.".length);
    const url = new URL(this.config.baseUrl + this.config.ptzPath);
    url.searchParams.set("action", command);
    if (typeof params.step === "number") url.searchParams.set("step", String(params.step));
    if (typeof params.preset === "string") url.searchParams.set("preset", params.preset);
    const res = await fetch(url.toString(), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, error: { code: "PTZ_FAILED", message: `PTZ ${command} HTTP ${res.status}` } };
    }
    return { ok: true, data: { command, ok: true } };
  }

  async *openStream(
    streamId: string,
    params: Record<string, unknown>,
  ): AsyncIterable<DeviceStreamChunk> {
    if (!this.config) {
      yield { streamId, kind: "error", error: { code: "NOT_INITIALIZED", message: "摄像头适配器未初始化" } };
      return;
    }
    // "video" 流：返回 RTSP URL，由调用方拉流（server 不解码 RTSP）
    if (params.type === "video" || params.stream === "video") {
      yield {
        streamId,
        kind: "json",
        data: {
          streamUrl: this.config.streamUrl,
          protocol: "rtsp",
          note: "RTSP 流需由调用方用播放器拉取；server 不解码 RTSP",
        },
      };
      yield { streamId, kind: "end" };
      return;
    }
    // "snapshot" 流：周期拉取截图，模拟视频帧序列
    const intervalMs = typeof params.intervalMs === "number"
      ? Math.max(500, params.intervalMs)
      : DEFAULT_SNAPSHOT_INTERVAL_MS;
    const startedAt = Date.now();
    let frameSeq = 0;
    while (Date.now() - startedAt < STREAM_TIMEOUT_MS) {
      try {
        const result = await this.takePhoto();
        if (!result.ok) {
          yield { streamId, kind: "error", error: result.error };
          break;
        }
        const data = result.data as { base64: string; mimeType: string };
        yield {
          streamId,
          kind: "binary",
          data: data.base64,
          error: undefined,
        };
        frameSeq++;
      } catch (err) {
        yield {
          streamId,
          kind: "error",
          error: { code: "STREAM_FRAME_ERROR", message: err instanceof Error ? err.message : String(err) },
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    yield { streamId, kind: "end" };
  }

  dispose(): void {
    // 无长连接需要关闭
  }
}

export function createCameraAdapterFactory(): DeviceAdapterFactory & AdapterStaticInfo {
  return Object.assign(
    (init: DeviceAdapterInit): DeviceAdapter => new CameraAdapter(init),
    {
      kind: "camera" as const,
      requiresConnection: false, // 走 HTTP，不需要 WS connection
      defaultCapabilities: CAMERA_DEFAULT_CAPABILITIES,
    },
  );
}
