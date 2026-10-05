$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiFg {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern void SwitchToThisWindow(IntPtr h, bool f);
}
"@
$h = [PaiFg]::FindWindowW('FLUTTER_RUNNER_WIN32_WINDOW', $null)
if ($h -ne [IntPtr]::Zero) { [PaiFg]::SwitchToThisWindow($h, $true); Write-Host 'foregrounded' }
else { Write-Host 'main window not found' }
