# PowerShell 启动脚本
Write-Host "Starting Social Platform..." -ForegroundColor Green

$env:PORT = "3001"
$env:HOST = "0.0.0.0"

npm run dev
