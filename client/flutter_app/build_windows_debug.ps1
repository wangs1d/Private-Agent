#Requires -Version 5.1
<#
.SYNOPSIS
  Shortcut: Windows Debug build and copy to E:\...\windows_dist\Debug
#>
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build_windows.ps1') -Configuration Debug
