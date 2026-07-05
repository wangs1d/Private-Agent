/**
 * 桌面适配器 —— 通过 device.* 协议与远程桌面客户端通信
 *
 * 与现有 desktop-bridge-coordinator 并存。桌面设备的核心能力是「屏幕捕获 + 鼠键控制」，
 * 兼容 Agent 视觉控制场景。
 *
 * 默认能力：
 *  - 屏幕截图 / 屏幕流（视觉输入）
 *  - 鼠键输入（执行器）
 *  - 摄像头 / 麦克风 / 扬声器 / 通知
 *  - shell 执行（受 shell_policy 白名单约束，由端侧裁定）
 */
import type {
  DeviceAdapter,
  DeviceAdapterFactory,
  DeviceAdapterInit,
  AdapterStaticInfo,
} from "../device-adapter.js";
import { WsRemoteAdapter } from "./ws-remote-adapter.js";

const DESKTOP_DEFAULT_CAPABILITIES = [
  {
    id: "screen_capture",
    actions: ["screenshot", "start_stream", "stop_stream", "list_displays"],
    streams: ["screen"],
  },
  {
    id: "input",
    actions: ["mouse_move", "mouse_click", "mouse_scroll", "key_press", "type_text", "hotkey"],
  },
  {
    id: "camera",
    actions: ["take_photo", "start_stream"],
    streams: ["video"],
  },
  {
    id: "microphone",
    actions: ["start_record", "stop_record"],
    streams: ["audio"],
  },
  {
    id: "speaker",
    actions: ["play_audio", "set_volume"],
  },
  {
    id: "notification",
    actions: ["show", "cancel"],
  },
  {
    id: "shell",
    actions: ["run", "run_safe"],
    // shell 执行受端侧 shell_policy 白名单 + 黑名单 + 正则三道闸约束
  },
  {
    id: "agent.see",
    actions: ["observe_screen", "focus_window", "read_text"],
  },
  {
    id: "window",
    actions: ["list_windows", "focus", "minimize", "maximize", "close", "move", "resize"],
  },
];

class DesktopAdapter extends WsRemoteAdapter {
  readonly kind = "desktop" as const;
  protected readonly defaultCapabilities = DESKTOP_DEFAULT_CAPABILITIES;
}

export function createDesktopAdapterFactory(): DeviceAdapterFactory & AdapterStaticInfo {
  return Object.assign(
    (init: DeviceAdapterInit): DeviceAdapter => new DesktopAdapter(init),
    {
      kind: "desktop" as const,
      requiresConnection: true,
      defaultCapabilities: DESKTOP_DEFAULT_CAPABILITIES,
    },
  );
}
