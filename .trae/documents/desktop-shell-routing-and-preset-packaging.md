# 桌面命令分层路由 + 预设命令打包方案

## 摘要

按用户要求建立三层命令执行优先级：**原生 API（打开软件/文件/网页）→ CMD（简单/bat/单行）→ PowerShell（系统查询/批量/管理员/复杂自动化）**，并把常用命令打包成预设函数以降低 token 消耗。

当前项目存在三个空白点（详见现状分析）：
1. **完全没有原生打开 API**（ShellExecute / os.startfile / webbrowser 全缺），打开文件/网页只能绕道 `desktop.run_shell` 的 `start` 命令，而 `start` 又不在白名单。
2. **Windows 默认 shell 一律走 PowerShell**（`shell_policy.py::_detect_shell` 第 130 行），简单 `dir`/`type` 也启动 PS 进程，冷启动慢。
3. **无命令模板库**，LLM 每次裸拼 shell 字符串，token 高、易出错、难审计。

---

## 现状分析

### 当前路由逻辑

| 场景 | 当前路由 | 问题 |
|---|---|---|
| 打开文件/软件/网页 | 只能走 `desktop.run_shell`（`start xxx`），`start` 不在白名单 | 需 `allowDestructive=true`，绕远路 |
| 默认 shell（未指定） | Windows → PowerShell（`_detect_shell` 第 130 行） | 简单 `dir` 也启动 PS，冷启动 ~300ms |
| 显式 shell | 按 LLM 传入 `cmd\|powershell\|bash` | LLM 无取舍指引，倾向不传 → 走 PS |
| 命令策略判定 | 黑名单 → regex → 白名单 → allowDestructive | OK，保留 |

### 关键文件

**服务端（Node）：**
- `server/src/tools/desktop-visual-tools.ts`（第 140-236 行）— `desktop.run_shell` 注册 + 路由（桥接优先 → 本机 Python）
- `server/src/tools/desktop-visual-chat-tools.ts`（第 81-122 行）— `DESKTOP_RUN_SHELL_TOOL` schema + 描述
- `server/src/services/desktop-visual-port.ts` — `DesktopVisualPort` 接口（`runShell?` 可选方法）
- `server/src/services/desktop-visual-subprocess.ts`（第 229 行）— `runShell` 实现
- `server/src/tools/capability-modules/index.ts` — 能力模块打包范式（`CapabilityModule` 接口）

**桌面端（Python）：**
- `desktop-visual/desktop_visual/shell_policy.py` — 白/黑名单 + regex + `_detect_shell`（第 127-132 行）
- `desktop-visual/desktop_visual/stdio_worker.py`（第 73-210 行）— `_handle_run_shell` 实际执行
- `desktop-visual/desktop_visual/bridge_ws_client.py`（第 78-102 行）— 桥接 action 分发（`screenshot`/`run_shell`/else `run_task`）

### 现有打包范式（capability-modules）

每个能力域目录 4 文件：`chat-tools.ts` / `handlers.ts` / `intent.ts` / `index.ts`，在 `buildCapabilityModules` 数组追加一项即可自动合并工具 schema + 意图规则。现有 8 个模块。

---

## 方案设计

### 决策 1：新增原生打开能力 `desktop.open`（最高优先级，绕过 shell）

**Node 侧** — 在 `desktop-visual-tools.ts` 新增工具注册：
- 工具名 `desktop.open`
- 参数：`target`（`"file" | "url" | "app"`）、`path`（文件/网页/可执行文件路径）
- 不走 `runShell`，直接发 `{action: "open", target, path}` 到 Python 端
- 路由与 `run_shell` 一致：桥接优先 → 本机 Python
- 审计落 `deps.audit.record({kind: "desktop.open", ...})`
- **不受 `DESKTOP_SHELL_ENABLED` 门控**，只要桌面能力开启（`isDesktopBridgeEnvOn` 或 `DESKTOP_VISUAL_ENABLED`）即可用

**Python 侧** — `stdio_worker.py` 新增 `_handle_open(req)`：
```python
async def _handle_open(req: dict) -> dict:
    target = req.get("target")  # file | url | app
    path = req.get("path")
    # url → webbrowser.open(path)（跨平台，不启动 shell）
    # file → os.startfile(path)（Windows）/ subprocess.Popen(['xdg-open', path])（Linux）
    # app → subprocess.Popen([path])（无 shell=True，直接启动可执行文件）
```
- **完全不经过 `shell_policy.py`**，因为不涉及 shell
- 仅做基本校验：路径非空、`target` 合法

**桥接侧** — `bridge_ws_client.py` 第 78-102 行的 action 分发新增分支：
```python
elif action == "open":
    worker_req = {
        "action": "open",
        "target": pl.get("target"),
        "path": pl.get("path"),
    }
```

**端口接口** — `desktop-visual-port.ts` 新增 `open?` 方法：
```ts
open?(input: { target: "file" | "url" | "app"; path: string }): Promise<{ ok: boolean; error?: string }>;
```

### 决策 2：新增 `classify_shell()` 自动 CMD/PowerShell 路由

在 `shell_policy.py` 新增分类函数，修改 `_detect_shell` 在未显式指定 shell 时调用它：

```python
def classify_shell(command: str) -> Literal["cmd", "powershell"]:
    """
    自动判定命令应走 cmd 还是 powershell。
    - CMD：bat 文件、单行简单文件操作、轻量终端指令（无管道/变量/cmdlet）
    - PowerShell：cmdlet 名（Get-/Set-/Stop- 等）、管道 |、变量 $、foreach、复杂多语句
    """
    cmd = command.strip()
    first = _first_token(cmd).lower()

    # PowerShell 特征：cmdlet 前缀 / 管道 / 变量 / 复杂语法
    if re.search(r'\b(Get|Set|Stop|Start|Restart|New|Remove|Add|Clear|Out|Select|Where|Sort|Format|Measure|Group|Test|Resolve|Convert|Invoke|Export|Import)-', cmd, re.IGNORECASE):
        return "powershell"
    if '|' in cmd or '$' in cmd or 'foreach' in cmd.lower():
        return "powershell"
    # 多语句（分号分隔的复合命令）→ PowerShell
    if ';' in cmd and not cmd.lower().startswith(('echo', 'set')):
        return "powershell"

    # 其余全部走 CMD（包括 bat 文件、dir/type/echo/ping/ipconfig 等单行命令）
    return "cmd"
```

修改 `_detect_shell`：
```python
def _detect_shell(explicit: str | None, command: str = "") -> Literal["cmd", "powershell", "bash"]:
    if explicit in ("cmd", "powershell", "bash"):
        return explicit
    if os.name == "nt":
        return classify_shell(command) if command.strip() else "cmd"  # 原来固定返回 "powershell"
    return "bash"
```

同步修改 `evaluate_shell_command` 第 181 行调用：`detected = _detect_shell(shell, command)`。

### 决策 3：常用命令打包成预设函数 `desktop.run_preset`（降 token 核心）

**设计取舍**：用**单一工具 + 预设目录**而非 N 个独立工具。原因：
- 用户明确要求"打包成一个函数"
- 1 个工具 schema（~250 token）vs 15 个独立工具（~2000-3000 token）
- 预设目录写在 description 里，LLM 按名调用，参数结构化（path/host 等），远短于裸拼命令字符串

**Node 侧** — 在 `desktop-visual-tools.ts` 新增 `desktop.run_preset` 注册：
- 参数：`preset`（预设名）、`args`（对象，按预设含 path/host 等）
- 内部根据 preset 名查表构造命令字符串 + 选定 shell（CMD/PowerShell）
- 调用现有 `runShell` 管线（复用安全策略 + 审计 + 超时）
- 预设命令全部使用白名单 token（`dir`/`type`/`ping`/`Get-Process` 等已在白名单），无需 `allowDestructive`

**预设目录**（首版 16 条，按 shell 倾向分组）：

CMD 倾向（简单单行）：
| preset | args | 生成命令 | shell |
|---|---|---|---|
| `list_dir` | `{path}` | `dir "{path}"` | cmd |
| `read_file` | `{path}` | `type "{path}"` | cmd |
| `file_info` | `{path}` | `dir "{path}"` | cmd |
| `find_files` | `{path, pattern}` | `dir /s /b "{path}\{pattern}"` | cmd |
| `ping` | `{host, count?}` | `ping -n {count\|4} {host}` | cmd |
| `ipconfig` | `{all?}` | `ipconfig{ /all}` | cmd |
| `netstat` | `{}` | `netstat -an` | cmd |
| `nslookup` | `{host}` | `nslookup {host}` | cmd |
| `systeminfo` | `{}` | `systeminfo` | cmd |
| `tasklist` | `{filter?}` | `tasklist{ /fi "imagename eq {filter}"}` | cmd |

PowerShell 倾向（系统查询/批量）：
| preset | args | 生成命令 | shell |
|---|---|---|---|
| `processes` | `{name?}` | `Get-Process{ -Name {name}} \| Select-Object Name,Id,CPU,WS \| Format-Table -AutoSize` | powershell |
| `services` | `{status?}` | `Get-Service{ \| Where-Object {$_.Status -eq '{status}'}} \| Format-Table -AutoSize` | powershell |
| `disk_usage` | `{}` | `Get-PSDrive -PSProvider FileSystem \| Format-Table` | powershell |
| `env_vars` | `{}` | `Get-ChildItem Env: \| Format-Table` | powershell |
| `installed_apps` | `{}` | `Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* \| Select-Object DisplayName,DisplayVersion \| Format-Table -AutoSize` | powershell |
| `network_adapter` | `{}` | `Get-NetAdapter \| Format-Table` | powershell |

预设表实现为 Node 侧的 `Map<string, PresetDef>`，每条 `PresetDef = { shell, build: (args) => string }`。

**token 收益估算**：
- 裸调用：`desktop.run_shell({command: "Get-Process | Select-Object Name,Id,CPU,WS | Format-Table -AutoSize", shell: "powershell"})` ≈ 90 token
- 预设调用：`desktop.run_preset({preset: "processes"})` ≈ 20 token
- 节省 ~78%

### 决策 4：更新工具描述 + system prompt 指引

**`desktop-visual-chat-tools.ts`**：
1. 新增 `DESKTOP_OPEN_TOOL` schema（`desktop.open`）
2. 新增 `DESKTOP_RUN_PRESET_TOOL` schema（`desktop.run_preset`，description 含预设目录）
3. 更新 `DESKTOP_RUN_SHELL_TOOL` 描述，开头加优先级指引：
   > "优先级：打开软件/文件/网页 → 用 `desktop.open`；常用操作（列目录/读文件/ping/查进程等）→ 用 `desktop.run_preset`；仅当预设覆盖不到时才用本工具裸拼命令。Windows 下简单命令自动走 CMD，复杂命令走 PowerShell。"
4. 在 `getDesktopVisualChatTools` 中把两个新工具加入返回数组

**`server/src/agent/agent-access-mode.ts`**：
- 在桌面工具相关的 system prompt 片段（第 200/206/212 行附近）追加 shell 取舍指引：
  > "打开软件/文件/网页时**必须**用 `desktop.open`（原生 API，不走 shell）。常用只读命令优先用 `desktop.run_preset`（预设打包，token 更省）。仅在预设覆盖不到时用 `desktop.run_shell`。简单命令（dir/type/ping）走 cmd，复杂查询（Get-Process/Get-Service/管道）走 powershell。"

---

## 具体改动清单

### 文件 1：`desktop-visual/desktop_visual/shell_policy.py`
- **新增** `classify_shell(command)` 函数（~20 行）
- **修改** `_detect_shell` 签名加 `command: str = ""` 参数，Windows 分支调用 `classify_shell`
- **修改** `evaluate_shell_command` 第 181 行：`_detect_shell(shell)` → `_detect_shell(shell, command)`

### 文件 2：`desktop-visual/desktop_visual/stdio_worker.py`
- **新增** `_handle_open(req)` 异步函数（~30 行）：按 target 调 `os.startfile`/`webbrowser.open`/`subprocess.Popen`
- **修改** `_run()` 的 action 分发（第 225-228 行附近）：新增 `if action == "open": return await _handle_open(req)`

### 文件 3：`desktop-visual/desktop_visual/bridge_ws_client.py`
- **修改** action 分发（第 78-102 行）：新增 `elif action == "open":` 分支，构造 `worker_req = {"action": "open", "target": ..., "path": ...}`

### 文件 4：`server/src/tools/desktop-visual-chat-tools.ts`
- **新增** `DESKTOP_OPEN_TOOL` 常量（`desktop.open` schema）
- **新增** `DESKTOP_RUN_PRESET_TOOL` 常量（`desktop.run_preset` schema，description 含预设目录表）
- **修改** `DESKTOP_RUN_SHELL_TOOL` description 开头加优先级指引
- **修改** `DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS` 数组追加两个新工具
- **修改** `getDesktopVisualChatTools` 返回逻辑：`desktop.open` 不受 `DESKTOP_SHELL_ENABLED` 门控（只要桌面能力开就暴露）；`desktop.run_preset` 与 `desktop.run_shell` 同门控

### 文件 5：`server/src/tools/desktop-visual-tools.ts`
- **新增** `desktop.open` handler 注册（~40 行）：校验 → 审计 → 桥接/localVisual 路由 → 返回
- **新增** `desktop.run_preset` handler 注册（~50 行）：查预设表 → 构造命令 + shell → 复用现有 `runShell` 管线
- **新增** 预设表 `SHELL_PRESETS: Map<string, PresetDef>`（~80 行，16 条预设）
- **新增** 辅助函数 `buildPresetCommand(preset, args)` 和 `isDesktopOpenEnabled()` 门控

### 文件 6：`server/src/services/desktop-visual-port.ts`
- **新增** `DesktopVisualOpenInput` 类型
- **新增** `DesktopVisualOpenResult` 类型
- **修改** `DesktopVisualPort` 接口：新增 `open?(input: DesktopVisualOpenInput): Promise<DesktopVisualOpenResult>`

### 文件 7：`server/src/services/desktop-visual-subprocess.ts`
- **新增** `open(input)` 方法实现：spawn stdio_worker 发送 `{action: "open", ...}`

### 文件 8：`server/src/agent/agent-access-mode.ts`
- **修改** 桌面相关 system prompt 片段（第 200/206/212 行附近）：加 `desktop.open` / `desktop.run_preset` 优先级指引

---

## 假设与决策

1. **`desktop.open` 不受 `DESKTOP_SHELL_ENABLED` 门控**：因为不走 shell，安全风险远低于 shell。只要桌面能力开启（桥接或本机视觉）即可用。仍受 `DESKTOP_BRIDGE_TOKEN` 鉴权约束（与截图/视觉任务一致）。
2. **预设命令全部使用白名单 token**：`dir`/`type`/`ping`/`ipconfig`/`Get-Process`/`Get-Service` 等已在 `DEFAULT_ALLOWLIST` 中，预设调用走 `runShell` 时不需要 `allowDestructive`。若后续新增非白名单预设，再单独处理。
3. **预设表放 Node 侧**（不放 Python 侧）：Node 构造命令字符串后复用现有 `runShell` 管线，Python 侧零改动（除 `desktop.open` 的 `_handle_open`）。复用安全策略 + 审计 + 超时。
4. **`classify_shell` 仅影响未显式指定 shell 的场景**：LLM 仍可通过 `shell: "cmd"|"powershell"` 显式覆盖。预设命令的 shell 由 preset 表硬编码，不走 `classify_shell`。
5. **首版 16 条预设**：覆盖文件系统/网络/系统查询高频操作。后续可按需扩展，预设表是纯数据，扩展只需加一行。
6. **不改动 `tool-search/core-tool-library.ts`**：新工具默认 deferred（按需加载），不进核心层，避免基础 token 开销增加。

---

## 验证步骤

1. **单元测试 `classify_shell`**：
   - `dir C:\foo` → cmd
   - `Get-Process` → powershell
   - `type readme.txt` → cmd
   - `Get-Service | Where-Object {$_.Status -eq 'Running'}` → powershell
   - `ping 8.8.8.8` → cmd
   - `test.bat` → cmd

2. **`desktop.open` 端到端**：
   - 调 `desktop.open({target: "url", path: "https://example.com"})` → 浏览器打开
   - 调 `desktop.open({target: "file", path: "C:\\Users\\test\\doc.pdf"})` → 默认程序打开
   - 调 `desktop.open({target: "app", path: "notepad.exe"})` → 记事本启动
   - 确认不经过 `shell_policy.py`（日志无 `[run_shell]` 行，应有 `[open]` 行）

3. **`desktop.run_preset` 端到端**：
   - `desktop.run_preset({preset: "list_dir", args: {path: "C:\\"}})` → 返回 dir 结果，shell=cmd
   - `desktop.run_preset({preset: "processes"})` → 返回 Get-Process 结果，shell=powershell
   - `desktop.run_preset({preset: "ping", args: {host: "127.0.0.1"}})` → ping 结果，shell=cmd
   - 确认审计日志含 `kind: "desktop.run_shell"`（因为复用 runShell 管线）

4. **`desktop.run_shell` 默认 shell 路由**：
   - 不传 shell 调 `desktop.run_shell({command: "dir"})` → 日志 shell=cmd（原来是 powershell）
   - 不传 shell 调 `desktop.run_shell({command: "Get-Process"})` → 日志 shell=powershell

5. **token 消耗对比**：
   - 同一操作（如查进程）分别用 `run_shell` 裸拼 vs `run_preset`，对比工具调用 JSON token 数

6. **桥接路径验证**（如有 PC 端在线）：
   - PC 端 `bridge_ws_client.py` 能正确分发 `action: "open"` 到 stdio_worker
   - 返回结果正确回传到服务端
