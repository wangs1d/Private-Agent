# NEXTBOT 手机 APK 构建脚本
# 用法：在 client/flutter_app 目录下执行 .\build_apk.ps1
# 效果：flutter build apk --release 后，把产物统一命名为 NEXTBOT.apk（不带版本号）放到桌面
#
# 后端地址必须烤入（--dart-define），否则 ApiConfig.httpBase 回落
# http://127.0.0.1:3000 —— 在真机上那是手机自己，登录/发验证码必然「网络错误」。
# 未显式传 -HttpBase 时自动取本机局域网 IPv4（手机与电脑同一 WiFi 即可直连）。
param(
  # 后端 HTTP 根地址；留空则自动探测本机局域网 IP（http://<ip>:3000）
  [string] $HttpBase = "",
  # 控制面（账号/OTP/登录页所在）；留空则与 -HttpBase 同值
  [string] $ControlPlaneUrl = "",
  # 内测版 internal / 开源版 oss
  [string] $Edition = "internal",
  [int] $Port = 3000
)

$ErrorActionPreference = "Stop"

# ── 自动探测本机局域网 IPv4（排除回环/链路本地，优先 192.168.* / 10.*）──
function Get-LanIPv4 {
  $cands = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } | Sort-Object {
      if ($_.IPAddress -like "192.168.*") { 0 }
      elseif ($_.IPAddress -like "10.*") { 1 }
      else { 2 }
    })
  if ($cands.Count -eq 0) { return $null }
  return $cands[0].IPAddress
}

if ([string]::IsNullOrWhiteSpace($HttpBase)) {
  $ip = Get-LanIPv4
  if (-not $ip) { throw "未能探测到局域网 IPv4，请显式传 -HttpBase http://<电脑IP>:3000" }
  $HttpBase = "http://${ip}:$Port"
  Write-Host "自动探测到局域网地址：$HttpBase" -ForegroundColor Cyan
}
if ([string]::IsNullOrWhiteSpace($ControlPlaneUrl)) { $ControlPlaneUrl = $HttpBase }

# --no-version-check：跳过 flutter 启动时的 `git log` 版本新鲜度检查。
# 该检查纯属提示用途；在管道资源紧张的机器上它会直接让 flutter 崩掉
# （ProcessException: 所有的管道范例都在使用中 / OS error 231），构建跑不起来。
$dartDefines = @(
  "--no-version-check",
  "--suppress-analytics",
  "--dart-define", "HTTP_BASE=$HttpBase",
  "--dart-define", "CONTROL_PLANE_URL=$ControlPlaneUrl",
  "--dart-define", "PAI_EDITION=$Edition"
)

Write-Host "烤入：HTTP_BASE=$HttpBase | CONTROL_PLANE_URL=$ControlPlaneUrl | PAI_EDITION=$Edition" -ForegroundColor Yellow

# 明文 HTTP 白名单提醒：Android 9+ 默认禁明文，局域网 http:// 地址必须在
# android/app/src/main/res/xml/network_security_config.xml 的白名单里，
# 否则请求被系统直接掐掉（表现同样是「网络错误」）。
$uri = [Uri]$HttpBase
$nsConfig = Join-Path $PSScriptRoot "android\app\src\main\res\xml\network_security_config.xml"
if ((Test-Path $nsConfig) -and $uri.Scheme -eq "http" -and $uri.Host -match '^\d+\.\d+\.\d+\.\d+$') {
  $xmlText = Get-Content $nsConfig -Raw
  if ($xmlText -notmatch "<domain[^>]*>\s*$([regex]::Escape($uri.Host))\s*</domain>") {
    Write-Host ""
    Write-Host "⚠ 明文白名单未包含 $($uri.Host)：Android 会拦截 http 请求（登录报「网络错误」）。" -ForegroundColor Yellow
    Write-Host "  请把 <domain includeSubdomains=""false"">$($uri.Host)</domain> 加进：" -ForegroundColor Yellow
    Write-Host "  $nsConfig" -ForegroundColor Yellow
    Write-Host "  （或改用 https 域名，如 https://login.nextbot.top）" -ForegroundColor Yellow
  }
}

flutter build apk --release @dartDefines
if ($LASTEXITCODE -ne 0) { throw "flutter build 失败" }

$src = Join-Path $PSScriptRoot "build\app\outputs\flutter-apk\app-release.apk"
if (-not (Test-Path $src)) { throw "构建产物不存在: $src" }

$dst = Join-Path ([Environment]::GetFolderPath("Desktop")) "NEXTBOT.apk"
Copy-Item $src $dst -Force

Write-Host ""
Write-Host "已放到桌面: $dst"
(Get-Item $dst) | Format-Table Name, LastWriteTime, Length
$sha1 = (Get-FileHash $dst -Algorithm SHA1).Hash
Write-Host "SHA1: $sha1"
