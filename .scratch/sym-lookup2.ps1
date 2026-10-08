$ErrorActionPreference = "Continue"
$out = New-Object System.Collections.Generic.List[string]
$out.Add("start")
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DbgHelp2 {
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
"@ -ErrorAction Stop
  $out.Add("addtype-ok")
} catch {
  $out.Add("addtype-fail: " + $_.Exception.Message)
}

$engineDir = "D:\flutter\bin\cache\artifacts\engine\windows-x64"
$dll = Join-Path $engineDir "flutter_windows.dll"
$base = [UInt64]18446744071562067968 # placeholder, reset below
$base = [UInt64]("180000000", 16)[0]
$out.Add(("dll-exists: " + (Test-Path $dll)))

$h = [DbgHelp2]::GetCurrentProcess()
$okInit = [DbgHelp2]::SymInitialize($h, $engineDir, $false)
$out.Add(("syminit: " + $okInit))
$loaded = [DbgHelp2]::SymLoadModuleEx($h, [IntPtr]::Zero, $dll, $null, $base, 0, [IntPtr]::Zero, 0)
$out.Add(("symload: " + $loaded + " err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()))

foreach ($rva in @(0x14f37, 0x82c63, 0x156673, 0x81e0f)) {
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 0, 88)
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 80, 512)
    $disp = [UInt64]0
    $addr = [UInt64]$base + [UInt64]$rva
    $ok = [DbgHelp2]::SymFromAddr($h, $addr, [ref]$disp, $buf)
    if ($ok) {
      $nameLen = [Runtime.InteropServices.Marshal]::ReadInt32($buf, 76)
      $namePtr = [IntPtr]::Add($buf, 88)
      $name = [Runtime.InteropServices.Marshal]::PtrToStringAnsi($namePtr, $nameLen)
      $out.Add(("RVA 0x{0:x} -> {1} + 0x{2:x}" -f $rva, $name, $disp))
    } else {
      $out.Add(("RVA 0x{0:x} -> FAIL err={1}" -f $rva, [Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
  } catch {
    $out.Add(("RVA 0x{0:x} -> EXC {1}" -f $rva, $_.Exception.Message))
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
}
[DbgHelp2]::SymCleanup($h) | Out-Null
$out.Add("end")
$out | Set-Content -Path "e:\ws-project\Private-Agent\.scratch\sym-result2.txt" -Encoding UTF8
