$ErrorActionPreference = "Continue"
$out = New-Object System.Collections.Generic.List[string]
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DbgHelp3 {
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
$base = [UInt64]"0x180000000"

$h = [DbgHelp3]::GetCurrentProcess()
[void][DbgHelp3]::SymInitialize($h, $engineDir, $false)
[void][DbgHelp3]::SymLoadModuleEx($h, [IntPtr]::Zero, $dll, $null, $base, 0, [IntPtr]::Zero, 0)

function Lookup([UInt64]$addr) {
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 0, 88)
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 80, 512)
    $disp = [UInt64]0
    $ok = [DbgHelp3]::SymFromAddr($h, $addr, [ref]$disp, $buf)
    if ($ok) {
      $name = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([IntPtr]::Add($buf, 88))
      return "0x{0:x} {1} +0x{2:x}" -f $addr, $name, $disp
    }
    return ("0x{0:x} <no sym>" -f $addr)
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
}

# 主崩溃点邻近扫描，确认函数边界与前后符号
$crash = [Int64]($base) + 0x14f37
foreach ($delta in -0x200, -0x100, -0x80, -0x40, -0x20, 0, 0x20, 0x40, 0x80, 0x100, 0x200) {
  $out.Add((Lookup ([UInt64]($crash + $delta))))
}
[DbgHelp3]::SymCleanup($h) | Out-Null
$out | Set-Content -Path "e:\ws-project\Private-Agent\.scratch\sym-result3.txt" -Encoding UTF8
