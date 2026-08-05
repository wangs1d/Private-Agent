#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 默认连接本地 server；可通过环境变量覆盖
$env:PAI_WS_URL = if ($env:PAI_WS_URL) { $env:PAI_WS_URL } else { "ws://127.0.0.1:3000/ws" }
$env:PAI_HTTP_BASE = if ($env:PAI_HTTP_BASE) { $env:PAI_HTTP_BASE } else { "http://127.0.0.1:3000" }

Push-Location $Root

# 检查依赖
python -c "import PySide6, pyaudio, websockets, requests" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing dependencies..."
    python -m pip install -r requirements.txt
}

Write-Host "Starting voice orb..."
python main.py

Pop-Location
