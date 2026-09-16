#Requires -Version 5.1
# 独立「今日足迹」原生悬浮窗（纯 Win32，无 Qt/WebView 依赖）。
# 不依赖桌宠：单独进程、单独常驻右下角，与 sphere-overlay 互不相干。
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $Root

# actorId 必须与主应用 USER_ID 一致（缺省 session-mvp-001），否则推送/台账对不上。
$env:PAI_HTTP_BASE = if ($env:PAI_HTTP_BASE) { $env:PAI_HTTP_BASE } else { "http://127.0.0.1:3000" }
$env:PAI_ACTOR_ID = if ($env:PAI_ACTOR_ID) { $env:PAI_ACTOR_ID } else { "session-mvp-001" }

# 无第三方依赖：无需 pip install；后台无窗口进程运行（pythonw）
$python = Get-Command pythonw -ErrorAction SilentlyContinue
$exe = if ($python) { $python.Source } else { (Get-Command python).Source -replace "python.exe", "pythonw.exe" }
Write-Host "Starting footprint floating (Win32 native)..."
Start-Process -FilePath $exe -ArgumentList "`"$Root\footprint_win32.py`"" -WorkingDirectory $Root
