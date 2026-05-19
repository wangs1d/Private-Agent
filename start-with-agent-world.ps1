# 启动 Private AI Agent Flutter 应用和 Agent World 服务
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Private AI Agent 启动器" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查是否在正确的目录
if (-not (Test-Path "client\flutter_app")) {
    Write-Host "错误: 请在项目根目录运行此脚本" -ForegroundColor Red
    Write-Host "当前目录: $PWD" -ForegroundColor Yellow
    exit 1
}

# 检查端口 3333 是否已被占用
$portInUse = $false
try {
    $listener = New-Object System.Net.Sockets.TcpClient
    $listener.Connect("127.0.0.1", 3333)
    $listener.Close()
    $portInUse = $true
} catch {
    $portInUse = $false
}

if ($portInUse) {
    Write-Host "✓ Agent World 服务已在运行（端口 3333）" -ForegroundColor Green
} else {
    # 启动 Agent World 服务（后台运行）
    Write-Host "正在启动 Agent World 服务..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD\agent-world'; npm run standalone" -WindowStyle Minimized

    # 等待服务启动
    Write-Host "等待 Agent World 服务启动..." -ForegroundColor Yellow
    $maxAttempts = 15
    $serviceRunning = $false
    
    for ($i = 1; $i -le $maxAttempts; $i++) {
        Write-Host "  尝试 $i/$maxAttempts..." -NoNewline
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:3333/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Write-Host " 成功！" -ForegroundColor Green
                $serviceRunning = $true
                break
            }
        } catch {
            Write-Host " 失败" -ForegroundColor Red
        }
        Start-Sleep -Seconds 1
    }

    if ($serviceRunning) {
        Write-Host "✓ Agent World 服务已成功启动！" -ForegroundColor Green
        Write-Host "  访问地址: http://127.0.0.1:3333" -ForegroundColor Gray
    } else {
        Write-Host "✗ 警告: Agent World 服务可能未正常启动" -ForegroundColor Yellow
        Write-Host "  请手动运行: npm run agent-world" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "正在启动 Flutter 应用..." -ForegroundColor Yellow
Write-Host "提示: Flutter 应用启动后，点击左侧导航栏的 'Agent World' 即可访问网页" -ForegroundColor Gray
Write-Host "提示: Agent World 服务将在后台持续运行，支持热重载" -ForegroundColor Gray
Write-Host ""

# 启动 Flutter 应用（使用 --hot 参数启用热重载）
Set-Location "client\flutter_app"
flutter run -d windows --hot

# Flutter 应用退出后的处理
Write-Host ""
Write-Host "Flutter 应用已关闭" -ForegroundColor Green
Write-Host "Agent World 服务仍在后台运行" -ForegroundColor Gray
Write-Host "如需关闭 Agent World 服务，请运行: Get-Process node | Stop-Process -Force" -ForegroundColor Gray
