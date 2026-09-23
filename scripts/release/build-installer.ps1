#Requires -Version 5.1
<#
.SYNOPSIS
  一键产出 Windows 安装包：客户端构建 → server dist → staging 组装 → Inno 编译。
.EXAMPLE
  .\build-installer.ps1 -Version 0.2.0 -UpdateManifestUrl http://47.98.122.29:3000
#>
param(
  [string]$Version = "0.2.0",
  # 版本控制面（ECS manifest），byok 形态 chat 仍走本地 runtime
  [string]$UpdateManifestUrl = "http://47.98.122.29:3000",
  # 控制面（管理后台所在服务器）：反馈/站内信等运营数据走这里。
  # 不烤入的话捆绑用户的反馈只会落在本机数据库，管理后台收不到。
  [string]$ControlPlaneUrl = "http://47.98.122.29:3000",
  # staging 根目录：刻意用短路径，避开 node_modules 深路径 260 字符上限
  [string]$StageRootPath = "E:\PAStage",
  [switch]$SkipClientBuild,
  [switch]$SkipServerBuild
)
$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$StageRoot = $StageRootPath
$FlutterApp = Join-Path $Repo 'client\flutter_app'
$StageApp = Join-Path $StageRoot 'app'
$StageRuntime = Join-Path $StageRoot 'runtime'

Write-Host '== [1/5] 客户端 release 构建（烤入 UPDATE_MANIFEST_URL + CONTROL_PLANE_URL）=='
if (-not $SkipClientBuild) {
  Push-Location $FlutterApp
  & flutter build windows --release --dart-define "UPDATE_MANIFEST_URL=$UpdateManifestUrl" --dart-define "CONTROL_PLANE_URL=$ControlPlaneUrl"
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'flutter build failed' }
  Pop-Location
}

Write-Host '== [2/5] server 编译（含 workspace 包）=='
if (-not $SkipServerBuild) {
  & npm run build --prefix (Join-Path $Repo 'server')
  if ($LASTEXITCODE -ne 0) { throw 'server build failed' }
}

Write-Host '== [3/5] 组装 staging =='
# 深路径清理：node_modules 里超 MAX_PATH 的文件需 \\?\ 前缀才能删除
if (Test-Path $StageRoot) {
  & cmd /c "rmdir /s /q `"$StageRoot`""
  if (Test-Path $StageRoot) {
    Remove-Item -Recurse -Force -LiteralPath ('\\?\' + $StageRoot)
  }
}
New-Item -ItemType Directory -Force -Path $StageApp, $StageRuntime | Out-Null

# 3.1 Flutter 产物 + VC 运行库（本机 System32 同架构拷贝，免去 vc_redist 静默安装）
Copy-Item (Join-Path $FlutterApp 'build\windows\x64\runner\Release\*') $StageApp -Recurse -Force
foreach ($dll in 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') {
  Copy-Item (Join-Path $env:windir "System32\$dll") $StageApp -Force
}

# 3.2 捆绑 node.exe（与开发机同大版本，绿色单文件）
$nodeExe = @(
  (Get-Command node -ErrorAction SilentlyContinue).Source,
  "$env:ProgramFiles\nodejs\node.exe",
  'D:\nodejs\node.exe'
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $nodeExe) { throw '未找到 node.exe，请确认 PATH 或手改候选路径' }
Copy-Item $nodeExe (Join-Path $StageRuntime 'node.exe') -Force

# 3.3 node_modules：解引用复制（排除 @private-ai-agent 软链，workspace 包单独按需拷）
# 必须经 cmd 原生管道：PowerShell 5.1 管道会按行解码，毁掉 tar 的二进制流
$repoPosix = ($Repo.Path -replace '\\', '/')
$stagePosix = ($StageRuntime -replace '\\', '/')
& cmd /c "tar -chf - -C $repoPosix --exclude=./node_modules/@private-ai-agent --exclude=./node_modules/private-ai-agent-server ./node_modules | tar -xf - -C $stagePosix"
if ($LASTEXITCODE -ne 0) { throw 'node_modules tar copy failed' }

# 3.4 workspace 包：只带运行时必需的 dist+package.json。dist 自包含（包内相对
# import 全部落在 dist 内，数据文件走 cwd\data），包根的 .ts 源码/config/deps/data
# 均为开发态产物——整目录拷贝等于把源码随安装包公开。.d.ts/.d.ts.map 运行时
# 不加载且描述 API 面，一并剥掉。
$paDir = Join-Path $StageRuntime 'node_modules\@private-ai-agent'
New-Item -ItemType Directory -Force -Path $paDir | Out-Null
foreach ($pkg in 'agent-world', 'packages\agent-protocol', 'packages\picture') {
  $pkgDst = Join-Path $paDir (Split-Path $pkg -Leaf)
  Copy-Item (Join-Path $Repo "$pkg\dist") (Join-Path $pkgDst 'dist') -Recurse -Force
  Copy-Item (Join-Path $Repo "$pkg\package.json") (Join-Path $pkgDst 'package.json') -Force
  Get-ChildItem $pkgDst -Recurse -Include '*.d.ts', '*.d.ts.map' -File | Remove-Item -Force
}

# 3.5 server 产物（dist + package.json[type:module] + config 默认清单）
Copy-Item (Join-Path $Repo 'server\dist') (Join-Path $StageRuntime 'dist') -Recurse -Force
Copy-Item (Join-Path $Repo 'server\package.json') (Join-Path $StageRuntime 'package.json') -Force
Copy-Item (Join-Path $Repo 'server\config') (Join-Path $StageRuntime 'config') -Recurse -Force

# 3.6 server 私有依赖：npm 工作区不会把全部依赖提升到根 node_modules
# （如 mem0ai、groq-sdk、@anthropic-ai/sdk 等只落在 server\node_modules），
# 漏拷会让 dist/index.js 启动即 ERR_MODULE_NOT_FOUND。拷到 dist\node_modules
# 使解析顺序（dist\node_modules → node_modules）与开发态（server\node_modules →
# 根）一致；不能与根拍平合并——zod/pg/redis 等在两处是不同版本，会互相覆盖。
if (Test-Path (Join-Path $Repo 'server\node_modules')) {
  $serverPosix = (Join-Path $Repo 'server') -replace '\\', '/'
  & cmd /c "tar -chf - -C $serverPosix node_modules | tar -xf - -C $stagePosix/dist"
  if ($LASTEXITCODE -ne 0) { throw 'server node_modules tar copy failed' }
}

# 3.7 旅行知识种子数据（68KB）：travel 技能的离线底座（poi/坐标/目的地/国内关键词）。
# 知识库读 cwd\data\travel-knowledge，捆绑 runtime 的 cwd 就是 runtime 目录，路径正好对上；
# 拷在冒烟之前，让门禁实跑时顺带验证真实加载。
Copy-Item (Join-Path $Repo 'server\data\travel-knowledge') (Join-Path $StageRuntime 'data\travel-knowledge') -Recurse -Force

Write-Host '== [4/5] 校验关键文件 =='
foreach ($f in (Join-Path $StageApp 'private_ai_agent.exe'),
               (Join-Path $StageRuntime 'node.exe'),
               (Join-Path $StageRuntime 'dist\index.js'),
               (Join-Path $StageRuntime 'node_modules\@private-ai-agent\agent-world\dist'),
               (Join-Path $StageRuntime 'package.json')) {
  if (-not (Test-Path $f)) { throw "staging 缺少关键文件: $f" }
}

# 控制面/版本清单地址烤入门禁：flutter build 漏传 --dart-define 时客户端静默回落
# httpBase(本地)，用户反馈落本机库、后台永远收不到（0.2.1 实际翻车过）。
# app.so 是 Dart AOT 快照，dart-define 字符串常量以明文 ASCII 存于其中，可直接搜。
$stagedSo = Join-Path $StageApp 'data\app.so'
if (-not (Test-Path $stagedSo)) { throw "staging 缺少 app.so: $stagedSo" }
$soText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($stagedSo))
foreach ($ctrlUrl in @($UpdateManifestUrl, $ControlPlaneUrl)) {
  if (-not $ctrlUrl) { continue }
  $ctrlHost = ([uri]$ctrlUrl).Host
  if ($ctrlHost -and -not $soText.Contains($ctrlHost)) {
    throw "发版门禁失败：app.so 未烤入 $ctrlUrl —— 客户端将回落本地，反馈/更新检查失联。" +
      "请确认 [1/5] 的 flutter build 带 --dart-define（勿用 SkipClientBuild 跳过带参构建）。"
  }
}
Write-Host '控制面地址烤入校验通过' -ForegroundColor Green

Write-Host '== [4.5/5] runtime 启动冒烟（按装机布局实跑，健康检查通过才算数）=='
# 文件存在性校验发现不了缺包/缺目录——0.2.0 曾因 server\node_modules 漏拷而在
# 用户机器上启动即崩。这里以与客户端 LocalRuntimeManager 相同的方式实跑一次：
# 起服务 → 轮询 /api/client/manifest → 通过后杀进程并清掉冒烟产生的运行期目录。
$smokePort = 3199  # 避开开发常驻的 3000；被占用会超时失败，属可接受的误报
$smokeLog = Join-Path $StageRoot 'runtime-smoke.log'
$env:PORT = "$smokePort"
$env:FUNASR_AUTO_START = '0'
$smokeProc = Start-Process -FilePath (Join-Path $StageRuntime 'node.exe') `
  -ArgumentList 'dist\index.js' -WorkingDirectory $StageRuntime `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $smokeLog -RedirectStandardError "$smokeLog.err"
Remove-Item Env:PORT, Env:FUNASR_AUTO_START -ErrorAction SilentlyContinue
$ready = $false
foreach ($i in 1..50) {
  Start-Sleep -Milliseconds 800
  if ($smokeProc.HasExited) { break }
  try {
    $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
      -Uri "http://127.0.0.1:$smokePort/api/client/manifest"
    if ($res.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
& taskkill /T /F /PID $smokeProc.Id 2>&1 | Out-Null
if (-not $ready) {
  Write-Host '--- 冒烟 stdout（尾部）---'
  Get-Content $smokeLog -Tail 40 -ErrorAction SilentlyContinue
  Write-Host '--- 冒烟 stderr（尾部）---'
  Get-Content "$smokeLog.err" -Tail 40 -ErrorAction SilentlyContinue
  throw 'runtime 启动冒烟失败：捆绑布局下服务未通过健康检查'
}
Remove-Item $smokeLog, "$smokeLog.err" -Force -ErrorAction SilentlyContinue
# 清掉冒烟实跑产生的运行期垃圾（poi-cache、持久化文件、日志），但保留 3.7 拷入的
# travel-knowledge 种子数据——那是随包分发的资产，不是运行期产物
$dataDir = Join-Path $StageRuntime 'data'
foreach ($child in Get-ChildItem $dataDir -ErrorAction SilentlyContinue) {
  if ($child.Name -ne 'travel-knowledge') {
    Remove-Item $child.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
foreach ($dir in 'logs') {
  Remove-Item (Join-Path $StageRuntime $dir) -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path (Join-Path $dataDir 'travel-knowledge\poi-db.json'))) {
  throw 'staging 缺少 travel-knowledge 种子数据'
}
Write-Host 'runtime 启动冒烟通过' -ForegroundColor Green

Write-Host '== [5/5] Inno 编译 =='
$iscc = @('C:\Program Files (x86)\Inno Setup 6\ISCC.exe', 'C:\Users\Administrator\AppData\Local\Programs\Inno Setup 6\ISCC.exe') |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw '未找到 ISCC.exe，请安装 Inno Setup 6' }
& $iscc (Join-Path $Repo 'installer\private-agent.iss') "/DAppVersion=$Version" "/DStage=$StageRoot"
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed' }

$out = Join-Path $Repo "windows_dist\installer\Nextbot-Setup.exe"
Write-Host ''
Write-Host "安装包产出: $out" -ForegroundColor Green
Write-Host ("大小: {0:N1} MB" -f ((Get-Item $out).Length / 1MB))
