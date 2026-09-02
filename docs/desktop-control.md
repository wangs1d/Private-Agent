# 桌面操控能力(desktop-visual)工具地图与约定

Agent 操作电脑的能力分两层:

- **server 端**(Node,`server/src/tools/desktop-visual-tools.ts`):向 LLM 暴露 `desktop.*` 工具,按「电脑桥接在线 → 本机 Python 子进程」双路径择优执行。
- **执行端**(Python,`desktop-visual/desktop_visual/`):`stdio_worker` 接收 JSON 请求完成实际操作(pyautogui / pynput / pywinauto / ctypes),`bridge_ws_client` 是连接 server 的常驻桥接进程。

动作空间对齐主流 computer-use agent(Anthropic Computer Use、OpenAI CUA/Operator、UI-TARS)。

## 工具清单(13 个)

| 工具 | 用途 | 关键点 |
| --- | --- | --- |
| `desktop.visual.screenshot` | 截屏 | 支持 `display`(多屏)、`maxDim`(降采样);返回 `scale/screenWidth/screenHeight` 坐标标定 |
| `desktop.visual.run_task` | VLM 视觉循环(最后手段) | 硬性要求本轮先调过 uia_query + run_input;每步经 stderr `##STEP` 行上报为 `desktop.task.step` 事件 |
| `desktop.open` | 原生打开 file/url/app | 别名展开 + 跨盘扫描 + 开始菜单兜底;窗口验证防"假成功" |
| `desktop.run_preset` | 预打包只读 shell 命令 | list_dir/read_file/ping/processes 等,token 省 |
| `desktop.run_shell` | 受控 shell | 默认白名单,高危命令拒绝;审计落账 |
| `desktop.uia_query` | UIA 结构化查询 | mode=query/read_children/inspect_point/**snapshot**;`windowTitle` 限定窗口 |
| `desktop.run_automation` | UIA pattern 直调 | click/set_value/get_value/toggle/focus/**select/expand/collapse/scroll_into_view**;selector 支持 `path` |
| `desktop.run_input` | 键鼠模拟(主流动作空间) | click/double/triple/middle/right、type(中文剪贴板路径)、key/shortcut/hold_key、drag、scroll(纵+横+目标坐标)、wait、cursor_position |
| `desktop.window` | 窗口管理 | list/activate/close/minimize/maximize/restore/move/resize;按 hwnd/title/index 定位 |
| `desktop.clipboard` | 剪贴板读写 | get/set;`type` 的非 ASCII 粘贴路径与这里共用底层 |
| `desktop.http_get` | 桌面本机 HTTP GET | SSRF 防护、响应截断 |
| `desktop.web_search` | 桌面本机 Bing CN 搜索 | — |
| `desktop.web_fetch` | 桌面本机网页正文抓取 | — |

## 坐标系约定(重要)

全链路统一 **屏幕物理像素**。执行进程启动时声明 Per-Monitor V2 DPI aware
(`runtime/dpi.py`),此后截图、鼠标(SetCursorPos)、UIA(ElementFromPoint /
BoundingRectangle)三者坐标系一致,125%/150% 缩放屏不再错位。

- 截图默认返回原始物理像素;传 `maxDim` 时等比降采样并返回 `scale`(screen = image × scale)。
- 模型手里只有截图坐标时:`desktop.run_input` 传 `coordSpace:"image"` + `imageWidth/imageHeight`,Python 自动换算回屏幕坐标(仅对整屏截图有效;区域截图直接用屏幕坐标)。
- `desktop.uia_query` 返回的 bbox 永远是屏幕物理像素,可直接喂给 `desktop.run_input`。

## 推荐操作序列(主流 "snapshot → act" 模式)

```
desktop.open(启动应用) 
→ desktop.window(list/activate,把窗口带到前台)
→ desktop.uia_query(mode=snapshot,windowTitle=...)   # 拿控件树与 path
→ desktop.run_automation(selector.path=..., action=click/set_value)  # 按 path 精准操作
→ 失败? → desktop.run_input 坐标路径(Electron/自绘 UI)
→ desktop.visual.screenshot 验证结果
```

优先级:UIA pattern 直调 > 键鼠模拟 > VLM 视觉循环(最后手段,token 贵且慢)。

## 桥接通道(手机远控电脑)

server ↔ PC 通过 `desktop.bridge.invoke/result`(jobId 配对)请求-响应;
PC → server 可单向推送 `desktop.event`。action 字段白名单见
`desktop_visual/bridge_actions.py` 的 `ACTION_FIELD_ALLOWLIST`——未知 action
直接拒绝,**不会**静默降级成 run_task(2026-08-31 修复的历史 bug)。

`run_task` 的每步动作经 stderr `##STEP {json}` 行由桥接转发为
`desktop.task.step` 事件(server 端 `DesktopBridgeCoordinator.subscribeEvents`
可订阅,ws 层无 event_type 白名单),客户端可据此实时展示操作步骤。

## 环境开关

| 变量 | 作用 |
| --- | --- |
| `DESKTOP_VISUAL_ENABLED=1` | server 本机启用 Python 子进程执行 |
| `DESKTOP_BRIDGE_ENABLED=1` 或 `DESKTOP_BRIDGE_TOKEN`(≥8 字符) | 启用电脑桥接特性(token 强制鉴权) |
| `DESKTOP_SHELL_ENABLED=1` | 解锁 `desktop.run_shell` / `desktop.run_preset` |
| `DESKTOP_SHELL_ALLOWLIST=0` | 关闭 shell 白名单(allowDestructive 才能生效,高风险) |
| `DESKTOP_VISUAL_STUB=1` | Python 侧用 StubVLM 调试管线 |
| `DESKTOP_VISUAL_PYTHON` | 指定 Python 解释器路径(默认 `python`) |
| `DESKTOP_VISUAL_ROOT` | desktop-visual 包根目录 |
| `DESKTOP_VISUAL_HTTP_GET_ALLOW_PRIVATE=1` | 允许 http_get 访问内网(默认 SSRF 拦截) |

安全护栏:shell 白名单/黑名单(`shell_policy.py`)+ env 脱敏;所有 desktop 工具调用写审计日志(`AuditService`);`desktop.open` 以"窗口确实出现"为成功标准,防止对用户谎报。

## 验证与测试

```bash
# Python 纯逻辑单测(34 项:桥接白名单/run_input 归一化/坐标换算/VLM 解析)
cd desktop-visual && py -3.12 -m pytest tests -q

# server 端冒烟(注册/schema/参数校验;加 --live + DESKTOP_VISUAL_ENABLED=1 走真实子进程)
cd server && DESKTOP_VISUAL_ENABLED=1 npx tsx scripts/verify-desktop-control.ts --live
```

## LLM 工具暴露策略

`desktop.*` 仅在 Complex/delegate/full 模式或桥接在线时进入 LLM 视野
(`resolve-chat-tools.ts` 的 `DESKTOP_VISUAL_PINNED_TOOLS`),Fast/contextual
模式不注入,避免 schema token 污染轻量对话;桥接明确离线时整体剔除
(`dropOfflineDesktopTools`)。
