# Recommendation card E2E capture - 'lenovo' variant v2 (pure ASCII only).
# Finds the mock app window by process name (private_ai_agent), brings it to
# front, copies the window rect to PNG, writes a done sentinel.
# Start this script BEFORE launching the app exe.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiRecCap {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y,
      int cx, int cy, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiRecCap]::SetProcessDPIAware() | Out-Null
$out = 'D:\ws-project\Private-Agent\.tmp_shot\rec_e2e'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$deadline = (Get-Date).AddSeconds(240)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process -Name 'private_ai_agent' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { $hwnd = [IntPtr]$proc.MainWindowHandle; break }
  Start-Sleep -Milliseconds 300
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'window not found for process private_ai_agent' }

# SWP_NOMOVE(2) | SWP_NOSIZE(1) -> topmost, then foreground.
[PaiRecCap]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 3) | Out-Null
[PaiRecCap]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 2600

$r = New-Object PaiRecCap+RECT
[PaiRecCap]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { throw 'bad rect' }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$bmp.Save("$out\rec_shot.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Set-Content -Path "$out\rec_shot.done" -Value 'ok'
Write-Host 'RECAP_CAPTURED'
