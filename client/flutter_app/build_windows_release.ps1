#Requires -Version 5.1
<#
.SYNOPSIS
  Shortcut: Windows Release build and copy to E:\...\windows_dist\Release
#>
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build_windows.ps1') -Configuration Release
