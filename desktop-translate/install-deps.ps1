# 安装 desktop-translate 依赖（独立模块，不再依赖 desktop-visual）
# 用法: .\install-deps.ps1
#       .\install-deps.ps1 -RecreateVenv   # 删除并重建 .venv 后安装
param(
    [switch]$RecreateVenv,
    [switch]$UpgradePip
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$VenvDir = Join-Path $Root ".venv"
$PipExe = Join-Path $VenvDir "Scripts\pip.exe"
$PythonExe = Join-Path $VenvDir "Scripts\python.exe"
$Requirements = Join-Path $Root "requirements.txt"
$PypiIndex = "https://pypi.org/simple"

Set-Location $Root

if ($RecreateVenv -and (Test-Path $VenvDir)) {
    Write-Host "删除现有虚拟环境: $VenvDir"
    Remove-Item -Recurse -Force $VenvDir
}

if (-not (Test-Path $PythonExe)) {
    Write-Host "创建虚拟环境: $VenvDir"
    $systemPython = Get-Command python -ErrorAction SilentlyContinue
    if (-not $systemPython) {
        throw "未找到 python 命令，请先安装 Python 3.11+ 并加入 PATH"
    }
    & python -m venv $VenvDir
}

if ($UpgradePip) {
    Write-Host "升级 pip ..."
    & $PythonExe -m pip install --upgrade pip -i $PypiIndex
}

Write-Host "安装依赖 (index: $PypiIndex) ..."
& $PipExe install -r $Requirements -i $PypiIndex

Write-Host "完成。激活环境: .\.venv\Scripts\Activate.ps1"
