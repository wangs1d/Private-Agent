# Windows UIAutomation 集成方案（pywinauto）

## 摘要

在 `desktop-visual` 桌面自动化栈中引入 Windows UIAutomation（UIA）能力，与现有"截图 + VLM + pyautogui 像素级键鼠"形成**双轨联控**：
- **隐式兜底**：VLM 输出 `click(x,y)` 时，循环内自动用 UIA 校验该坐标对应元素，若该元素支持 `InvokePattern` 则用 UIA 调用替代像素点击，规避遮挡/动画/半透明场景下的像素漂移
- **显式查询**：新增 `desktop.uia_query` 工具供主 agent 内部调用（不暴露 LLM），用于读取 ListView/DataGrid/Tree 等结构化控件内容、按控件名/AutomationId 精准定位

**技术选型**：pywinauto（高层 API，跨 Win32/UIA/WinForms/WPF/Electron 框架，纯 pip 装）。其内部已用 comtypes 包装 `IUIAutomation`，未来若需要 pywinauto 不支持的新 WinUI 3 / Edge WebView2 内部场景，可零冲突下沉到 comtypes 直调。

## 现状分析

### 当前桌面自动化栈

| 层 | 文件 | 现状 |
|---|---|---|
| 动作枚举 | [structured_output.py](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/structured_output.py#L9-L18) | `ActionKind` 仅 9 个：click/double_click/right_click/move/scroll/type/key/wait/done |
| 动作注册表 | [tools.py](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/tools.py) | `DesktopTools` 类已定义但 `VisualDesktopLoop._execute` 没用，硬编码 if/elif |
| 执行循环 | [visual_loop.py](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/visual_loop.py#L194-L246) | `_execute()` 只分派像素级键鼠，无 UIA 分支 |
| 鼠标控制器 | [runtime/mouse_controller.py](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/runtime/mouse_controller.py#L6-L7) | pyautogui + pynput，无 UIA |
| 桥接分发 | [stdio_worker.py:268-275](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/stdio_worker.py#L268-L275) | action 仅 `screenshot`/`open`/`run_shell`/else `run_task` |
| 桥接客户端 | [bridge_ws_client.py](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/bridge_ws_client.py) | 同上分发逻辑 |
| 依赖 | [requirements.txt](file:///e:/ws-project/Private-Agent/desktop-visual/requirements.txt) | 无 pywinauto / comtypes |

### 现状空白点

1. **无 UIA 调用**：全仓 grep `pywinauto`/`comtypes`/`IUIAutomation` 全部 0 命中
2. **VLM 像素漂移无兜底**：遮挡/动画/半透明/DPI 缩放场景下像素点击失败无救
3. **结构化控件读取缺失**：ListView/DataGrid/Tree 内容只能靠 OCR，长列表/树形结构必然失败

## 方案设计

### 决策 1：新增 `runtime/uia_controller.py`（核心封装）

封装 pywinauto 调用，提供两类能力：

**A. 坐标兜底**（`element_at(x, y) → ElementInfo | None`）：
- 用 `pywinauto.uia_defines.IUIAutomation().ElementFromPoint(POINT)` 拿到坐标处元素
- 返回 `{name, automation_id, control_type, patterns: ["Invoke", "SelectionItem", ...], bbox}`
- 若元素支持 `InvokePattern`，提供 `invoke(element)` 方法直接调用（替代像素点击）

**B. 结构化查询**（`query(selector) → list[ElementInfo]`）：
- selector 支持：`{name?, automation_id?, control_type?, parent?}` 多条件组合
- 返回匹配元素列表（含 bbox / patterns / 子树）
- 用于读 ListView/Tree 内容（`control_type="ListItem"` + `parent=<某 List>`）

**关键设计**：
- 单例懒加载（首次调用 `import pywinauto`），失败降级到 None（不影响视觉循环）
- 仅 Windows 可用，`os.name != "nt"` 时 `is_available() → False`
- 元素 bbox 转换为屏幕坐标，方便 VLM 后续像素操作
- 内部用 `try/except` 包裹所有 UIA 调用，UIA 失败不阻塞循环

### 决策 2：`visual_loop` 隐式兜底（循环内自动用 UIA）

修改 [visual_loop.py:204-209](file:///e:/ws-project/Private-Agent/desktop-visual/desktop_visual/visual_loop.py#L204-L209) `click/double_click/right_click` 分支：

```python
async def _execute(self, kind, payload):
    # ... 现有 move 等
    if kind == "click":
        x, y = xy()
        button = str(payload.get("button", "left"))
        clicks = int(payload.get("clicks", 1) or 1)
        # 隐式 UIA 兜底：若该坐标元素支持 Invoke，优先用 UIA
        uia_used = self._maybe_uia_invoke(x, y)
        if uia_used:
            return False, f"uia_invoke ({x},{y}) [button={button} skipped]"
        self._pointer.click(x, y, button=button, clicks=clicks)
        return False, f"click ({x},{y}) x{clicks}"
    # ... 其他

def _maybe_uia_invoke(self, x: int, y: int) -> bool:
    if not self._uia or not self._uia.is_available():
        return False
    try:
        elem = self._uia.element_at(x, y)
        if elem and "Invoke" in elem.get("patterns", []):
            return self._uia.invoke(elem)
    except Exception as exc:
        logger.warning("UIA 兜底失败，回退像素点击: %s", exc)
    return False
```

**兜底策略**：
- 仅当元素支持 `InvokePattern` 才用 UIA（按钮/链接/菜单项等可点击控件）
- 文本框/列表/滚动条等不支持 Invoke 的控件继续走像素点击
- UIA 失败立即回退像素点击，不阻塞循环

### 决策 3：新增 `desktop.uia_query` 工具（主 agent 内部用，不暴露 LLM）

与 `desktop.open`/`desktop.run_preset` 一致，handler 注册到 ToolRegistry 但不进 `DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS`：

**Python 侧** — `stdio_worker.py` 新增 `_handle_uia_query(req)`：
```python
def _handle_uia_query(req: dict) -> dict:
    selector = req.get("selector", {})
    mode = req.get("mode", "query")  # query | read_children | inspect_point
    # mode=query: 按 selector 查找元素
    # mode=read_children: 读元素子树（ListView/Tree 内容）
    # mode=inspect_point: 检查 (x,y) 处元素（返回 name/id/type/patterns/bbox）
```

**Node 侧** — `desktop-visual-tools.ts` 新增 handler 注册：
- 工具名 `desktop.uia_query`
- 参数：`mode`（query/read_children/inspect_point）、`selector`（对象）、`point`（{x,y}）
- 路由：桥接优先 → 本机 Python
- 审计：`deps.audit.record({kind: "desktop.uia_query", ...})`
- 不受 `DESKTOP_SHELL_ENABLED` 门控（与 `desktop.open` 一致）

**端口接口** — `desktop-visual-port.ts` 新增 `uiaQuery?` 方法。

### 决策 4：依赖与降级

**requirements.txt** 追加：
```
pywinauto>=0.6.8
```

**降级策略**：
- pywinauto import 失败 → `UiaController.is_available() → False`，循环跳过 UIA 兜底
- 非 Windows 环境 → 同上
- UIA 调用抛异常 → 兜底失败，回退像素点击，记 warning 日志
- 主 agent 调 `desktop.uia_query` 但 UIA 不可用 → 返回 `{ok: false, error: "UIA 不可用（非 Windows 或 pywinauto 未安装）"}`

### 决策 5：DPI 处理

pywinauto 默认走 per-monitor DPI aware；pyautogui 截图也是物理像素。两者坐标系一致，无需额外转换。但 `ElementFromPoint` 需要传**逻辑像素**（DPI 缩放后），所以 `uia_controller` 内部要：
- 取系统 DPI 缩放比（`ctypes.windll.user32.GetDpiForWindow(0) / 96.0`）
- 把 VLM 输出的物理坐标 / DPI 缩放比 = 逻辑坐标，再传给 `ElementFromPoint`

## 具体改动清单

### 文件 1：`desktop-visual/requirements.txt`
- **追加** `pywinauto>=0.6.8`

### 文件 2：`desktop-visual/desktop_visual/runtime/uia_controller.py`（新增，~180 行）
核心封装模块：
- `class UiaController`：单例懒加载
  - `is_available() -> bool`
  - `element_at(x: int, y: int) -> ElementInfo | None`：坐标 → 元素
  - `invoke(element) -> bool`：调用 InvokePattern
  - `query(selector: dict) -> list[ElementInfo]`：按条件查询
  - `read_children(element) -> list[ElementInfo]`：读子树
  - `inspect_point(x, y) -> dict`：综合检查（含 patterns/bbox）
- `ElementInfo` TypedDict：`{name, automation_id, control_type, class_name, bbox, patterns, is_enabled, is_offscreen}`
- DPI 缩放辅助函数 `_to_logical_point(x, y)`
- pywinauto import 失败时所有方法返回安全默认值

### 文件 3：`desktop-visual/desktop_visual/visual_loop.py`
- **修改** `__init__`：注入 `uia: UiaController | None = None`
- **修改** `_execute` 的 click/double_click/right_click 分支：插入 `_maybe_uia_invoke(x, y)` 兜底
- **新增** `_maybe_uia_invoke(x, y) -> bool` 方法

### 文件 4：`desktop-visual/desktop_visual/stdio_worker.py`
- **新增** `_handle_uia_query(req)` 函数（~50 行）：按 mode 路由到 UiaController
- **修改** `_run()` action 分发：新增 `if action == "uia_query": return _handle_uia_query(req)`
- **修改** `run_task` 路径：构造 `VisualDesktopLoop` 时注入 `UiaController()` 实例（仅 Windows）

### 文件 5：`desktop-visual/desktop_visual/bridge_ws_client.py`
- **修改** action 分发：新增 `elif action == "uia_query":` 分支，构造 `worker_req = {"action": "uia_query", "mode": ..., "selector": ..., "point": ...}`

### 文件 6：`server/src/services/desktop-visual-port.ts`
- **新增** `DesktopVisualUiaQueryInput` 类型（`mode`/`selector`/`point`）
- **新增** `DesktopVisualUiaQueryResult` 类型（`ok`/`elements`/`error`）
- **修改** `DesktopVisualPort` 接口：新增 `uiaQuery?(input)`

### 文件 7：`server/src/services/desktop-visual-subprocess.ts`
- **新增** `uiaQuery(input)` 方法实现：spawn stdio_worker 发送 `{action: "uia_query", ...}`

### 文件 8：`server/src/tools/desktop-visual-tools.ts`
- **新增** `desktop.uia_query` handler 注册（~50 行）：校验 → 审计 → 桥接/localVisual 路由 → 返回
- 不暴露 LLM（不进 `DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS`）
- 不受 `DESKTOP_SHELL_ENABLED` 门控

## 假设与决策

1. **pywinauto 而非 comtypes 直调**：高层 API 开发快，覆盖 90% 场景；内部本就用 comtypes 包装 IUIAutomation，未来要扩底层零冲突
2. **隐式兜底不暴露 LLM**：UIA 兜底全靠循环代码自己判断，LLM schema 不变 token 不增
3. **仅 InvokePattern 触发兜底**：避免对文本框/列表/滚动条误用 UIA（这些控件本就不支持 Invoke）
4. **DPI 处理**：VLM 输出物理坐标，UIA 需逻辑坐标，controller 内部转换
5. **降级安全**：pywinauto import 失败/UIA 调用异常/非 Windows 全部安全降级，不阻塞视觉循环
6. **desktop.uia_query 不暴露 LLM**：与 desktop.open/run_preset 一致，主 agent 内部调用

## 验证步骤

1. **依赖安装**：`pip install pywinauto`，确认 `from pywinauto.uia_defines import IUIAutomation` 可导入

2. **UiaController 单元测试**：
   - `is_available()` 在 Windows 返回 True
   - `element_at(100, 100)` 返回当前桌面元素（name/control_type 非空）
   - `inspect_point(任意坐标)` 返回完整 ElementInfo
   - `query({"control_type": "Button"})` 返回按钮列表

3. **隐式兜底端到端**：
   - 打开计算器，VLM 输出 `click("1"按钮坐标)` → 日志显示 `uia_invoke` 而非 `click`
   - 打开记事本文本区，VLM 输出 `click(文本区坐标)` → 日志显示 `click`（无 InvokePattern，回退像素）

4. **desktop.uia_query 端到端**：
   - `desktop.uia_query({mode: "inspect_point", point: {x: 100, y: 100}})` → 返回元素信息
   - `desktop.uia_query({mode: "query", selector: {control_type: "Button", name: "确定"}})` → 返回按钮列表
   - `desktop.uia_query({mode: "read_children", selector: {control_type: "List", name: "文件列表"}})` → 返回列表项

5. **降级验证**：
   - 卸载 pywinauto → `is_available() → False`，视觉循环正常跑（无 UIA 兜底）
   - `desktop.uia_query` 调用 → 返回 `{ok: false, error: "UIA 不可用"}`

6. **DPI 验证**：
   - 200% 缩放下，VLM 输出坐标经 DPI 转换后能正确命中元素

7. **桥接路径验证**：
   - PC 端 `bridge_ws_client.py` 能正确分发 `action: "uia_query"` 到 stdio_worker
