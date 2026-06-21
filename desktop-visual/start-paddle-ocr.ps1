# 启动 PaddleOCR HTTP 服务（与 Node server 解耦，独立运行）
# 默认端口 8765；修改端口可设环境变量 PADDLE_OCR_PORT
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Host_ = if ($env:PADDLE_OCR_HOST) { $env:PADDLE_OCR_HOST.Trim() } else { "127.0.0.1" }
$Port = if ($env:PADDLE_OCR_PORT) { [int]$env:PADDLE_OCR_PORT.Trim() } else { 8765 }

Write-Host "PaddleOCR HTTP 服务 → http://${Host_}:${Port}/ocr"
Write-Host "按 Ctrl+C 停止"

Set-Location $Root
python -m desktop_visual.paddle_ocr_server --host $Host_ --port $Port
