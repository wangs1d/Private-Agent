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
  /** 可选 [left, top, width, height]，相对显示器左上角的物理像素；省略则整屏 */
  region?: [number, number, number, number];
  /** 1-based 显示器编号（省略 = 主屏） */
  display?: number;
  /** 图片最长边像素上限，超出时等比降采样；返回 scale 供坐标换算 */
  maxDim?: number;
};

export type DesktopVisualScreenshotResult = {
  ok: boolean;
  /** Base64 编码的 PNG 图片数据 */
  imageBase64?: string;
  /** 图片 MIME 类型，固定为 image/png */
  mimeType?: string;
  /** 图片宽度（像素，降采样后） */
  width?: number;
  /** 图片高度（像素，降采样后） */
  height?: number;
  /** 实际截取区域宽（屏幕物理像素） */
  screenWidth?: number;
  /** 实际截取区域高（屏幕物理像素） */
  screenHeight?: number;
  /** image→screen 坐标倍率（>1 表示已降采样；screen = image * scale） */
  scale?: number;
  /** 实际使用的显示器编号 */
  display?: number;
  /** 显示器在虚拟屏幕中的原点 [x, y]（物理像素） */
  origin?: [number, number];
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
  /** uia_query 结果字段 */
  mode?: string;
  selector?: Record<string, unknown> | null;
  count?: number;
  elements?: DesktopVisualUiaElement[];
  element?: DesktopVisualUiaElement;
  point?: { x: number; y: number };
  parent?: DesktopVisualUiaElement;
  available?: boolean;
  /** 允许透传其他工具结果字段(run_input / run_shell / open 等),bridge 是传输层不应过滤 */
  [key: string]: unknown;
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
  /**
   * 查询模式：query=按 selector 查找；read_children=读父元素子树；inspect_point=检查 (x,y) 处元素；
   * snapshot=前台/指定窗口控件树快照（元素带 path，可在 run_automation 里复用）
   */
  mode: "query" | "read_children" | "inspect_point" | "snapshot";
  /** query/read_children 模式的选择条件，如 {control_type:"Button", name:"确定"} */
  selector?: Record<string, unknown> | null;
  /** inspect_point 模式的坐标 */
  point?: { x: number; y: number } | null;
  /** query/read_children/snapshot 模式：限定目标窗口（标题子串，大小写不敏感）；snapshot 省略时取前台窗口 */
  windowTitle?: string | null;
  /** snapshot 模式：控件树最大深度，默认 6 */
  maxDepth?: number | null;
  /** query 模式：仅顶层（true）或递归（false），默认 true */
  topOnly?: boolean | null;
  /** 返回元素上限，query 默认 100，read_children 默认 200，snapshot 默认 150 */
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

export type DesktopVisualRunInputInput = {
  /** 操作类型（对齐主流 computer-use 动作空间） */
  action:
    | "click"
    | "double_click"
    | "triple_click"
    | "middle_click"
    | "right_click"
    | "move"
    | "type"
    | "key"
    | "shortcut"
    | "drag"
    | "scroll"
    | "wait"
    | "cursor_position"
    | "hold_key";
  /** click/move/drag/scroll(可选) 的目标坐标；默认为屏幕物理像素 */
  x?: number;
  y?: number;
  /** drag 的终点坐标 */
  toX?: number;
  toY?: number;
  /** click 的鼠标按键: left / right / middle，默认 left */
  button?: string;
  /** type 要输入的文本；含非 ASCII 字符时 Python 端自动走剪贴板粘贴路径 */
  text?: string;
  /** key/hold_key 要按的单键: enter, tab, esc, backspace, space, up, down, left, right 等 */
  key?: string;
  /** shortcut 组合键: "ctrl+c", "ctrl+v", "alt+tab" 等，用 + 分隔 */
  keys?: string;
  /** scroll 垂直滚动量: 正=向上, 负=向下 */
  scrollClicks?: number;
  /** scroll 水平滚动量: 正=向右, 负=向左 */
  scrollX?: number;
  /** wait 等待毫秒（1-10000，默认 500） */
  waitMs?: number;
  /** hold_key 按住秒数（0.05-5，默认 0.5） */
  holdSeconds?: number;
  /** 按键间隔秒数，默认 type=0.02, 其他=0.05 */
  interval?: number;
  /** 鼠标移动平滑时间秒数，0=瞬间到位 */
  moveDuration?: number;
  /** coordSpace="image" 时必传：截图返回的 width（模型给的是截图上的坐标） */
  imageWidth?: number;
  /** coordSpace="image" 时必传：截图返回的 height */
  imageHeight?: number;
  /** 坐标空间：screen=屏幕物理像素（默认）；image=截图像素（需 imageWidth/imageHeight） */
  coordSpace?: "screen" | "image";
  /** image 坐标对应的显示器编号（默认主屏） */
  display?: number;
};

export type DesktopVisualRunInputResult = {
  ok: boolean;
  action?: string;
  x?: number;
  y?: number;
  text?: string;
  error?: string;
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

  /**
   * 原生键盘/鼠标模拟输入（不走 VLM，用 pyautogui + pynput）。
   * 支持 click / double_click / type / key / shortcut / scroll / drag / move 等原子操作。
   * 不需要 VLM，不受 VLM 配置影响，任何时候可用。
   */
  runInput?(
    input: DesktopVisualRunInputInput,
  ): Promise<DesktopVisualRunInputResult>;

  /**
   * UIA 原生控件原子操作（不模拟鼠标键盘，直接调 pattern）。
   * 一次调用完成 query → ValuePattern/InvokePattern/TogglePattern 操作。
   * 不抢焦点，不要求窗口在前台。仅 Win32/WPF/WinForms 支持，Electron 自绘 UI 读不到控件。
   */
  runAutomation?(
    input: DesktopVisualRunAutomationInput,
  ): Promise<DesktopVisualRunAutomationResult>;

  /**
   * 原生 HTTP GET 请求(用 requests 库,不走 shell 避免注入)。
   * 仅支持 GET(只读)。替代 shell curl 调用,带 SSRF 防护、超时、响应体截断。
   */
  httpGet?(
    input: DesktopVisualHttpGetInput,
  ): Promise<DesktopVisualHttpGetResult>;

  /**
   * 桌面端联网搜索(Bing CN)。桌面本机直接联网,不依赖服务端。
   * 返回标题+URL+摘要列表。
   */
  webSearch?(
    input: DesktopVisualWebSearchInput,
  ): Promise<DesktopVisualWebSearchResult>;

  /**
   * 桌面端抓取网页正文。提取纯文本(去 HTML 标签/脚本/样式)。
   * 返回标题+摘要+正文。带 SSRF 防护。
   */
  webFetch?(
    input: DesktopVisualWebFetchInput,
  ): Promise<DesktopVisualWebFetchResult>;

  /**
   * 窗口管理（主流 computer-use / OS agent 标配）。
   * list 枚举可见顶层窗口；activate/close/minimize/maximize/restore/move/resize
   * 按 hwnd / title 子串 / list 编号定位。仅 Windows。
   */
  window?(input: DesktopVisualWindowInput): Promise<DesktopVisualWindowResult>;

  /** 剪贴板读写（get / set）。type 工具的非 ASCII 粘贴路径与这里共用底层。 */
  clipboard?(
    input: DesktopVisualClipboardInput,
  ): Promise<DesktopVisualClipboardResult>;
}

export type DesktopVisualRunAutomationInput = {
  /** 原生控件操作类型 */
  action:
    | "click"
    | "set_value"
    | "get_value"
    | "toggle"
    | "focus"
    | "select"
    | "expand"
    | "collapse"
    | "scroll_into_view";
  /** UIA 查询条件；也可用 { path: "2.1.3" } 复用 snapshot 输出的元素路径 */
  selector: Record<string, unknown>;
  /** set_value 时要设置的文本 */
  value?: string;
  /** 匹配多个元素时选第 N 个(0-based) */
  index?: number;
  /** 是否仅查顶层(默认 true) */
  topOnly?: boolean;
  /** 限定目标窗口（标题子串，大小写不敏感）；省略时查询整个桌面 */
  windowTitle?: string;
};

export type DesktopVisualRunAutomationResult = {
  ok: boolean;
  action?: string;
  matchedCount?: number;
  matchedElement?: DesktopVisualUiaElement;
  value?: string | null;
  error?: string;
  available?: boolean;
};

export type DesktopVisualHttpGetInput = {
  /** 目标 URL,仅 http/https */
  url: string;
  /** 自定义 headers(可选) */
  headers?: Record<string, string>;
  /** 超时(毫秒),默认 15000,上限 60000 */
  timeoutMs?: number;
};

export type DesktopVisualHttpGetResult = {
  ok: boolean;
  url?: string;
  statusCode?: number;
  contentType?: string;
  body?: string;
  /** 响应体编码方式:text(字符串) 或 base64(二进制) */
  bodyEncoding?: "text" | "base64";
  /** 响应体是否被截断(超过 256KB) */
  truncated?: boolean;
  bytesReceived?: number;
  headers?: Record<string, string>;
  error?: string;
};

export type DesktopVisualWebSearchInput = {
  /** 搜索关键词 */
  query: string;
  /** 返回条数,1-20,默认 8 */
  limit?: number;
};

export type DesktopVisualWebSearchResult = {
  ok: boolean;
  query?: string;
  count?: number;
  items?: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  engine?: string;
  error?: string;
};

export type DesktopVisualWebFetchInput = {
  /** 目标网页 URL */
  url: string;
};

export type DesktopVisualWebFetchResult = {
  ok: boolean;
  url?: string;
  title?: string;
  summary?: string;
  content?: string;
  contentTruncated?: boolean;
  statusCode?: number;
  contentType?: string;
  bytesReceived?: number;
  error?: string;
};

export type DesktopVisualWindowInput = {
  /** 窗口操作：list 枚举；其余按 hwnd / title / index 定位 */
  op: "list" | "activate" | "close" | "minimize" | "maximize" | "restore" | "move" | "resize";
  /** 窗口标题子串（大小写不敏感，优先级低于 hwnd） */
  title?: string;
  /** list 输出的窗口编号（1-based） */
  index?: number;
  /** 窗口句柄（list 输出的 hwnd） */
  hwnd?: number;
  /** move 的目标位置（屏幕物理像素） */
  x?: number;
  y?: number;
  /** resize 的目标尺寸（物理像素） */
  width?: number;
  height?: number;
};

export type DesktopVisualWindowInfo = {
  index?: number;
  hwnd?: number;
  title?: string;
  /** [left, top, right, bottom] 物理像素 */
  bbox?: [number, number, number, number];
  minimized?: boolean;
  maximized?: boolean;
  foreground?: boolean;
  processName?: string;
};

export type DesktopVisualWindowResult = {
  ok: boolean;
  op?: string;
  count?: number;
  windows?: DesktopVisualWindowInfo[];
  window?: DesktopVisualWindowInfo;
  hwnd?: number;
  error?: string;
};

export type DesktopVisualClipboardInput = {
  /** get 读取 / set 写入 */
  op: "get" | "set";
  /** set 时要写入的文本 */
  text?: string;
};

export type DesktopVisualClipboardResult = {
  ok: boolean;
  op?: string;
  /** get 时的文本内容（超长截断） */
  text?: string;
  length?: number;
  truncated?: boolean;
  error?: string;
};
