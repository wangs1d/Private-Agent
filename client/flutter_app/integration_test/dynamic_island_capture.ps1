# Dynamic island UI E2E capture (occlusion-proof):
# find the main Flutter window and capture ITS OWN rendered content via
# PrintWindow(PW_RENDERFULLCONTENT), so overlapping foreground windows
# (e.g. a video player on top) do not pollute the shots. The island demo
# driver auto-plays an expand/collapse phase, so no mouse clicks needed.
#
# Outputs to C:\Users\Administrator\AppData\Local\Temp\pai_island_preview :
#   state_NN.png + crop_state_NN.png   (top-center 760x300 crop)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiIslandCap {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiIslandCap]::SetProcessDPIAware() | Out-Null
$out = 'C:\Users\Administrator\AppData\Local\Temp\pai_island_preview'
Remove-Item "$out\*.png" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Get-MainWindow {
  $deadline = (Get-Date).AddSeconds(240)
  while ((Get-Date) -lt $deadline) {
    $hwnd = [PaiIslandCap]::FindWindowW('FLUTTER_RUNNER_WIN32_WINDOW', $null)
    if ($hwnd -ne [IntPtr]::Zero) { return $hwnd }
    Start-Sleep -Milliseconds 500
  }
  throw 'main window not found'
}

function Save-Shots([IntPtr]$hwnd, [string]$name) {
  $r = New-Object PaiIslandCap+RECT
  [PaiIslandCap]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { throw "bad rect for $name" }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # 2 = PW_RENDERFULLCONTENT: render the window's own surface even if occluded.
  $ok = [PaiIslandCap]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); throw "PrintWindow failed for $name" }
  $bmp.Save("$out\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $cw = [Math]::Min(760, $w)
  $cx = [int](($w - $cw) / 2)
  $ch = [Math]::Min(300, $h)
  $rect = New-Object System.Drawing.Rectangle($cx, 0, $cw, $ch)
  $crop = $bmp.Clone($rect, $bmp.PixelFormat)
  $crop.Save("$out\crop_$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  $bmp.Dispose()
  Write-Host "captured $name (${w}x${h})"
}

$hwnd = Get-MainWindow
# 9 = SW_RESTORE: a minimized window yields a 160x28 rect and prints garbage.
[PaiIslandCap]::ShowWindow($hwnd, 9) | Out-Null
Write-Host "window found, settle 10s for boot animation + init"
Start-Sleep -Seconds 10

function Get-ValidWindow {
  # The app instance can be killed by a sibling build (Stop-Process before
  # their CMake build); re-check the handle each shot.
  $r = New-Object PaiIslandCap+RECT
  $ok = [PaiIslandCap]::GetWindowRect($hwnd, [ref]$r)
  if (-not $ok) { return [IntPtr]::Zero }
  if (($r.Right - $r.Left) -le 0 -or ($r.Bottom - $r.Top) -le 0) { return [IntPtr]::Zero }
  return $hwnd
}

# 14 shots: interval must NOT be near-multiple of the 5.2s demo step or the
# sampler aliases onto the same phase every cycle. 3.7s advances the phase
# ~1.5s per shot -> full 36.4s cycle covered within ~13 shots.
for ($i = 0; $i -lt 14; $i++) {
  $h = Get-ValidWindow
  if ($h -eq [IntPtr]::Zero) {
    Write-Host "window lost before shot $i, re-finding"
    $h = Get-MainWindow
    Start-Sleep -Seconds 8
  }
  try {
    Save-Shots $h ("state_{0:d2}" -f $i)
  } catch {
    Write-Host "shot $i failed ($_), retrying once"
    Start-Sleep -Milliseconds 1500
    Save-Shots $h ("state_{0:d2}" -f $i)
  }
  Start-Sleep -Milliseconds 3700
}
Write-Host 'ALL_CAPTURED'
