# 用 dbghelp 把 flutter_windows.dll 的崩溃 RVA 符号化
param([UInt64[]]$Rvas = @(0x14f37))

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DbgHelp {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("dbghelp.dll", SetLastError=true)]
  public static extern bool SymInitialize(IntPtr hProcess, string UserSearchPath, bool fInvadeProcess);
  [DllImport("dbghelp.dll", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern ulong SymLoadModuleEx(IntPtr hProcess, IntPtr hFile, string ImageName, string ModuleName, ulong BaseOfDll, int DllSize, IntPtr Data, int Flags);
  [DllImport("dbghelp.dll", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool SymFromAddr(IntPtr hProcess, ulong Address, out ulong Displacement, IntPtr Symbol);
  [DllImport("dbghelp.dll")]
  public static extern bool SymCleanup(IntPtr hProcess);
}
"@

$engineDir = "D:\flutter\bin\cache\artifacts\engine\windows-x64"
$dll = Join-Path $engineDir "flutter_windows.dll"
$base = [UInt64]0x180000000
$out = New-Object System.Collections.Generic.List[string]
$out.Add("script-start")

$h = [DbgHelp]::GetCurrentProcess()
if (-not [DbgHelp]::SymInitialize($h, $engineDir, $false)) {
  Write-Output "SymInitialize failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 1
}
$loaded = [DbgHelp]::SymLoadModuleEx($h, [IntPtr]::Zero, $dll, $null, $base, 0, [IntPtr]::Zero, 0)
if ($loaded -eq 0) {
  Write-Output "SymLoadModuleEx failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

foreach ($rva in $Rvas) {
  $size = 88 + 512
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 0, 88)          # SizeOfStruct
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 80, 512)        # MaxNameLen
    $disp = [UInt64]0
    $addr = $base + $rva
    $ok = [DbgHelp]::SymFromAddr($h, $addr, [ref]$disp, $buf)
    if ($ok) {
      $nameLen = [Runtime.InteropServices.Marshal]::ReadInt32($buf, 76)
      $namePtr = [IntPtr]::Add($buf, 88)
      $name = [Runtime.InteropServices.Marshal]::PtrToStringAnsi($namePtr, $nameLen)
      $out.Add(("RVA 0x{0:x} -> {1} + 0x{2:x}" -f $rva, $name, $disp))
    } else {
      $out.Add(("RVA 0x{0:x} -> lookup failed: {1}" -f $rva, [Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
}
[DbgHelp]::SymCleanup($h) | Out-Null
$out | Set-Content -Path "e:\ws-project\Private-Agent\.scratch\sym-result.txt" -Encoding UTF8
