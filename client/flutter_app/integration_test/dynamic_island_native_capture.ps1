# Native dynamic island E2E capture: find PAI_DynamicIsland_Window (layered,
# topmost, 760x460 at top-center of work area) and CopyFromScreen its rect.
# The island window is TOPMOST so nothing occludes it; transparent margins
# show the desktop behind - fine for judging the island shape itself.
# Also captures the main Flutter window to verify the in-app island is gone.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiIslandNative {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiIslandNative]::SetProcessDPIAware() | Out-Null
$out = 'C:\Users\Administrator\AppData\Local\Temp\pai_island_preview'
Remove-Item "$out\*.png" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Find-Island {
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $h = [PaiIslandNative]::FindWindowW('PAI_DynamicIsland_Window', $null)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 400
  }
  throw 'island window not found'
}

$hwnd = Find-Island
Write-Host 'island window found; settle 8s for boot+demo start'
Start-Sleep -Seconds 8

for ($i = 0; $i -lt 14; $i++) {
  $r = New-Object PaiIslandNative+RECT
  [PaiIslandNative]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Host "bad rect at $i"; continue }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save("$out\native_state_{0:d2}.png" -f $i, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("captured native_state_{0:d2}" -f $i)
  Start-Sleep -Milliseconds 3700
}

# Main app window for regression: in-app island must be absent.
$main = [PaiIslandNative]::FindWindowW('FLUTTER_RUNNER_WIN32_WINDOW', $null)
if ($main -ne [IntPtr]::Zero) {
  [PaiIslandNative]::ShowWindow($main, 9) | Out-Null
  Start-Sleep -Milliseconds 1500
  $r2 = New-Object PaiIslandNative+RECT
  [PaiIslandNative]::GetWindowRect($main, [ref]$r2) | Out-Null
  $w2 = $r2.Right - $r2.Left; $h2 = $r2.Bottom - $r2.Top
  $bmp2 = New-Object System.Drawing.Bitmap($w2, $h2)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
  $g2.CopyFromScreen($r2.Left, $r2.Top, 0, 0, (New-Object System.Drawing.Size($w2, $h2)))
  $g2.Dispose()
  $bmp2.Save("$out\main_window.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp2.Dispose()
  Write-Host 'captured main_window'
}
Write-Host 'ALL_CAPTURED'
