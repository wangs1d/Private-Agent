# 本地联调：主服务 + Agent World 独立站 + 社交推文站（各开一个 PowerShell 窗口）
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host ""
Write-Host "=== Private AI Agent · 本地开发一键启动 ===" -ForegroundColor Cyan
Write-Host ""

$env:AGENT_WORLD_PLACEHOLDER_REGISTER = "1"
$env:ALLOW_WORLD_HTTP_MUTATIONS = "1"
$env:AGENT_PROMPT_WORLD_CAPS = "1"
$env:ENABLE_MASTER_AGENT_DELEGATION = "1"

function Start-DevWindow {
    param(
        [string]$Title,
        [string]$WorkingDir,
        [string]$Command,
        [hashtable]$ExtraEnv = @{}
    )
    $envLines = ($ExtraEnv.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)'" }) -join "; "
    $full = if ($envLines) { "$envLines; $Command" } else { $Command }
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "cd '$WorkingDir'; `$Host.UI.RawUI.WindowTitle='$Title'; $full"
    ) | Out-Null
    Write-Host "  [+] $Title" -ForegroundColor Green
}

Start-DevWindow -Title "PAI Server :3000" -WorkingDir (Join-Path $Root "server") -Command "npm run dev"
Start-DevWindow -Title "Agent World :3333" -WorkingDir (Join-Path $Root "agent-world") -Command "npm run standalone" -ExtraEnv @{
    PORT = "3333"
    AGENT_WORLD_PLACEHOLDER_REGISTER = "1"
    ALLOW_WORLD_HTTP_MUTATIONS = "1"
}
Start-DevWindow -Title "Social Feed :3001" -WorkingDir (Join-Path $Root "social-platform") -Command "npm run dev" -ExtraEnv @{
    PORT = "3001"
    HOST = "0.0.0.0"
}

Write-Host ""
Write-Host "服务地址（浏览器 / Flutter dart-define）：" -ForegroundColor Yellow
Write-Host "  主服务（对话 / WS / 嵌入式 Agent World API）  http://127.0.0.1:3000"
Write-Host "  聊天页                                        http://127.0.0.1:3000/chat"
Write-Host "  Agent World 独立站（观战 / 世界 Web UI）        http://127.0.0.1:3333"
Write-Host "  社交推文站（用户与 Agent 发帖互动）             http://127.0.0.1:3001"
Write-Host ""
Write-Host "Flutter 示例：" -ForegroundColor Yellow
Write-Host "  flutter run -d chrome --dart-define=HTTP_BASE=http://127.0.0.1:3000"
Write-Host "    --dart-define=WS_URL=ws://127.0.0.1:3000/ws"
Write-Host "    --dart-define=AGENT_WORLD_URL=http://127.0.0.1:3333"
Write-Host "    --dart-define=AGENT_LINK_URL=http://127.0.0.1:3001"
Write-Host ""
Write-Host "关闭各 PowerShell 窗口即可停止对应服务。" -ForegroundColor DarkGray
Write-Host ""
