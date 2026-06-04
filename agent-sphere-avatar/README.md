# Agent Sphere Avatar

可**独立移植**的球形 3D Agent 形象 — 基于 **Three.js + React Three Fiber (R3F) + Cannon.js**。

> 移植到其他项目请参阅 **[PORTABLE.md](./PORTABLE.md)**

## 设计要点

| 模块 | 说明 |
|------|------|
| **DG2RobotModel** | OBJ 一比一还原深灰金属球形机器人 |
| **ScreenFace** | 曲屏表情与交互 |
| **SphereAgent** | 物理 / 自主漫游 / 用户拖拽 |
| **useAgentWebSocket** | 可选直连 `/ws` |
| **embed-protocol** | iframe postMessage 协议（移植核心） |
| **host-sdk** | 宿主侧集成 SDK |

## 快速开始

```bash
cd agent-sphere-avatar
npm install
npm run dev              # 桌宠/嵌入开发 http://localhost:5180/overlay.html
npm run build:standalone # 独立静态包 dist/（相对路径，可任意部署）
npm run build:chat       # PAI 内部：部署到 server/web/chat/assets/avatar/
```

## 嵌入方式

### iframe（推荐，任意 Web 项目）

```html
<iframe src="./dist/embed.html?wsOff=1&sessionId=xxx"></iframe>
```

宿主通过 `postMessage` 推送状态，详见 [PORTABLE.md](./PORTABLE.md)。

### React 组件（同项目内）

```tsx
import { SphereAgentScene, useAgentState } from "./src/public-api";
```

### 桌面悬浮（可选）

```powershell
cd sphere-overlay
.\start-overlay.ps1
```

## 入口 HTML

| 文件 | 用途 |
|------|------|
| `embed.html` | 网页/chat iframe 嵌入 |
| `overlay.html` | Electron 桌面桌宠 |

## 目录结构

```
agent-sphere-avatar/          ← 独立模块，可直接复制
├── src/
│   ├── embed-protocol.ts     # postMessage 协议（移植时必读）
│   ├── host-sdk.ts           # 宿主集成 SDK
│   ├── public-api.ts         # 公共导出
│   ├── bridge/ws-agent-mapper.ts
│   ├── hooks/
│   ├── modes/                # EmbedApp / OverlayApp
│   └── components/
├── public/models/
├── scripts/
├── PORTABLE.md               # 移植指南
└── dist/                     # 构建产物
```

## WebSocket 状态映射（可选）

对接自有后端时参考 `ws-agent-mapper.ts`，或通过 `host.patch()` 直接推送：

| 服务端事件 | Agent 状态 |
|-----------|-----------|
| 用户发消息 | `listening` |
| `chat.agent_status` / `tool.call` | `thinking` |
| `chat.assistant_chunk` | `speaking` |
| `chat.assistant_done` | `happy` → `idle` |
| `error.event` | `alert` |

## PAI 项目集成点

| 宿主 | 加载路径 |
|------|----------|
| 网页聊天 | `/chat/assets/avatar/embed.html?wsOff=1` |
| Flutter Web | `/chat/assets/avatar/embed.html?wsOff=1` |
| Electron 桌宠 | `dist/overlay.html` |
