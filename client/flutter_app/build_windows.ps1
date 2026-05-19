#Requires -Version 5.1
<#
.SYNOPSIS
  Build Flutter Windows (Release and/or Debug) and copy the runner folder to E:.

.DESCRIPTION
  Flutter still writes under project build\windows\...; every install (including
  plain "flutter build windows") also mirrors the bundle to windows_dist via
  windows/cmake (see PRIVATE_AI_AGENT_SKIP_WINDOWS_DIST to opt out). This script
  additionally mirrors the full Release or Debug folder (entire folder, not only .exe),
  including stopping processes that lock the deploy folder.

  Default dist root: E:\W-Project\Private AI Agent\windows_dist\Release | Debug
  Override: set env PRIVATE_AI_AGENT_WINDOWS_DIST to a folder on E: (or any drive).

  Requires: Flutter on PATH or FLUTTER_ROOT, Visual Studio desktop C++, Windows Developer Mode for symlinks.
#>
param(
  [ValidateSet('Release', 'Debug', 'Both')]
  [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Resolve-FlutterExecutable {
  $cmd = Get-Command flutter -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if ($env:FLUTTER_ROOT) {
    $bat = Join-Path $env:FLUTTER_ROOT 'bin\flutter.bat'
    if (Test-Path $bat) { return $bat }
  }
  $candidates = @(
    (Join-Path $env:USERPROFILE 'flutter\bin\flutter.bat'),
    (Join-Path $env:USERPROFILE 'development\flutter\bin\flutter.bat'),
    'C:\flutter\bin\flutter.bat',
    'C:\src\flutter\bin\flutter.bat',
    (Join-Path $env:LOCALAPPDATA 'flutter\bin\flutter.bat')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Assert-FlutterOk {
  param([string]$StepName)
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'If you see symlink / Developer Mode: enable Windows Developer Mode, then retry.' -ForegroundColor Yellow
    Write-Host '  start ms-settings:developers' -ForegroundColor Yellow
    Write-Host ''
    Write-Error "Flutter step failed: $StepName (exit $LASTEXITCODE)"
  }
}

$flutterExe = Resolve-FlutterExecutable
if (-not $flutterExe) {
  Write-Error 'Flutter not found. Add flutter to PATH or set FLUTTER_ROOT. See https://docs.flutter.dev/get-started/install/windows'
}

$DistRoot = 'E:\W-Project\Private AI Agent\windows_dist'
if ($env:PRIVATE_AI_AGENT_WINDOWS_DIST) {
  $DistRoot = $env:PRIVATE_AI_AGENT_WINDOWS_DIST.Trim()
}
if (-not $DistRoot) {
  Write-Error 'PRIVATE_AI_AGENT_WINDOWS_DIST is set but empty.'
}

$cmakeLists = Join-Path $Root 'windows\CMakeLists.txt'
if (-not (Test-Path $cmakeLists)) {
  if (Test-Path (Join-Path $Root 'windows')) {
    Write-Host 'Incomplete windows folder detected; removing to regenerate...'
    Remove-Item -Recurse -Force (Join-Path $Root 'windows')
  }
  Write-Host 'Generating Windows platform: flutter create --platforms=windows .'
  & $flutterExe create --platforms=windows .
  Assert-FlutterOk 'flutter create --platforms=windows'
}

$null = New-Item -ItemType Directory -Force -Path $DistRoot

Write-Host 'flutter pub get'
& $flutterExe pub get
Assert-FlutterOk 'flutter pub get'

function Stop-ProcessesUsingDeployFolder {
  param([string] $FolderPath)
  if (-not (Test-Path -LiteralPath $FolderPath)) { return }
  $full = (Get-Item -LiteralPath $FolderPath).FullName.TrimEnd('\', '/')
  foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
    $exePath = $null
    try { $exePath = $proc.Path } catch { continue }
    if (-not $exePath) { continue }
    try {
      $exeFull = [System.IO.Path]::GetFullPath($exePath)
    } catch { continue }
    if ($exeFull.StartsWith($full, [StringComparison]::OrdinalIgnoreCase)) {
      Write-Host "Stopping process locking deploy folder: $($proc.ProcessName) (PID $($proc.Id))" -ForegroundColor Yellow
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 600
}

function Remove-DeployFolder {
  param([string] $LiteralPath)
  Stop-ProcessesUsingDeployFolder -FolderPath $LiteralPath
  $max = 8
  for ($i = 0; $i -lt $max; $i++) {
    try {
      Remove-Item -LiteralPath $LiteralPath -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($i -eq $max - 1) { throw }
      Stop-ProcessesUsingDeployFolder -FolderPath $LiteralPath
      Start-Sleep -Milliseconds (500 * ($i + 1))
    }
  }
}

function Invoke-BuildAndDeploy {
  param(
    [ValidateSet('Release', 'Debug')]
    [string] $Mode
  )

  if ($Mode -eq 'Release') {
    Write-Host 'flutter build windows --release'
    & $flutterExe build windows --release
  }
  else {
    Write-Host 'flutter build windows --debug'
    & $flutterExe build windows --debug
  }
  Assert-FlutterOk "flutter build windows ($Mode)"

  $src = Join-Path $Root "build\windows\x64\runner\$Mode"
  $builtExe = Get-ChildItem -Path $src -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $builtExe) {
    Write-Error "No .exe found under: $src"
  }

  $dest = Join-Path $DistRoot $Mode
  if (Test-Path -LiteralPath $dest) {
    Remove-DeployFolder -LiteralPath $dest
  }
  $null = New-Item -ItemType Directory -Force -Path $dest
  Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force

  Write-Host ''
  Write-Host "$Mode build OK. Deployed folder:" -ForegroundColor Green
  Write-Host ('  ' + $dest)
  Write-Host ('  exe: ' + (Join-Path $dest $builtExe.Name))
}

if ($Configuration -eq 'Release' -or $Configuration -eq 'Both') {
  Invoke-BuildAndDeploy -Mode Release
}

if ($Configuration -eq 'Debug' -or $Configuration -eq 'Both') {
  Invoke-BuildAndDeploy -Mode Debug
}

Write-Host ''
Write-Host ('Dist root: ' + $DistRoot)
