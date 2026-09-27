# Phone call windows (Win32) E2E capture: wait for each native popup by window
# class name -> capture the whole window via CopyFromScreen -> write a sentinel
# file so phone_call_ui_e2e_test.dart can advance to the next state.
#
# Start this script BEFORE running the test:
#   powershell -File integration_test/phone_call_e2e_capture.ps1
#
# Outputs (C:\Users\Administrator\AppData\Local\Temp — keep in sync with _tmp
# in phone_call_ui_e2e_test.dart; do not use $env:TEMP, it may differ):
#   pai_call_e2e_incoming.png / .done
#   pai_call_e2e_outgoing.png / .done
#   pai_call_e2e_connected.png / .done          (talking=true, halo animating)
#   pai_call_e2e_connected_muted.png / .done    (after setMute(true))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiCallCap {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiCallCap]::SetProcessDPIAware() | Out-Null
$tmp = 'C:\Users\Administrator\AppData\Local\Temp'

function Wait-Capture {
  param(
    [string] $WinClass,
    [string] $OutPng,
    [string] $DoneFile,
    [int] $SettleMs = 2200
  )
  # First run includes a full flutter build (~1min+), so be patient per window.
  $deadline = (Get-Date).AddSeconds(240)
  $hwnd = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline) {
    $hwnd = [PaiCallCap]::FindWindowW($WinClass, $null)
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw "window not found: $WinClass" }
  # Let the first frames paint and the animation reach a expressive phase.
  Start-Sleep -Milliseconds $SettleMs

  $r = New-Object PaiCallCap+RECT
  [PaiCallCap]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { throw "bad rect for $WinClass" }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Set-Content -Path $DoneFile -Value 'ok'
  Write-Host "captured $WinClass -> $OutPng"
}

Wait-Capture 'PAI_IncomingCall_Window' "$tmp\pai_call_e2e_incoming.png" "$tmp\pai_call_e2e_incoming.done" 2600
Wait-Capture 'PAI_OutgoingCall_Window' "$tmp\pai_call_e2e_outgoing.png" "$tmp\pai_call_e2e_outgoing.done" 2400
Wait-Capture 'PAI_ConnectedCall_Window' "$tmp\pai_call_e2e_connected.png" "$tmp\pai_call_e2e_connected.done" 2600
Wait-Capture 'PAI_ConnectedCall_Window' "$tmp\pai_call_e2e_connected_muted.png" "$tmp\pai_call_e2e_connected_muted.done" 900
Write-Host 'ALL_CAPTURED'
