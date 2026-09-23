#Requires -Version 5.1
<#
.SYNOPSIS
  Shortcut: Windows Release build and copy to E:\...\windows_dist\Release
#>
param(
  # 发布版服务器地址，透传给 build_windows.ps1（见其注释）
  [string]$HttpBase = '',
  # 版本清单（更新检查）地址，透传给 build_windows.ps1；默认与主脚本一致烤入 ECS
  [string]$UpdateManifestUrl = 'http://47.98.122.29:3000',
  # 控制面（管理后台）地址：反馈/站内信等运营数据走这里，透传给 build_windows.ps1；
  # 默认与主脚本一致烤入 ECS——本地 Debug/Release 测试的反馈才能落到后台
  [string]$ControlPlaneUrl = 'http://47.98.122.29:3000'
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build_windows.ps1') -Configuration Release -HttpBase $HttpBase -UpdateManifestUrl $UpdateManifestUrl -ControlPlaneUrl $ControlPlaneUrl
