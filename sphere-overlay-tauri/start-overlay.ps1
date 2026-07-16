#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $Root

# 设置 Rust 环境（D 盘安装）
$env:RUSTUP_HOME = "D:\rust\rustup"
$env:CARGO_HOME = "D:\rust\cargo"
if ($env:Path -notlike "*D:\rust\cargo\bin*") {
    $env:Path = "$env:Path;D:\rust\cargo\bin"
}

Write-Host "Building agent-sphere-avatar (Tauri 需相对路径，勿用 build:chat)..."
Push-Location (Join-Path $Repo "agent-sphere-avatar")
npm run build
Pop-Location

Write-Host "Building sphere-overlay-tauri (首次编译可能需要 5-10 分钟)..."
Push-Location (Join-Path $Root "src-tauri")
cargo build --release
Pop-Location

Get-Process sphere-overlay-tauri -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Write-Host "Starting desktop overlay..."
Write-Host "Log: $env:TEMP\pai-sphere-overlay.log"
Push-Location $Root

$env:PAI_WS_URL = if ($env:PAI_WS_URL) { $env:PAI_WS_URL } else { "ws://127.0.0.1:3000/ws" }

# 开发模式：使用 dev server
if ($env:PAI_OVERLAY_DEV_URL) {
    Write-Host "Dev mode: $env:PAI_OVERLAY_DEV_URL"
    Push-Location (Join-Path $Root "src-tauri")
    cargo run --release
    Pop-Location
} else {
    # 生产模式：直接运行编译好的二进制
    $exePath = Join-Path $Root "src-tauri\target\release\sphere-overlay-tauri.exe"
    if (Test-Path $exePath) {
        & $exePath
    } else {
        Write-Host "Binary not found, falling back to cargo run..."
        Push-Location (Join-Path $Root "src-tauri")
        cargo run --release
        Pop-Location
    }
}
Pop-Location
