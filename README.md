# Private-Agent

一个多端私有 AI Agent 项目，当前仓库同时包含：

- `server/`：主 Agent 服务，负责对话、工具调度、skills、capability modules、HTTP / WebSocket 接口
- `client/flutter_app/`：Windows / Flutter 客户端
- `agent-world/`：独立的 Agent World 模块
- `agent-sphere-avatar/`：3D 球形 Agent 形象与悬浮层
- `desktop-visual/`：桌面视觉与自动化桥接（工具地图见 [docs/desktop-control.md](docs/desktop-control.md)）
- `openclaw-plugins/`：外部插件桥接

## 先看哪里

- 项目地图：[docs/PROJECT_MAP.md](/E:/ws-project/Private-Agent/docs/PROJECT_MAP.md)
- 服务端能力分层：[server/src/tools/capability-modules/index.ts](/E:/ws-project/Private-Agent/server/src/tools/capability-modules/index.ts)
- Skill 系统入口：[server/src/skills/index.ts](/E:/ws-project/Private-Agent/server/src/skills/index.ts)
- Agent World 模块：[agent-world/README.md](/E:/ws-project/Private-Agent/agent-world/README.md)
- Flutter 客户端：[client/flutter_app/README.md](/E:/ws-project/Private-Agent/client/flutter_app/README.md)

## 当前推荐理解方式

这个仓库不要按“页面多不多”来理解，按下面 4 层最清楚：

1. `client` / `agent-sphere-avatar` / `sphere-overlay-py`
负责用户界面、悬浮球、桌面展示。

2. `server/src/agent` + `server/src/routes` + `server/src/ws`
负责对话主流程、任务路由、HTTP / WS 入口。

3. `server/src/tools` + `server/src/skills`
负责能力暴露。
`tools` 更像内建工具。
`skills` 更像可管理、可扩展、可装载的技能系统。

4. `server/src/services` + `desktop-visual` + `agent-world`
负责具体执行逻辑和外部能力落地。

## 常用启动

根目录：

```bash
npm run dev:all
```

只启动主服务：

```bash
npm run dev:server --workspace=server
```

只启动 Agent World：

```bash
npm run standalone --workspace=agent-world
```

### 开机自启（服务端常驻）

今日简报等定时能力依赖服务端在触发时刻处于运行状态。注册后，每次登录 Windows 会隐藏拉起服务端栈（与 `npm run dev:all` 同一链路；端口 3000 已占用则跳过，进程崩溃自动退避重启，日志写入 `logs/autostart/`）：

```bash
npm run autostart:install    # 注册：优先计划任务，无管理员权限时自动退回当前用户 Run 键
npm run autostart:status     # 查看注册方式 / 服务运行状态 / 最近日志
npm run autostart:uninstall  # 注销，并停止由自启拉起的服务进程
```

说明：

- 登录后约 15 秒启动（留出网络就绪时间）；错过精确触发时间的简报会在当日 05:00–12:00 窗口内补播一次。
- 默认 dev 模式（ts watch，改动即热载）。生产模式：先 `npm run build --workspace=server`，再把 `scripts/autostart/autostart-server.mjs` 顶部 `MODE` 改为 `prod`（或启动前设 `AUTOSTART_MODE=prod`），然后重跑 `npm run autostart:install`。
- 手动立即验证：`schtasks /run /tn PrivateAgentServer`。

## 现在最值得继续整理的区域

- 根目录存在较多预览页、临时脚本、产物目录，建议后续继续收拢
- `server/src/tools` 与 `server/src/services` 已经形成分层，但缺少统一命名约定说明
- `client/flutter_app` 和若干 HTML 预览页并存，容易让人误判哪个才是正式入口

这次我先把“项目导航”和“能力地图”补齐，后续要继续的话，建议下一步再做目录瘦身和命名统一。
