# Sphere Overlay

Agent **桌面桌宠** — Electron 无框透明窗口 + **3D 写实机器人**（Three.js / DG2），可拖动、漫游，不受主应用窗口限制。

## 特性

- **无框透明**：`frame: false` + WebGL 透明背景，Win11 关闭圆角外框
- **点击穿透**：角色外区域鼠标穿透到桌面；拖机器人可移动窗口
- **3D 写实**：DG2 金属球体 + OLED 曲面表情，随 Agent 心情变化
- **Agent 联动**：WebSocket、语音、快捷菜单、屏幕漫游

## 启动

```powershell
# 在项目根目录
cd sphere-overlay
.\start-overlay.ps1
```

脚本会自动：

1. 构建 `agent-sphere-avatar`
2. 启动 Electron 透明置顶窗口（约 100×125，菜单展开时宽约 236px）
3. 连接 `ws://127.0.0.1:3000/ws`（可通过 `$env:PAI_WS_URL` 覆盖）

## 交互

- **拖拽**：在机器人区域按住拖动，移动整个桌宠窗口
- **点击屏幕**：打开 Agent 快捷菜单
- **自主漫游**：Agent 会定期在屏幕工作区内换位置
- **托盘菜单**：显示/隐藏、随机漫游、退出

## 故障排查

1. **窗口透明但看不到模型**（Windows 常见）  
   ```powershell
   $env:PAI_OVERLAY_OPAQUE = "1"      # 深色底，便于确认 WebView 已加载
   $env:PAI_OVERLAY_DISABLE_GPU = "1" # 显卡驱动异常时可试
   npm start
   ```
2. **查看加载日志**：`%TEMP%\pai-sphere-overlay.log`  
3. **构建必须用** `npm run build`（相对路径 `./assets/...`），**不要用** `build:chat`  
4. **桌宠在屏幕右下角**，托盘可显示/隐藏  
5. **召唤前**先结束残留进程：`Get-Process electron | Stop-Process -Force`

## 与 Flutter 集成

Windows 桌面客户端 AppBar 的 🤖 按钮会调用 `SphereOverlayLauncher.launchElectron()`，传入：

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
