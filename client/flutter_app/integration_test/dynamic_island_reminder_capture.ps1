# Reminder fullscreen-exemption capture (island over fullscreen app).
# Verifies: r0 idle (no fullscreen) -> r1 fullscreen hides island ->
# r2 reminder attention shown OVER fullscreen -> r3 attention ended, island
# hidden again -> r4 fullscreen closed, island restored (heartbeat path).
# NOTE: keep this file ASCII-only - PS 5.1 mis-reads BOM-less UTF-8 as GBK.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiIslandRem {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@
[PaiIslandRem]::SetProcessDPIAware() | Out-Null

$out = Join-Path $env:TEMP 'pai_island_reminder'
New-Item -ItemType Directory -Force -Path $out | Out-Null
# stale flags from a previous run would shortcut every wait below
foreach ($f in @('app_ready.flag','fire_reminder.flag','reminder_fired.flag','restore_done.flag')) {
  $p = Join-Path $out $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

function Save-Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $b.Size)
  $g.Dispose()
  $bmp.Save("$out\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "captured $name"
}

# 1. wait island window
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
  $hwnd = [PaiIslandRem]::FindWindowW('PAI_DynamicIsland_Window', $null)
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 500
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'island window not found' }

# 2. wait dart bootstrap ready (idle rest capsule, no fullscreen yet)
$ready = Join-Path $out 'app_ready.flag'
$deadline = (Get-Date).AddSeconds(240)
while ((Get-Date) -lt $deadline -and -not (Test-Path $ready)) {
  Start-Sleep -Milliseconds 400
}
if (-not (Test-Path $ready)) { throw 'app_ready.flag timeout' }
Start-Sleep -Seconds 2
Save-Shot 'r0_idle_no_fullscreen'

# 3. spawn fullscreen cover window (separate PS process running a message pump)
$cover = Join-Path $out 'cover_window.ps1'
@'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::FromArgb(18,32,54)
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'FULLSCREEN APP (test cover)'
$lbl.ForeColor = [System.Drawing.Color]::White
$lbl.Font = New-Object System.Drawing.Font('Segoe UI', 20)
$lbl.AutoSize = $true
$lbl.Location = New-Object System.Drawing.Point(60, 60)
$f.Controls.Add($lbl)
$f.Show()
while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 80
}
'@ | Set-Content -Path $cover -Encoding ASCII
$coverProc = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $cover) -PassThru -WindowStyle Hidden

# 4. QUNS flips busy in ~1.4s; native heartbeat is 2s (throttled longer when
#    the app is background) -- wait long enough for suppress-on to land
Start-Sleep -Seconds 6
Save-Shot 'r1_fullscreen_island_hidden'

# 5. fire reminder via dart e2e; attention exemption wakes the island at once
$fire = Join-Path $out 'fire_reminder.flag'
'fire' | Set-Content -Path $fire -Encoding ASCII
$fired = Join-Path $out 'reminder_fired.flag'
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not (Test-Path $fired)) {
  Start-Sleep -Milliseconds 300
}
if (-not (Test-Path $fired)) { throw 'reminder_fired.flag timeout' }
Start-Sleep -Milliseconds 3500
Save-Shot 'r2_attention_over_fullscreen'

# 6. attention timeline = 0.45 in + 8 hold + 0.35 out ~ 8.8s; island re-hides
Start-Sleep -Seconds 9
Save-Shot 'r3_attention_ended_hidden'

# 7. close cover; heartbeat/watchdog restores the island
Stop-Process -Id $coverProc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8
Save-Shot 'r4_fullscreen_closed_restored'

$done = Join-Path $out 'restore_done.flag'
'done' | Set-Content -Path $done -Encoding ASCII
Write-Host 'REMINDER_CAPTURED'
