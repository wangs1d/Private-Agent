# 已弃用：请改用 enable-master-agent-delegate.ps1
# 使用方法：.\enable-multi-agent.ps1

Write-Host "⚠️  enable-multi-agent.ps1 已弃用，正在转发到 enable-master-agent-delegate.ps1 …" -ForegroundColor Yellow
& "$PSScriptRoot\enable-master-agent-delegate.ps1"
