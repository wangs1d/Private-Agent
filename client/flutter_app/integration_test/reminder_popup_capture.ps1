# Reminder pre/due desktop split capture (island vs native popup).
# Verifies: r0 idle -> r1 pre-reminder shows island ONLY (popup must NOT
# exist) -> r2 due reminder shows island + native desktop popup together.
# NOTE: keep this file ASCII-only - PS 5.1 mis-reads BOM-less UTF-8 as GBK.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiRemPop {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiRemPop]::SetProcessDPIAware() | Out-Null

$out = Join-Path $env:TEMP 'pai_reminder_popup'
New-Item -ItemType Directory -Force -Path $out | Out-Null
# stale flags from a previous run would shortcut every wait below
foreach ($f in @('app_ready.flag','fire_pre.flag','pre_fired.flag','pre_result.txt',
                 'pre_settled.flag','fire_due.flag','due_fired.flag','due_result.txt','done.flag')) {
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

function Save-PopupCloseup([string]$name) {
  $hw = [PaiRemPop]::FindWindowW('PAI_DesktopNotification_Window', $null)
  if ($hw -eq [IntPtr]::Zero) { Write-Host "popup window absent, skip $name"; return }
  $r = New-Object PaiRemPop+RECT
  [PaiRemPop]::GetWindowRect($hw, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Host "popup rect invalid, skip $name"; return }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save("$out\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "captured $name ($w x $h)"
}

# 1. wait island window
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(300)
while ((Get-Date) -lt $deadline) {
  $hwnd = [PaiRemPop]::FindWindowW('PAI_DynamicIsland_Window', $null)
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 500
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'island window not found' }

# 2. wait dart bootstrap ready (island at rest)
$ready = Join-Path $out 'app_ready.flag'
$deadline = (Get-Date).AddSeconds(240)
while ((Get-Date) -lt $deadline -and -not (Test-Path $ready)) {
  Start-Sleep -Milliseconds 400
}
if (-not (Test-Path $ready)) { throw 'app_ready.flag timeout' }
Start-Sleep -Seconds 2
Save-Shot 'r0_idle'

# 3. pre-reminder: island attention ONLY, popup must not appear
'fire' | Set-Content -Path (Join-Path $out 'fire_pre.flag') -Encoding ASCII
$fired = Join-Path $out 'pre_fired.flag'
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not (Test-Path $fired)) {
  Start-Sleep -Milliseconds 300
}
if (-not (Test-Path $fired)) { throw 'pre_fired.flag timeout' }
Start-Sleep -Milliseconds 1500
Save-Shot 'r1_pre_island_only'
# dart writes pre_result.txt after its 2.5s popup observation window
$preResultFile = Join-Path $out 'pre_result.txt'
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not (Test-Path $preResultFile)) {
  Start-Sleep -Milliseconds 300
}
if (-not (Test-Path $preResultFile)) { throw 'pre_result.txt timeout' }
$preResult = (Get-Content $preResultFile -Raw).Trim()
$popupHwnd = [PaiRemPop]::FindWindowW('PAI_DesktopNotification_Window', $null)
$preWindowAbsent = ($popupHwnd -eq [IntPtr]::Zero)
Write-Host "PRE dart=$preResult window_absent=$preWindowAbsent"

# 4. island settles back (default attention ~6s; dart waits 8s)
$settled = Join-Path $out 'pre_settled.flag'
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not (Test-Path $settled)) {
  Start-Sleep -Milliseconds 400
}
if (-not (Test-Path $settled)) { throw 'pre_settled.flag timeout' }

# 5. due reminder: island long-hold + native desktop popup together
'fire' | Set-Content -Path (Join-Path $out 'fire_due.flag') -Encoding ASCII
$fired = Join-Path $out 'due_fired.flag'
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not (Test-Path $fired)) {
  Start-Sleep -Milliseconds 300
}
if (-not (Test-Path $fired)) { throw 'due_fired.flag timeout' }
$dueResult = (Get-Content (Join-Path $out 'due_result.txt') -Raw).Trim()
Start-Sleep -Milliseconds 1500
Save-Shot 'r2_due_island_and_popup'
$popupHwnd = [PaiRemPop]::FindWindowW('PAI_DesktopNotification_Window', $null)
$dueWindowPresent = ($popupHwnd -ne [IntPtr]::Zero)
Write-Host "DUE dart=$dueResult window_present=$dueWindowPresent"
Save-PopupCloseup 'r2b_due_popup_closeup'

# 6. let dart exit
'done' | Set-Content -Path (Join-Path $out 'done.flag') -Encoding ASCII

$pass = ($preResult -eq 'OK_NO_POPUP') -and $preWindowAbsent -and `
        ($dueResult -eq 'OK_POPUP_SHOWN') -and $dueWindowPresent
if ($pass) { Write-Host 'REMINDER_POPUP_SPLIT_PASS' }
else { Write-Host 'REMINDER_POPUP_SPLIT_FAIL' }
