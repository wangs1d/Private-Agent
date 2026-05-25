# 在本机运行桌面桥接（可选：server 已设 DESKTOP_BRIDGE_ENABLED=1 时会自动启动，一般无需手动运行）
# 须与 Flutter 的 USER_ID 一致；未设置 USER_ID 时默认 session-mvp-001
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$UserId = if ($env:DESKTOP_BRIDGE_USER_ID) { $env:DESKTOP_BRIDGE_USER_ID.Trim() } else { "session-mvp-001" }
$WsUrl = if ($env:DESKTOP_BRIDGE_WS_URL) { $env:DESKTOP_BRIDGE_WS_URL.Trim() } else { "ws://127.0.0.1:3000/ws" }

Write-Host "桌面桥接 → $WsUrl  userId=$UserId"
Write-Host "按 Ctrl+C 停止"

$env:DESKTOP_BRIDGE_WS_URL = $WsUrl
$env:DESKTOP_BRIDGE_USER_ID = $UserId
if (-not $env:DESKTOP_BRIDGE_SESSION_ID) {
  $env:DESKTOP_BRIDGE_SESSION_ID = "pc-bridge"
}

Set-Location $Root
python -m desktop_visual_agent.bridge_ws_client
