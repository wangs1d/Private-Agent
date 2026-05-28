/**
 * 桌面纯视觉操控（Python：VLM + pyautogui/pynput）在 Node 侧的抽象端口。
 * 具体实现可为子进程桥接；后续可替换为 gRPC/HTTP 而不改 ToolRegistry 签名。
 */

export type DesktopVisualRunInput = {
  task: string;
  maxSteps?: number;
  /** 可选 [left, top, width, height]，与 pyautogui.screenshot(region=...) 一致 */
  region?: [number, number, number, number];
  /** 仅调试：强制 Python 侧 StubVLM（不调用真实多模态 API） */
  stub?: boolean;
};

export type DesktopVisualScreenshotInput = {
  /** 可选 [left, top, width, height]，与 pyautogui.screenshot(region=...) 一致；省略则全屏 */
  region?: [number, number, number, number];
};

export type DesktopVisualScreenshotResult = {
  ok: boolean;
  /** Base64 编码的 PNG 图片数据 */
  imageBase64?: string;
  /** 图片 MIME 类型，固定为 image/png */
  mimeType?: string;
  /** 图片宽度（像素） */
  width?: number;
  /** 图片高度（像素） */
  height?: number;
  /** 截图时间戳 ISO 8601 */
  capturedAt?: string;
  error?: string;
};

export type DesktopVisualRunResult = {
  ok: boolean;
  steps?: number;
  summary?: string;
  error?: string;
  /** 桥接/本机截图时附带 */
  imageBase64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
};

export interface DesktopVisualAgentPort {
  /** 与 `DESKTOP_VISUAL_AGENT_ENABLED` 等配置一致；为 false 时不应注册 chat tools。 */
  isEnabled(): boolean;

  /** 在运行本机 Python 子进程的工作目录下执行一轮视觉-动作闭环（可能耗时数分钟）。 */
  runTask(input: DesktopVisualRunInput): Promise<DesktopVisualRunResult>;

  /** 截取屏幕（或指定区域）为 PNG 图片，返回 base64 数据。 */
  screenshot?(input?: DesktopVisualScreenshotInput): Promise<DesktopVisualScreenshotResult>;
}
