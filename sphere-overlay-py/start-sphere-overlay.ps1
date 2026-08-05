#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $Root

# 默认连接本地 server
$env:PAI_WS_URL = if ($env:PAI_WS_URL) { $env:PAI_WS_URL } else { "ws://127.0.0.1:3000/ws" }
$env:PAI_HTTP_BASE = if ($env:PAI_HTTP_BASE) { $env:PAI_HTTP_BASE } else { "http://127.0.0.1:3000" }

Push-Location $Root

# 检查依赖
python -c "import PySide6, websockets, requests" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing dependencies..."
    python -m pip install -r requirements.txt
}

# 确保前端资源已构建
$dist = Join-Path $Repo "agent-sphere-avatar\dist"
if (-not (Test-Path $dist)) {
    Write-Host "Building agent-sphere-avatar..."
    Push-Location (Join-Path $Repo "agent-sphere-avatar")
    npm run build
    Pop-Location
}

Write-Host "Starting sphere overlay (PySide6)..."
python main.py

Pop-Location
