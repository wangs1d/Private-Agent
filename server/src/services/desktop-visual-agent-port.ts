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

export type DesktopVisualRunResult = {
  ok: boolean;
  steps?: number;
  summary?: string;
  error?: string;
};

export interface DesktopVisualAgentPort {
  /** 与 `DESKTOP_VISUAL_AGENT_ENABLED` 等配置一致；为 false 时不应注册 chat tools。 */
  isEnabled(): boolean;

  /** 在运行本机 Python 子进程的工作目录下执行一轮视觉-动作闭环（可能耗时数分钟）。 */
  runTask(input: DesktopVisualRunInput): Promise<DesktopVisualRunResult>;
}
