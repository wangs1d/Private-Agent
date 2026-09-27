# Pure-voice-mode state burst capture (island = the only visual).
# Voice WAKE is removed: idle shows the plain rest capsule (no entry);
# states are idle -> listening -> thinking -> speaking -> idle-again,
# aligned with the voice walkthrough tail of dynamic_island_stage_e2e.dart.
# NOTE: keep this file ASCII-only - PS 5.1 mis-reads BOM-less UTF-8 as GBK.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiIslandVoice {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiIslandVoice]::SetProcessDPIAware() | Out-Null

$out = Join-Path $env:TEMP 'pai_island_stage'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
  $hwnd = [PaiIslandVoice]::FindWindowW('PAI_DynamicIsland_Window', $null)
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 500
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'island window not found' }

$ready = Join-Path $out 'voice_ready.flag'
$deadline = (Get-Date).AddSeconds(240)
while ((Get-Date) -lt $deadline -and -not (Test-Path $ready)) {
  Start-Sleep -Milliseconds 400
}
if (-not (Test-Path $ready)) { throw 'voice_ready.flag timeout' }

# Capture pacing aligned with the Dart walkthrough (wake removed):
# collapse+idle 2.6s -> listening 2.8s -> thinking 2.8s -> speaking 2.8s
# -> dismissed back to idle 2.6s.
$names = @('v0_idle_rest','v1_listening','v2_thinking','v3_speaking','v4_back_idle')
$waits = @(3200,2800,2800,2800,3400)
for ($i = 0; $i -lt $names.Count; $i++) {
  Start-Sleep -Milliseconds $waits[$i]
  $r = New-Object PaiIslandVoice+RECT
  [PaiIslandVoice]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Host "bad rect $($names[$i])"; continue }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save("$out\$($names[$i]).png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "captured $($names[$i])"
}
Write-Host 'VOICE_CAPTURED'
