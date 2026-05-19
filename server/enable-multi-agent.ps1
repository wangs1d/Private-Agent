# PowerShell 脚本：一键启用多 Agent 系统
# 使用方法：.\enable-multi-agent.ps1

Write-Host "🚀 启用多 Agent 协调系统" -ForegroundColor Cyan
Write-Host ""

$envFile = ".env"

# 检查 .env 文件是否存在
if (-Not (Test-Path $envFile)) {
    Write-Host "⚠️  未找到 .env 文件，从 .env.example 复制..." -ForegroundColor Yellow
    Copy-Item ".env.example" $envFile
    Write-Host "✅ 已创建 .env 文件" -ForegroundColor Green
}

# 读取现有内容
$content = Get-Content $envFile -Raw

# 检查是否已配置
if ($content -match "ENABLE_MULTI_AGENT_COORDINATION=1") {
    Write-Host "✅ 多 Agent 系统已经启用！" -ForegroundColor Green
    exit 0
}

# 添加配置
Write-Host "📝 添加多 Agent 配置..." -ForegroundColor Cyan

$multiAgentConfig = @"

# ---------- 多 Agent 协调系统 ----------
ENABLE_MULTI_AGENT_COORDINATION=1
MAX_PARALLEL_SUBTASKS=5
SUBTASK_TIMEOUT_MS=60000
MULTI_AGENT_VERBOSE=false
"@

# 追加到文件末尾
Add-Content $envFile $multiAgentConfig

Write-Host ""
Write-Host "✅ 配置已成功添加到 .env 文件" -ForegroundColor Green
Write-Host ""
Write-Host "📋 当前配置：" -ForegroundColor Cyan
Write-Host "   ENABLE_MULTI_AGENT_COORDINATION=1" -ForegroundColor White
Write-Host "   MAX_PARALLEL_SUBTASKS=5" -ForegroundColor White
Write-Host "   SUBTASK_TIMEOUT_MS=60000" -ForegroundColor White
Write-Host ""
Write-Host "🎯 下一步：" -ForegroundColor Cyan
Write-Host "   1. 确保已配置外部模型（MOONSHOT_API_KEY 或 OPENAI_API_KEY）" -ForegroundColor White
Write-Host "   2. 运行测试: npm run test:master-agent" -ForegroundColor White
Write-Host "   3. 启动服务: npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "💡 提示：如需调整并发度，修改 MAX_PARALLEL_SUBTASKS 的值" -ForegroundColor Yellow
