# Atomic evidence run: launch harness, screenshot, drag twice across
# contrasting backgrounds, screenshot, kill. Whole pass ~6 seconds.
# Usage: powershell -NoProfile -File run-transparency-evidence.ps1
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EV {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, UIntPtr dx, UIntPtr dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Shot([string]$path) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Drag([int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
  [void][EV]::SetCursorPos($fromX, $fromY)
  Start-Sleep -Milliseconds 120
  [EV]::mouse_event(0x0002, [UIntPtr]::Zero, [UIntPtr]::Zero, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  for ($i = 1; $i -le 20; $i++) {
    $x = $fromX + [int](($toX - $fromX) * $i / 20)
    $y = $fromY + [int](($toY - $fromY) * $i / 20)
    [void][EV]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 14
  }
  Start-Sleep -Milliseconds 150
  [EV]::mouse_event(0x0004, [UIntPtr]::Zero, [UIntPtr]::Zero, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 150
}

$out = 'E:\ws-project\Private-Agent\.tmp-acceptance'
$harness = Start-Process 'E:\ws-project\Private-Agent\scripts\call-window-transparency-acceptance.exe' -ArgumentList 'out' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

$hwnd = [EV]::FindWindowW('PAI_OutgoingCall_Window', $null)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO WINDOW'; Stop-Process -Id $harness.Id -Force; exit 1 }
$rect = New-Object EV+RECT
[void][EV]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("window at " + $rect.L + "," + $rect.T)

Shot "$out\ev-1-initial.png"
Drag ($rect.L + 120) ($rect.T + 20) 620 330
Start-Sleep -Milliseconds 250
[void][EV]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("after drag1 at " + $rect.L + "," + $rect.T)
Shot "$out\ev-2-moved-edge.png"

Drag ($rect.L + 120) ($rect.T + 20) 1250 780
Start-Sleep -Milliseconds 250
[void][EV]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("after drag2 at " + $rect.L + "," + $rect.T)
Shot "$out\ev-3-moved-desktop.png"

Stop-Process -Id $harness.Id -Force -ErrorAction SilentlyContinue
Write-Output 'DONE'
