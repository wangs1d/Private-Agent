# Sphere Overlay

Agent Sphere **桌面透明悬浮窗** — 使用 Electron，不受 Flutter/浏览器应用窗口边界限制。

## 启动

```powershell
# 在项目根目录
cd sphere-overlay
.\start-overlay.ps1
```

脚本会自动：

1. 构建 `agent-sphere-avatar`
2. 启动 Electron 透明置顶窗口
3. 连接 `ws://127.0.0.1:3000/ws`（可通过 `$env:PAI_WS_URL` 覆盖）

## 交互

- **拖拽**：在球体区域按住拖动，移动整个悬浮窗
- **自主漫游**：Agent 会定期在屏幕工作区内换位置（说话/思考时更活跃）
- **托盘菜单**：显示/隐藏、随机漫游、退出

## 与 Flutter 集成

Windows 桌面客户端 AppBar 的 🤖 按钮会调用 `SphereOverlayLauncher.launch()`，传入：

- `PAI_WS_URL` = `ApiConfig.wsUrl`
- `PAI_SESSION_ID` = `ApiConfig.effectiveActorId`

## 开发模式

```powershell
# 终端 1
cd agent-sphere-avatar
npm run dev

# 终端 2
cd sphere-overlay
$env:PAI_OVERLAY_DEV_URL = "http://localhost:5180/overlay.html"
npm start
```
