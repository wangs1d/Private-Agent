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

export type DesktopVisualRunShellInput = {
  command: string;
  /** "cmd" | "powershell" | "bash" | null（让 Python 端按 OS 自动） */
  shell?: string | null;
  cwd?: string | null;
  timeoutMs?: number;
  allowDestructive?: boolean;
};

export type DesktopVisualOpenInput = {
  /** 打开目标类型：file=用默认程序打开文件，url=用默认浏览器打开网页，app=直接启动可执行文件 */
  target: "file" | "url" | "app";
  /** 文件路径 / 网页 URL / 可执行文件路径 */
  path: string;
};

export type DesktopVisualOpenResult = {
  ok: boolean;
  target?: string;
  path?: string;
  openedAt?: string;
  error?: string;
};

export type DesktopVisualUiaQueryInput = {
  /** 查询模式：query=按 selector 查找；read_children=读父元素子树；inspect_point=检查 (x,y) 处元素 */
  mode: "query" | "read_children" | "inspect_point";
  /** query/read_children 模式的选择条件，如 {control_type:"Button", name:"确定"} */
  selector?: Record<string, unknown> | null;
  /** inspect_point 模式的坐标 */
  point?: { x: number; y: number } | null;
  /** query 模式：仅顶层（true）或递归（false），默认 true */
  topOnly?: boolean | null;
  /** 返回元素上限，query 默认 100，read_children 默认 200 */
  limit?: number | null;
};

export type DesktopVisualUiaElement = {
  name?: string;
  automation_id?: string;
  control_type?: string;
  class_name?: string;
  bbox?: [number, number, number, number];
  patterns?: string[];
  is_enabled?: boolean;
  is_offscreen?: boolean;
};

export type DesktopVisualUiaQueryResult = {
  ok: boolean;
  mode?: string;
  selector?: Record<string, unknown> | null;
  count?: number;
  elements?: DesktopVisualUiaElement[];
  element?: DesktopVisualUiaElement;
  point?: { x: number; y: number };
  parent?: DesktopVisualUiaElement;
  error?: string;
  available?: boolean;
};

export type DesktopVisualRunShellResult = {
  ok: boolean;
  command?: string;
  shell?: string;
  firstToken?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  killed?: boolean;
  decision?: {
    allowed: boolean;
    shell?: string;
    firstToken?: string;
    reason?: string;
  };
  error?: string;
};

export interface DesktopVisualPort {
  /** 与 `DESKTOP_VISUAL_ENABLED` 等配置一致；为 false 时不应注册 chat tools。 */
  isEnabled(): boolean;

  /** 在运行本机 Python 子进程的工作目录下执行一轮视觉-动作闭环（可能耗时数分钟）。 */
  runTask(input: DesktopVisualRunInput): Promise<DesktopVisualRunResult>;

  /** 截取屏幕（或指定区域）为 PNG 图片，返回 base64 数据。 */
  screenshot?(input?: DesktopVisualScreenshotInput): Promise<DesktopVisualScreenshotResult>;

  /**
   * 在本机 spawn stdio_worker 执行一条受策略约束的 shell 命令。
   * 若未实现（即 desktop.run_shell 工具走电脑端 executor 兜底），可以不提供。
   */
  runShell?(input: DesktopVisualRunShellInput): Promise<DesktopVisualRunShellResult>;

  /**
   * 原生 API 打开文件/网页/软件（不走 shell，不经 shell_policy 判定）。
   * 若未实现（即 desktop.open 工具走电脑端 executor 兜底），可以不提供。
   */
  open?(input: DesktopVisualOpenInput): Promise<DesktopVisualOpenResult>;

  /**
   * Windows UIAutomation 结构化查询（仅 Windows 可用，非 Windows 返回 ok:false）。
   * 供主 agent 内部调用读 ListView/Tree 内容、按 AutomationId 定位控件等。
   * 不暴露给 LLM（与 desktop.open / desktop.run_preset 一致）。
   */
  uiaQuery?(
    input: DesktopVisualUiaQueryInput,
  ): Promise<DesktopVisualUiaQueryResult>;
}
