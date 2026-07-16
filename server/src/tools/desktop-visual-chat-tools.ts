import type { ChatCompletionTool } from "openai/resources/chat/completions";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 服务端是否开启「电脑桥接」相关能力（与是否在线无关） */
export function isDesktopBridgeEnvOn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (parseBooleanEnv(env.DESKTOP_BRIDGE_ENABLED)) return true;
  return (env.DESKTOP_BRIDGE_TOKEN?.trim().length ?? 0) >= 8;
}

/** 本机 Python 执行 或 电脑桥接（手机经服务端调度到已绑定 PC）任一方可用时，向模型暴露工具。 */
function isLocalVisualEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanEnv(env.DESKTOP_VISUAL_ENABLED) ||
    parseBooleanEnv(env.DESKTOP_VISUAL_AGENT_ENABLED)
  );
}

export function isDesktopVisualControlChatToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLocalVisualEnabled(env) || isDesktopBridgeEnvOn(env);
}

const DESKTOP_VISUAL_RUN_TASK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.visual.run_task",
    description:
      "【桌面·纯视觉·最后手段·几乎禁用】截屏 + 多模态 VLM 驱动键鼠完成 GUI 任务。" +
      "⚠⚠⚠ **前置条件（硬性）**：调用本工具前，本轮必须已经调用过 desktop.uia_query 至少 1 次，" +
      "且已经调用过 desktop.run_input 至少 1 次。否则禁止调用本工具。" +
      "⚠ 本工具依赖 VLM（视觉大模型）：当前若主模型为非视觉模型（如 deepseek-chat / gpt-3.5），调用必然失败。" +
      "正常流程：desktop.open → desktop.uia_query（拿 bbox 中心）→ desktop.run_input（click/type/key）→ desktop.visual.screenshot（验证）。" +
      "仅当上述路径完全走不通、且任务确实需要「看屏幕→点按钮→看下一个屏幕」循环时才用本工具。" +
      "如电脑未在线且服务端启用了 DESKTOP_VISUAL_ENABLED，则在**服务器本机**执行。须用户明确授权。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "用自然语言描述要完成的一系列界面操作目标" },
        maxSteps: {
          type: "integer",
          description: "视觉-动作循环最多步数，默认 15，上限建议不超过 30（每次循环截屏+推理，token 开销大）",
        },
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "可选截屏区域 [left, top, width, height]；省略则全屏",
        },
        stub: {
          type: "boolean",
          description: "调试：为 true 时不调用真实 VLM（Python Stub），仅验证执行管线",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_VISUAL_SCREENSHOT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.visual.screenshot",
    description:
      "【桌面·截图】截取电脑屏幕（或指定区域）并返回 PNG 图片。可用于查看当前屏幕内容、获取界面信息、记录屏幕状态等场景。需要 DESKTOP_VISUAL_ENABLED=1 或电脑桥接在线。",
    parameters: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "可选截屏区域 [left, top, width, height]；省略则截取全屏",
        },
      },
      additionalProperties: false,
    },
  },
};

const DESKTOP_RUN_SHELL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.run_shell",
    description:
      "【桌面·受控 Shell】在已绑定电脑（与 userId 一致）上执行一条 shell 命令（cmd / powershell / bash），返回 stdout / stderr / exitCode。" +
      "**优先级**：打开软件/文件/网页 → 用 desktop.open；常用操作（列目录/读文件/ping/查进程等）→ 用 desktop.run_preset；仅当预设覆盖不到时才用本工具裸拼命令。" +
      "⚠ **禁止用本工具搜索应用安装路径**（如 `Get-ChildItem -Recurse -Filter 'xxx*'`、`where.exe xxx.exe`）。" +
      "打开软件请直接传裸名给 desktop.open（如 `desktop.open({target:'app', path:'豆包'}`），" +
      "它会自动跨盘符扫描 Program Files / AppData / 非系统盘根目录、展开中英别名、兜底走开始菜单 .lnk 快捷方式。" +
      "Windows 下未指定 shell 时按命令内容自动判定：简单单行命令走 cmd，cmdlet/管道/变量走 powershell。" +
      "默认**白名单**模式：仅允许只读命令（dir / ls / cat / type / Get-ChildItem / Get-Process / systeminfo / ipconfig / Test-NetConnection 等）。" +
      "如需写入/删除/启停服务等操作，**必须**设置 allowDestructive=true（同时要求 server 端 DESKTOP_SHELL_ALLOWLIST=0、DESKTOP_BRIDGE_TOKEN ≥8 字符）。" +
      "高危命令（Remove-Item / del / rmdir / reg / Stop-Service / shutdown / sudo / chmod 0xxx / chown / dd / mkfs / kill -9 / |Out-File / Invoke-Expression）一律拒。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令字符串；不要包含跨工具逃逸语法（Invoke-Expression / 编码命令 / 管道到 Out-File 等）",
        },
        shell: {
          type: "string",
          enum: ["cmd", "powershell", "bash"],
          description: "强制指定 shell；省略则按 OS 自动（Windows=powershell，Linux/Mac=bash）",
        },
        cwd: {
          type: "string",
          description: "可选工作目录（绝对路径）",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 300000,
          description: "命令超时（毫秒），默认 30000，上限 300000（5 分钟）",
        },
        allowDestructive: {
          type: "boolean",
          description:
            "允许非白名单但非黑名单的命令。**仅在 server 端显式设置 DESKTOP_SHELL_ALLOWLIST=0 时才生效**。",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_OPEN_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.open",
    description:
      "【桌面·原生打开·最高优先】用操作系统原生 API 打开文件/网页/软件（不走 shell，不经白名单判定，启动最快，不消耗 VLM token）。" +
      "⚠ **打开任何软件/文件/网页时，必须最先调用本工具**，不要用 desktop.visual.run_task 或 desktop.run_shell 的 start 命令。" +
      "- target=url：用默认浏览器打开网页（如 https://example.com）" +
      "- target=file：用系统默认程序打开文件（如 .pdf/.docx/.txt/.png）" +
      "- target=app：直接启动可执行文件或快捷方式（如 WeChat.exe / notepad.exe / C:\\Program Files\\Tencent\\WeChat\\WeChat.exe）。" +
      "**app 模式找不到路径时**：传裸名即可（中文 / 英文 / 缩写都支持），" +
      "后端会自动展开中英别名（豆包↔doubao、WeChat↔Weixin、QQ↔TencentQQ、Feishu↔Lark 等），" +
      "跨盘符扫描 Program Files / AppData\\Local\\Programs / 非系统盘根目录 / 桌面，最后兜底走开始菜单 .lnk 快捷方式。" +
      "若仍找不到，把完整可执行文件路径直接传过来即可。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["file", "url", "app"],
          description: "打开目标类型：file=文件，url=网页，app=可执行程序",
        },
        path: {
          type: "string",
          description: "文件绝对路径 / 网页 URL / 可执行文件路径或名称",
        },
      },
      required: ["target", "path"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_RUN_PRESET_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.run_preset",
    description:
      "【桌面·预设命令】调用预打包的常用 shell 命令（token 更省，无需裸拼命令字符串）。" +
      "常用只读操作**优先**用本工具，仅在预设覆盖不到时才用 desktop.run_shell。" +
      "预设目录（preset 名 + args）:\n" +
      "CMD 类: list_dir{path} | read_file{path} | file_info{path} | find_files{path,pattern} | " +
      "ping{host,count?} | ipconfig{all?} | netstat{} | nslookup{host} | systeminfo{} | tasklist{filter?}\n" +
      "PowerShell 类: processes{name?} | services{status?} | disk_usage{} | env_vars{} | " +
      "installed_apps{} | find_app{name} | network_adapter{}\n" +
      "CMD 类: find_executable{name,dirs?}（name=exe名如 WeChat.exe，支持通配符；dirs=分号分隔目录或省略=搜全盘）",
    parameters: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: [
            "list_dir", "read_file", "file_info", "find_files",
            "ping", "ipconfig", "netstat", "nslookup", "systeminfo", "tasklist",
            "processes", "services", "disk_usage", "env_vars",
            "installed_apps", "network_adapter",
          ],
          description: "预设命令名（见上方目录）",
        },
        args: {
          type: "object",
          description:
            "预设参数对象。常见字段：path（文件路径）、host（主机名/IP）、pattern（文件名通配符）、" +
            "count（ping 次数，默认4）、all（ipconfig /all 布尔）、filter（tasklist 映像名过滤）、" +
            "name（进程名）、status（服务状态如 Running/Stopped）。无参数的预设省略 args。",
          additionalProperties: true,
        },
      },
      required: ["preset"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_UIA_QUERY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.uia_query",
    description:
      "【桌面·UIAutomation 查询】Windows UIAutomation 结构化查询，读取控件树/按 AutomationId 定位/检查坐标处元素。" +
      "场景：读 ListView/Tree 内容、按控件名精准定位、检查 (x,y) 处元素信息（含 Invoke 等支持的 pattern）。" +
      "非 Windows 或 pywinauto 未安装时返回 ok:false。返回元素含 name/automation_id/control_type/bbox/patterns。",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["query", "read_children", "inspect_point"],
          description:
            "query=按 selector 查找元素；read_children=读父元素子树（ListView/Tree 内容）；inspect_point=检查 (x,y) 处元素",
        },
        selector: {
          type: "object",
          description:
            "query/read_children 模式的选择条件。字段：control_type（Button/Edit/List/ListItem/Tree/TreeItem/Pane/Window 等）、name、automation_id",
          additionalProperties: true,
        },
        point: {
          type: "object",
          description: "inspect_point 模式的坐标",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" },
          },
        },
        topOnly: { type: "boolean", description: "query 模式：仅顶层（true）或递归（false），默认 true" },
        limit: { type: "integer", description: "返回元素上限，query 默认 100，read_children 默认 200" },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_RUN_INPUT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.run_input",
    description:
      "【桌面·原生输入·优先用】操作系统的键盘/鼠标模拟输入，**不走 VLM**，不消耗 VLM token，任何时候可用。" +
      "⚠ **打开软件后，打字 / 点击 / 快捷键 / 滚动必须优先用本工具**，不要用 desktop.visual.run_task（靠 VLM 看屏幕再点，又慢又贵还容易挂）。" +
      "支持的操作:\n" +
      "- click {x,y,button?}: 鼠标移动到 (x,y) 点击（button=left/right/middle，默认 left）\n" +
      "- double_click {x,y}: 双击\n" +
      "- right_click {x,y}: 右键\n" +
      "- move {x,y}: 移动鼠标不点击\n" +
      "- type {text}: 在光标位置输入文字（支持中文）\n" +
      "- key {key}: 按单键（enter/tab/esc/backspace/space/up/down/left/right/f1-f12 等）\n" +
      "- shortcut {keys}: 组合键（如 'ctrl+v' 粘贴，'ctrl+c' 复制，'alt+tab' 切换窗口）\n" +
      "- drag {x,y,toX,toY}: 拖拽\n" +
      "- scroll {scrollClicks}: 滚轮（正=向上，负=向下）\n" +
      "⚠ 使用前通常先调 desktop.uia_query 定位目标控件的 bbox 中心坐标，再对本工具传坐标。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "double_click", "right_click", "move", "type", "key", "shortcut", "drag", "scroll"],
          description: "输入操作类型",
        },
        x: { type: "number", description: "鼠标目标 X 坐标（click/move/double_click/right_click/drag 需要）" },
        y: { type: "number", description: "鼠标目标 Y 坐标" },
        toX: { type: "number", description: "拖拽终点 X 坐标（仅 drag 需要）" },
        toY: { type: "number", description: "拖拽终点 Y 坐标（仅 drag 需要）" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "鼠标按键，默认 left" },
        text: { type: "string", description: "要输入的文本（仅 type 需要，支持中文）" },
        key: { type: "string", description: "单键名（仅 key 需要），如 enter, tab, esc, backspace, space, f1-f12" },
        keys: { type: "string", description: "组合键（仅 shortcut 需要），用 + 分隔，如 'ctrl+v'、'alt+tab'" },
        scrollClicks: { type: "integer", description: "滚轮量（仅 scroll 需要），正=向上，负=向下" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_RUN_AUTOMATION_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.run_automation",
    description:
      "【桌面·UIA 原生控件操作·最高优先级】Windows UIAutomation pattern 直调,不模拟鼠标键盘,不抢焦点,不要求窗口在前台。" +
      "⚠ **支持 UIA 的应用(记事本/计算器/资源管理器/WPF/WinForms/Win32)优先用本工具**,不要用 desktop.run_input 模拟鼠标。" +
      "⚠ **Electron 自绘应用(微信新版/腾讯视频/QQ/抖音)内部控件 UIA 读不到,本工具返回 ok:false,需改用 desktop.run_input 坐标路径。**" +
      "\n支持的 action:\n" +
      "- click: 调 InvokePattern(等效点击按钮/菜单项,但不抢鼠标)\n" +
      "- set_value: 调 ValuePattern.SetValue(直接设置文本框内容,不模拟键盘,无需窗口在前台)\n" +
      "- get_value: 读 ValuePattern.CurrentValue\n" +
      "- toggle: 调 TogglePattern.Toggle(复选框/单选)\n" +
      "- focus: 调 SetFocus(设焦点)\n" +
      "\nselector 字段:name/name_contains/control_type/class_name/automation_id 任一组合。" +
      "匹配多个时默认操作第一个,可用 index 选第 N 个。" +
      "\n典型用法:\n" +
      "- 记事本输入:selector={control_type:'Edit'} action=set_value value='内容'\n" +
      "- 点按钮:selector={name:'确定',control_type:'Button'} action=click\n" +
      "- 读文本框:selector={control_type:'Edit'} action=get_value",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "set_value", "get_value", "toggle", "focus"],
          description: "原生控件操作类型",
        },
        selector: {
          type: "object",
          description: "UIA 查询条件,至少给一个字段",
          properties: {
            name: { type: "string", description: "元素 Name 精确匹配" },
            name_contains: { type: "string", description: "Name 子串匹配" },
            control_type: { type: "string", description: "控件类型:Button/Edit/List/ListItem/Window/Tree/TreeItem 等" },
            class_name: { type: "string", description: "ClassName 精确匹配" },
            automation_id: { type: "string", description: "AutomationId 精确匹配" },
          },
        },
        value: { type: "string", description: "set_value 时要设置的文本内容" },
        index: { type: "integer", description: "匹配多个元素时选第 N 个(0-based,默认 0)", default: 0 },
        topOnly: { type: "boolean", description: "是否仅查顶层(默认 true)", default: true },
      },
      required: ["action", "selector"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_HTTP_GET_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.http_get",
    description:
      "【系统层·原生 HTTP GET】用 requests 库发起 HTTP GET 请求,不走 shell 避免命令注入。\n" +
      "**仅支持 GET(只读)**,用于调外部 API 获取实时信息(天气/股价/翻译/汇率/公开 API 等)。\n" +
      "\n安全约束(自动执行):\n" +
      "- 仅允许 http/https scheme\n" +
      "- 默认拒绝 localhost/127.x/内网 IP(防 SSRF),除非环境变量 DESKTOP_VISUAL_HTTP_GET_ALLOW_PRIVATE=1\n" +
      "- 超时默认 15s,上限 60s\n" +
      "- 响应体截断到 256KB(防 OOM)\n" +
      "\n**禁止用 desktop.run_shell 拼 curl 命令,改用本工具**——避免 shell 注入风险,且更省 token。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "目标 URL,必须以 http:// 或 https:// 开头",
        },
        headers: {
          type: "object",
          description: "自定义 HTTP headers(可选)。如 {\"Authorization\": \"Bearer xxx\"}",
          additionalProperties: { type: "string" },
        },
        timeoutMs: {
          type: "integer",
          description: "超时(毫秒),默认 15000,范围 1000-60000",
          default: 15000,
          minimum: 1000,
          maximum: 60000,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.web_search",
    description:
      "【系统层·桌面端联网搜索】用 requests 抓取 Bing CN 搜索结果,解析 HTML 提取标题/URL/摘要。\n" +
      "桌面本机直接联网,不依赖服务端。带 SSRF 防护。\n" +
      "适用场景:子任务需要查资料、找文档、搜新闻等。\n" +
      "与服务端 search_web 的区别:本工具在桌面本机执行,适合桌面控制上下文中需要联网的场景。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词(2-6 个核心词效果最佳)",
        },
        limit: {
          type: "integer",
          description: "返回条数,1-20,默认 8",
          default: 8,
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_WEB_FETCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.web_fetch",
    description:
      "【系统层·桌面端网页抓取】用 requests 抓取 URL,提取纯文本正文(去 HTML 标签/脚本/样式)。\n" +
      "返回标题+摘要+正文(截断 4KB)。带 SSRF 防护。\n" +
      "适用场景:从 desktop.web_search 或 search_web 拿到 URL 后,读取网页全文。\n" +
      "与服务端 fetch_web 的区别:本工具在桌面本机执行,适合桌面控制上下文中需要联网的场景。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要抓取的网页 URL,必须以 http:// 或 https:// 开头",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

/**
 * 完全访问模式下向模型暴露的定义（与 {@link getDesktopVisualChatTools} 环境门控无关）。
 *
 * 全部暴露给 LLM：desktop.open / desktop.run_preset / desktop.run_shell / desktop.uia_query
 * / desktop.run_automation / desktop.http_get / desktop.web_search / desktop.web_fetch
 */
export const DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  DESKTOP_VISUAL_SCREENSHOT_TOOL,
  DESKTOP_VISUAL_RUN_TASK_TOOL,
  DESKTOP_OPEN_TOOL,
  DESKTOP_RUN_PRESET_TOOL,
  DESKTOP_RUN_SHELL_TOOL,
  DESKTOP_UIA_QUERY_TOOL,
  DESKTOP_RUN_INPUT_TOOL,
  DESKTOP_RUN_AUTOMATION_TOOL,
  DESKTOP_HTTP_GET_TOOL,
  DESKTOP_WEB_SEARCH_TOOL,
  DESKTOP_WEB_FETCH_TOOL,
];

export function getDesktopVisualChatTools(env: NodeJS.ProcessEnv = process.env): ChatCompletionTool[] {
  if (!isDesktopVisualControlChatToolsEnabled(env)) return [];
  return DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS;
}
