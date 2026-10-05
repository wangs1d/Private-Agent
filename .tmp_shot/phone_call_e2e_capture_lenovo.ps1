# Phone call windows (Win32) E2E capture v2 - 'lenovo' paths + clean backdrop.
#
# Why the backdrop: the call card is a WS_EX_LAYERED per-pixel-alpha glass
# card (call_visuals.h). Whatever sits behind it bleeds through the 70-76%
# card alpha and the fully transparent margins. Captured over the main app
# window, chat UI text (plus/close/message snippets) shows through. To get
# a clean design shot we put a uniform dark fullscreen topmost backdrop
# behind the call windows (they are created later with TOPMOST, so they
# stack above it), then CopyFromScreen as before.
#
# Start this script BEFORE launching the app. Sentinel handshake with
# client/flutter_app/lib/main_call_e2e.dart (same as v1).
#
# Outputs in D:\ws-project\Private-Agent\.tmp_shot\pai_call_e2e:
#   pai_call_e2e_incoming.png / .done
#   pai_call_e2e_outgoing.png / .done
#   pai_call_e2e_connected.png / .done          (talking=true, halo animating)
#   pai_call_e2e_connected_muted.png / .done    (after setMute(true))
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads no-BOM files as GBK).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
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
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y,
      int cx, int cy, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiCallCap]::SetProcessDPIAware() | Out-Null
$out = 'D:\ws-project\Private-Agent\.tmp_shot\pai_call_e2e'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# ---- uniform dark backdrop (must be shown BEFORE the call windows) ----
$backdrop = New-Object System.Windows.Forms.Form
$backdrop.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$backdrop.BackColor = [System.Drawing.Color]::FromArgb(13, 13, 16)
$backdrop.ShowInTaskbar = $false
$backdrop.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$backdrop.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$backdrop.TopMost = $true
$backdrop.Show()
[System.Windows.Forms.Application]::DoEvents()

function Wait-Capture {
  param(
    [string] $WinClass,
    [string] $OutPng,
    [string] $DoneFile,
    [int] $SettleMs = 2200
  )
  $deadline = (Get-Date).AddSeconds(240)
  $hwnd = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline) {
    $hwnd = [PaiCallCap]::FindWindowW($WinClass, $null)
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw "window not found: $WinClass" }
  # Re-assert topmost so the window sits above the backdrop within the
  # topmost band (call windows are WS_EX_NOACTIVATE and never self-raise).
  # SWP_NOMOVE(2) | SWP_NOSIZE(1) | SWP_NOACTIVATE(16)
  [PaiCallCap]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 19) | Out-Null
  # Let the first frames paint and the animation reach an expressive phase.
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

Wait-Capture 'PAI_IncomingCall_Window' "$out\pai_call_e2e_incoming.png" "$out\pai_call_e2e_incoming.done" 2600
Wait-Capture 'PAI_OutgoingCall_Window' "$out\pai_call_e2e_outgoing.png" "$out\pai_call_e2e_outgoing.done" 2400
Wait-Capture 'PAI_ConnectedCall_Window' "$out\pai_call_e2e_connected.png" "$out\pai_call_e2e_connected.done" 2600
Wait-Capture 'PAI_ConnectedCall_Window' "$out\pai_call_e2e_connected_muted.png" "$out\pai_call_e2e_connected_muted.done" 900
$backdrop.Close()
Write-Host 'ALL_CAPTURED'
