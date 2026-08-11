# Private-Agent

一个多端私有 AI Agent 项目，当前仓库同时包含：

- `server/`：主 Agent 服务，负责对话、工具调度、skills、capability modules、HTTP / WebSocket 接口
- `client/flutter_app/`：Windows / Flutter 客户端
- `agent-world/`：独立的 Agent World 模块
- `agent-sphere-avatar/`：3D 球形 Agent 形象与悬浮层
- `desktop-visual/`：桌面视觉与自动化桥接
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

## 现在最值得继续整理的区域

- 根目录存在较多预览页、临时脚本、产物目录，建议后续继续收拢
- `server/src/tools` 与 `server/src/services` 已经形成分层，但缺少统一命名约定说明
- `client/flutter_app` 和若干 HTML 预览页并存，容易让人误判哪个才是正式入口

这次我先把“项目导航”和“能力地图”补齐，后续要继续的话，建议下一步再做目录瘦身和命名统一。
