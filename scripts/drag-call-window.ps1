# Drag the call acceptance window (real user-like HTCAPTION drag via SendInput).
# Usage: powershell -NoProfile -File drag-call-window.ps1 -ToX 900 -ToY 500
param([int]$ToX = 900, [int]$ToY = 500)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DragHelper {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, UIntPtr dx, UIntPtr dy, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$hwnd = [DragHelper]::FindWindowW("PAI_OutgoingCall_Window", $null)
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [DragHelper]::FindWindowW("PAI_ConnectedCall_Window", $null) }
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [DragHelper]::FindWindowW("PAI_IncomingCall_Window", $null) }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "WINDOW NOT FOUND"; exit 1 }
$rect = New-Object DragHelper+RECT
[void][DragHelper]::GetWindowRect($hwnd, [ref]$rect)
$grabX = $rect.L + 120   # title area, clear of the min/close buttons
$grabY = $rect.T + 20

[void][DragHelper]::SetCursorPos($grabX, $grabY)
Start-Sleep -Milliseconds 120
[DragHelper]::mouse_event(0x0002, [UIntPtr]::Zero, [UIntPtr]::Zero, 0, [UIntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 120
# stepped move so the DWM drag loop sees real mouse motion
$steps = 24
for ($i = 1; $i -le $steps; $i++) {
  $x = $grabX + [int](($ToX - $grabX) * $i / $steps)
  $y = $grabY + [int](($ToY - $grabY) * $i / $steps)
  [void][DragHelper]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 16
}
Start-Sleep -Milliseconds 150
[DragHelper]::mouse_event(0x0004, [UIntPtr]::Zero, [UIntPtr]::Zero, 0, [UIntPtr]::Zero)  # LEFTUP
Start-Sleep -Milliseconds 120
$rect2 = New-Object DragHelper+RECT
[void][DragHelper]::GetWindowRect($hwnd, [ref]$rect2)
Write-Output ("DRAGGED " + $rect.L + "," + $rect.T + " -> " + $rect2.L + "," + $rect2.T)
