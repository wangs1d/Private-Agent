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
      "【桌面·截图】截取电脑屏幕（支持多显示器与指定区域）并返回 PNG 图片。" +
      "返回字段含图片尺寸 width/height、实际截取区域 screenWidth/screenHeight、坐标倍率 scale" +
      "（scale>1 表示图片被降采样，此时若要用图片上的坐标操作屏幕，请在 desktop.run_input 传 " +
      "coordSpace:'image' + imageWidth/imageHeight，由系统自动换算；scale=1 时坐标可直接使用）。" +
      "需要 DESKTOP_VISUAL_ENABLED=1 或电脑桥接在线。",
    parameters: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "可选截屏区域 [left, top, width, height]（相对显示器左上角的物理像素）；省略则截取整屏",
        },
        display: {
          type: "integer",
          description: "可选显示器编号（1-based，从 desktop.window list 或截图返回值得知）；省略则主屏",
        },
        maxDim: {
          type: "integer",
          description: "可选图片最长边像素上限（≥200，如 1568）；超出时等比降采样并返回 scale",
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
      "场景：读 ListView/Tree 内容、按控件名精准定位、检查 (x,y) 处元素信息（含 Invoke 等支持的 pattern）、" +
      "对整个窗口做控件树快照（snapshot，元素带 path，可传给 desktop.run_automation 的 selector.path 复用）。" +
      "非 Windows 或 pywinauto 未安装时返回 ok:false。返回元素含 name/automation_id/control_type/bbox/patterns。" +
      "bbox 为屏幕物理像素，可直接作为 desktop.run_input 的坐标。",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["query", "read_children", "inspect_point", "snapshot"],
          description:
            "query=按 selector 查找元素；read_children=读父元素子树（ListView/Tree 内容）；inspect_point=检查 (x,y) 处元素；" +
            "snapshot=前台/指定窗口的控件树扁平快照（推荐先 snapshot 再按 name/automation_id/path 操作）",
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
        windowTitle: {
          type: "string",
          description: "可选：把查询范围限定到标题含此子串的顶层窗口（大小写不敏感）；snapshot 模式省略时取前台窗口",
        },
        maxDepth: {
          type: "integer",
          description: "snapshot 模式：控件树最大深度，默认 6",
        },
        topOnly: { type: "boolean", description: "query 模式：仅顶层（true）或递归（false），默认 true" },
        limit: { type: "integer", description: "返回元素上限，query 默认 100，read_children 默认 200，snapshot 默认 150" },
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
      "支持的操作（对齐主流 computer-use 动作空间）:\n" +
      "- click {x,y,button?}: 鼠标移动到 (x,y) 点击（button=left/right/middle，默认 left）\n" +
      "- double_click {x,y} / triple_click {x,y}: 双击 / 三击（三击常用于选中整段文字）\n" +
      "- right_click {x,y} / middle_click {x,y}: 右键 / 中键\n" +
      "- move {x,y}: 移动鼠标不点击\n" +
      "- type {text}: 在光标位置输入文字；中文/emoji 自动走剪贴板粘贴，ASCII 逐字输入\n" +
      "- key {key}: 按单键（enter/tab/esc/backspace/space/delete/up/down/left/right/f1-f12 等）\n" +
      "- shortcut {keys}: 组合键（如 'ctrl+v' 粘贴，'alt+tab' 切换窗口）\n" +
      "- hold_key {key,holdSeconds?}: 按住某键一段时间\n" +
      "- drag {x,y,toX,toY,button?}: 拖拽\n" +
      "- scroll {scrollClicks?,scrollX?,x?,y?}: 滚轮（scrollClicks 正=上/负=下；scrollX 正=右/负=左；传 x,y 可先移到目标位置再滚）\n" +
      "- wait {waitMs?}: 等待界面加载（默认 500ms，上限 10s）。点击触发加载后建议 wait 1-2s\n" +
      "- cursor_position {}: 读取当前鼠标坐标\n" +
      "⚠ 坐标默认为屏幕物理像素。使用前通常先调 desktop.uia_query 定位目标控件的 bbox 中心；" +
      "若用的是降采样截图上的坐标，传 coordSpace:'image' + 截图返回的 imageWidth/imageHeight。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "click", "double_click", "triple_click", "middle_click", "right_click",
            "move", "type", "key", "shortcut", "drag", "scroll",
            "wait", "cursor_position", "hold_key",
          ],
          description: "输入操作类型",
        },
        x: { type: "number", description: "鼠标目标 X 坐标（click/move/drag/scroll 需要；屏幕物理像素或 image 空间）" },
        y: { type: "number", description: "鼠标目标 Y 坐标" },
        toX: { type: "number", description: "拖拽终点 X 坐标（仅 drag 需要）" },
        toY: { type: "number", description: "拖拽终点 Y 坐标（仅 drag 需要）" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "鼠标按键，默认 left" },
        text: { type: "string", description: "要输入的文本（仅 type 需要，支持中文/emoji）" },
        key: { type: "string", description: "单键名（key/hold_key 需要），如 enter, tab, esc, backspace, space, f1-f12" },
        keys: { type: "string", description: "组合键（仅 shortcut 需要），用 + 分隔，如 'ctrl+v'、'alt+tab'" },
        scrollClicks: { type: "integer", description: "垂直滚轮量（scroll），正=向上，负=向下" },
        scrollX: { type: "integer", description: "水平滚轮量（scroll 可选），正=向右，负=向左" },
        waitMs: { type: "integer", description: "等待毫秒（仅 wait，默认 500，上限 10000）" },
        holdSeconds: { type: "number", description: "按住秒数（仅 hold_key，默认 0.5，上限 5）" },
        interval: { type: "number", description: "按键间隔秒数（type/click 可选）" },
        moveDuration: { type: "number", description: "鼠标平滑移动秒数（click/move/drag 可选，0=瞬间）" },
        imageWidth: { type: "number", description: "coordSpace='image' 时必传：截图返回的 width" },
        imageHeight: { type: "number", description: "coordSpace='image' 时必传：截图返回的 height" },
        coordSpace: {
          type: "string",
          enum: ["screen", "image"],
          description: "坐标空间：screen=屏幕物理像素（默认）；image=截图像素（配合 imageWidth/imageHeight）",
        },
        display: { type: "integer", description: "image 坐标对应的显示器编号（默认主屏）" },
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
      "- select: 调 SelectionItemPattern.Select(选中列表项/树节点)\n" +
      "- expand / collapse: 调 ExpandCollapsePattern(展开/折叠下拉框、树节点)\n" +
      "- scroll_into_view: 调 ScrollItemPattern(把元素滚动到可见区域)\n" +
      "\n定位方式(二选一):\n" +
      "- selector: name/name_contains/control_type/class_name/automation_id 组合;" +
      "- selector.path: desktop.uia_query(mode='snapshot') 输出的元素 path(如 '2.1.3'),跨调用稳定,推荐用。\n" +
      "windowTitle 可把查找范围限定到指定窗口,避免跨应用误匹配。" +
      "\n典型用法:\n" +
      "- 记事本输入:selector={control_type:'Edit'} action=set_value value='内容'\n" +
      "- 点按钮:selector={name:'确定',control_type:'Button'} action=click\n" +
      "- 读文本框:selector={control_type:'Edit'} action=get_value",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "click", "set_value", "get_value", "toggle", "focus",
            "select", "expand", "collapse", "scroll_into_view",
          ],
          description: "原生控件操作类型",
        },
        selector: {
          type: "object",
          description: "UIA 查询条件,至少给一个字段;path 与其他字段二选一",
          properties: {
            name: { type: "string", description: "元素 Name 精确匹配" },
            name_contains: { type: "string", description: "Name 子串匹配" },
            control_type: { type: "string", description: "控件类型:Button/Edit/List/ListItem/Window/Tree/TreeItem 等" },
            class_name: { type: "string", description: "ClassName 精确匹配" },
            automation_id: { type: "string", description: "AutomationId 精确匹配" },
            path: { type: "string", description: "snapshot 输出的元素路径(如 '2.1.3'),按控制视图子索引复原元素" },
          },
        },
        value: { type: "string", description: "set_value 时要设置的文本内容" },
        index: { type: "integer", description: "匹配多个元素时选第 N 个(0-based,默认 0)", default: 0 },
        topOnly: { type: "boolean", description: "是否仅查顶层(默认 true)", default: true },
        windowTitle: { type: "string", description: "限定目标窗口(标题子串,大小写不敏感),避免跨应用误匹配" },
      },
      required: ["action", "selector"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_WINDOW_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.window",
    description:
      "【桌面·窗口管理】枚举与操控电脑上的顶层窗口（主流 computer-use / OS agent 标配）。" +
      "支持的操作:\n" +
      "- list: 枚举所有可见顶层窗口（标题/hwnd/位置/进程名/是否前台），编号 index 用于后续定位\n" +
      "- activate: 激活窗口到前台（配合打字/快捷键前使用）\n" +
      "- close: 关闭窗口（走应用正常关闭流程，可能弹保存确认）\n" +
      "- minimize / maximize / restore: 最小化 / 最大化 / 还原\n" +
      "- move {x,y}: 移动窗口到指定位置（屏幕物理像素）\n" +
      "- resize {width,height}: 调整窗口尺寸（物理像素）\n" +
      "\n定位方式（list 之外的操作必填其一）: title（标题子串，大小写不敏感）、hwnd、index（list 输出的编号）。" +
      "典型用法:先 list 找到目标窗口 → activate → 再用 desktop.uia_query / desktop.run_input 操作。",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "activate", "close", "minimize", "maximize", "restore", "move", "resize"],
          description: "窗口操作类型",
        },
        title: { type: "string", description: "窗口标题子串（大小写不敏感）" },
        hwnd: { type: "integer", description: "窗口句柄（list 输出）" },
        index: { type: "integer", description: "list 输出的窗口编号（1-based）" },
        x: { type: "integer", description: "move 的目标 X（屏幕物理像素）" },
        y: { type: "integer", description: "move 的目标 Y" },
        width: { type: "integer", description: "resize 的目标宽（物理像素）" },
        height: { type: "integer", description: "resize 的目标高（物理像素）" },
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_CLIPBOARD_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.clipboard",
    description:
      "【桌面·剪贴板】读写电脑剪贴板文本（get / set）。" +
      "用途：把长文本放入剪贴板后用 desktop.run_input 的 ctrl+v 粘贴；" +
      "读取用户复制的文本（如选中的一段话）供后续处理。" +
      "注意：set 会覆盖用户当前剪贴板内容，仅在确有必要时使用。",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["get", "set"],
          description: "get=读取剪贴板文本；set=写入剪贴板",
        },
        text: { type: "string", description: "set 时要写入的文本" },
      },
      required: ["op"],
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
          description: "搜索关键词（完整、具体，按要查的内容语义组织）",
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
 * / desktop.window / desktop.clipboard
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
  DESKTOP_WINDOW_TOOL,
  DESKTOP_CLIPBOARD_TOOL,
  DESKTOP_HTTP_GET_TOOL,
  DESKTOP_WEB_SEARCH_TOOL,
  DESKTOP_WEB_FETCH_TOOL,
];

export function getDesktopVisualChatTools(env: NodeJS.ProcessEnv = process.env): ChatCompletionTool[] {
  if (!isDesktopVisualControlChatToolsEnabled(env)) return [];
  return DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS;
}
