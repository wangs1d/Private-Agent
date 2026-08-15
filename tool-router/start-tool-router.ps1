# 启动 tool-router FastAPI 微服务（HTTP REST 模式）
# 用法: .\start-tool-router.ps1   （默认 0.0.0.0:8787）
# 环境变量可覆盖: TOOL_ROUTER_HOST / TOOL_ROUTER_PORT
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "[tool-router] 未发现 .venv，创建并安装依赖..." -ForegroundColor Yellow
    python -m venv .venv
    & ".venv\Scripts\python.exe" -m pip install --upgrade pip
    & ".venv\Scripts\pip.exe" install -e .
}

$hostAddr = if ($env:TOOL_ROUTER_HOST) { $env:TOOL_ROUTER_HOST } else { "0.0.0.0" }
$port = if ($env:TOOL_ROUTER_PORT) { $env:TOOL_ROUTER_PORT } else { "8787" }

Write-Host "[tool-router] 启动 FastAPI 服务 http://$hostAddr`:$port ..." -ForegroundColor Green
& ".venv\Scripts\python.exe" -m uvicorn tool_router.main:app --host $hostAddr --port $port
