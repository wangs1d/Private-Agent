# PowerShell 脚本：一键启用「主 Agent 委派子 Agent」（串行，无并行）
# 使用方法：.\enable-master-agent-delegate.ps1

Write-Host "🚀 启用主 Agent 委派子 Agent（串行调用）" -ForegroundColor Cyan
Write-Host ""

$envFile = ".env"

if (-Not (Test-Path $envFile)) {
    Write-Host "⚠️  未找到 .env 文件，从 .env.example 复制..." -ForegroundColor Yellow
    Copy-Item ".env.example" $envFile
    Write-Host "✅ 已创建 .env 文件" -ForegroundColor Green
}

$content = Get-Content $envFile -Raw

if ($content -match "ENABLE_MASTER_AGENT_DELEGATION=1" -or $content -match "ENABLE_MULTI_AGENT_COORDINATION=1") {
    Write-Host "✅ 主 Agent 委派已经启用！" -ForegroundColor Green
    exit 0
}

Write-Host "📝 添加主 Agent 委派配置..." -ForegroundColor Cyan

$delegateConfig = @"

# ---------- 主 Agent 委派子 Agent（串行，非并列多 Agent） ----------
ENABLE_MASTER_AGENT_DELEGATION=1
MASTER_AGENT_DELEGATE_VIA_TOOLS=1
SUBTASK_TIMEOUT_MS=60000
MASTER_AGENT_DELEGATION_VERBOSE=false
"@

Add-Content $envFile $delegateConfig

Write-Host ""
Write-Host "✅ 配置已成功添加到 .env 文件" -ForegroundColor Green
Write-Host ""
Write-Host "📋 当前配置：" -ForegroundColor Cyan
Write-Host "   ENABLE_MASTER_AGENT_DELEGATION=1" -ForegroundColor White
Write-Host "   MASTER_AGENT_DELEGATE_VIA_TOOLS=1（主 Agent 用 tool 动态调用子 Agent）" -ForegroundColor White
Write-Host "   SUBTASK_TIMEOUT_MS=60000" -ForegroundColor White
Write-Host "   MASTER_AGENT_DELEGATION_VERBOSE=false" -ForegroundColor White
Write-Host ""
Write-Host "🎯 下一步：" -ForegroundColor Cyan
Write-Host "   1. 确保已配置外部模型（MOONSHOT_API_KEY 或 OPENAI_API_KEY）" -ForegroundColor White
Write-Host "   2. 运行测试: npm run test:master-agent" -ForegroundColor White
Write-Host "   3. 启动服务: npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "💡 提示：子 Agent 由主 Agent 逐个委派，报告回主 Agent 后统一回复用户" -ForegroundColor Yellow
