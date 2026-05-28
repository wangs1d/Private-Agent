#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $Root

Write-Host "Building agent-sphere-avatar..."
Push-Location (Join-Path $Repo "agent-sphere-avatar")
npm run build
Pop-Location

Write-Host "Installing sphere-overlay dependencies..."
Push-Location $Root
if (-not (Test-Path "node_modules")) { npm install }
Pop-Location

Write-Host "Starting desktop overlay..."
Push-Location $Root
$env:PAI_WS_URL = if ($env:PAI_WS_URL) { $env:PAI_WS_URL } else { "ws://127.0.0.1:3000/ws" }
npm start
Pop-Location
