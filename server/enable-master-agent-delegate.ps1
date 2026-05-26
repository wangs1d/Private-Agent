# PowerShell 脚本：一键启用「主 Agent 委派子 Agent」（支持并行与后台委派）
# 使用方法：.\enable-master-agent-delegate.ps1

Write-Host "🚀 启用主 Agent 委派子 Agent（并行 + 后台委派）" -ForegroundColor Cyan
Write-Host ""

$envFile = ".env"
$envLocal = ".env.local"

if (-Not (Test-Path $envFile)) {
    if (Test-Path $envLocal) {
        Write-Host "ℹ️  未找到 .env，但已有 .env.local（密钥不受影响）；仅创建空 .env 供追加配置..." -ForegroundColor Cyan
        New-Item -Path $envFile -ItemType File -Force | Out-Null
    } else {
        Write-Host "⚠️  未找到 .env / .env.local，从 .env.example 复制..." -ForegroundColor Yellow
        Copy-Item ".env.example" $envFile
        Write-Host "✅ 已创建 .env 文件（请将 MOONSHOT_API_KEY 写入 .env.local）" -ForegroundColor Green
    }
}

$content = Get-Content $envFile -Raw

if ($content -match "ENABLE_MASTER_AGENT_DELEGATION=1" -or $content -match "ENABLE_MULTI_AGENT_COORDINATION=1") {
    Write-Host "✅ 主 Agent 委派已经启用！" -ForegroundColor Green
    exit 0
}

Write-Host "📝 添加主 Agent 委派配置..." -ForegroundColor Cyan

$delegateConfig = @"

# ---------- 主 Agent 委派子 Agent（并行 + 后台委派） ----------
ENABLE_MASTER_AGENT_DELEGATION=1
MASTER_AGENT_DELEGATE_VIA_TOOLS=1
SUBTASK_TIMEOUT_MS=60000
TECH_SUBTASK_TIMEOUT_MS=120000
MAX_PARALLEL_SUB_AGENTS=3
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
Write-Host "💡 提示：独立子任务可并行委派（MAX_PARALLEL_SUB_AGENTS）；耗时任务可 runInBackground + poll" -ForegroundColor Yellow
