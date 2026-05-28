# Agent Sphere Avatar

Private AI Agent 的 **3D 主 Agent 形象** — 基于实体球形原型，使用 **Three.js + React Three Fiber (R3F) + Cannon.js** 构建。

## 设计要点

| 模块 | 说明 |
|------|------|
| **BreathingShell** | 哑光 PLA 白球壳 + 内嵌 seam 呼吸灯 |
| **EyeScreen** | 前部大曲屏黑色玻璃态眼睛（约占正面 58%） |
| **SideEars** | 两侧短圆柱耳部（参照 3D 打印原型） |
| **SphereAgent** | Cannon 物理 + 自主漫游推力 |
| **useAgentWebSocket** | 对接 `/ws`，LLM 流式 → `thinking` / `speaking` |
| **sphere-overlay** | Electron 透明置顶窗，桌面任意位置漫游 |

## 快速开始

```bash
cd agent-sphere-avatar
npm install
npm run dev          # 演示页 http://localhost:5180
npm run build:chat   # 构建并复制到 server/web/chat/assets/avatar/
```

## WebSocket 状态映射

| 服务端事件 | Agent 状态 |
|-----------|-----------|
| 用户发消息 | `listening` |
| `chat.agent_status` / `tool.call` | `thinking` |
| `chat.assistant_chunk` | `speaking`（energy 随 chunk 升高） |
| `chat.assistant_done` | `happy` → `idle` |
| `error.event` | `alert` |

## 嵌入网页聊天

1. `npm run build:chat`
2. 打开 `GET /chat` — 左侧 iframe 加载 `/chat/assets/avatar/embed.html?wsOff=1`
3. `app.js` 通过 `postMessage` 转发 WS 事件（避免双连接）

## 桌面悬浮（不受应用窗口限制）

```powershell
cd sphere-overlay
.\start-overlay.ps1
```

- 透明无边框、始终置顶
- 连接同一 `WS_URL` / `PAI_SESSION_ID`
- 屏幕工作区内自主漫游 + 拖拽
- Flutter Windows 客户端 AppBar 🤖 按钮可一键启动

环境变量：

| 变量 | 说明 |
|------|------|
| `PAI_WS_URL` | WebSocket 地址，默认 `ws://127.0.0.1:3000/ws` |
| `PAI_SESSION_ID` | 与 Flutter `ApiConfig.effectiveActorId` 一致 |
| `PAI_OVERLAY_DEV_URL` | 开发时指向 Vite overlay 页 |

## 入口 HTML

| 文件 | 用途 |
|------|------|
| `index.html` | 独立演示 |
| `embed.html` | 网页/chat iframe 嵌入 |
| `overlay.html` | Electron 桌面悬浮 |

## 目录结构

```
agent-sphere-avatar/
├── src/
│   ├── bridge/ws-agent-mapper.ts
│   ├── hooks/useAgentWebSocket.ts
│   ├── hooks/useAutonomousMotion.ts
│   ├── hooks/useOverlayWindowMotion.ts
│   ├── modes/EmbedApp.tsx
│   ├── modes/OverlayApp.tsx
│   └── components/
sphere-overlay/          # Electron 桌面壳
server/web/chat/         # 网页聊天 + avatar 静态资源
```
