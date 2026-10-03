# Controlled transparency test: white board + dragged card + numeric verdict.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EV2 {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, UIntPtr dx, UIntPtr dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

# 1) bright white board with black marker text
$form = New-Object System.Windows.Forms.Form
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(880, 260)
$form.Size = New-Object System.Drawing.Size(760, 640)
$form.BackColor = [System.Drawing.Color]::White
$form.TopMost = $true   # card is topmost and newer -> renders above the board
$label = New-Object System.Windows.Forms.Label
$label.Text = 'WHITE-BOARD-CHECKER'
$label.Font = New-Object System.Drawing.Font('Arial', 28, [System.Drawing.FontStyle]::Bold)
$label.ForeColor = [System.Drawing.Color]::Black
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$form.Controls.Add($label)
[void]$form.Show()
[void]$form.Refresh()
Start-Sleep -Milliseconds 300

# 2) launch harness
$harness = Start-Process 'E:\ws-project\Private-Agent\scripts\call-window-transparency-acceptance.exe' -ArgumentList 'out' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

function Drag([int]$fx, [int]$fy, [int]$tx, [int]$ty) {
  [void][EV2]::SetCursorPos($fx, $fy)
  Start-Sleep -Milliseconds 100
  [EV2]::mouse_event(0x0002, [UIntPtr]::Zero, [UIntPtr]::Zero, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  for ($i = 1; $i -le 18; $i++) {
    [void][EV2]::SetCursorPos($fx + [int](($tx - $fx) * $i / 18), $fy + [int](($ty - $fy) * $i / 18))
    Start-Sleep -Milliseconds 12
  }
  Start-Sleep -Milliseconds 150
  [EV2]::mouse_event(0x0004, [UIntPtr]::Zero, [UIntPtr]::Zero, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 200
}

$hwnd = [EV2]::FindWindowW('PAI_OutgoingCall_Window', $null)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO WINDOW'; Stop-Process -Id $harness.Id -Force; $form.Close(); exit 1 }
$rect = New-Object EV2+RECT
[void][EV2]::GetWindowRect($hwnd, [ref]$rect)
Drag ($rect.L + 120) ($rect.T + 20) 950 380
Start-Sleep -Milliseconds 150
[void][EV2]::GetWindowRect($hwnd, [ref]$rect)
# corrective drag toward board center if undershot
if ([math]::Abs($rect.L - 950) -gt 40 -or [math]::Abs($rect.T - 380) -gt 40) {
  Drag ($rect.L + 120) ($rect.T + 20) (950 + (950 - $rect.L)) (380 + (380 - $rect.T))
  Start-Sleep -Milliseconds 150
}
[void][EV2]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("card now at " + $rect.L + "," + $rect.T)

Start-Sleep -Milliseconds 300
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('E:\ws-project\Private-Agent\.tmp-acceptance\ctl-over-white.png', [System.Drawing.Imaging.ImageFormat]::Png)

function Lum([int]$x, [int]$y) {
  $c = $bmp.GetPixel($x, $y)
  return [math]::Round(0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
}
# card interior sample points (card at ~950,380; interior away from texts/discs)
Write-Output ("card(1010,560) = " + (Lum 1010 560))
Write-Output ("card(1150,480) = " + (Lum 1150 480))
Write-Output ("card(980,700)  = " + (Lum 980 700))
Write-Output ("white-outside(1660,420) = " + (Lum 1660 420))
Write-Output ("white-outside(900,320)  = " + (Lum 900 320))

# phase 2: drag to the dark Douyin chrome below-left, prove background follows live
Drag ($rect.L + 120) ($rect.T + 20) 700 800
Start-Sleep -Milliseconds 300
[void][EV2]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("card now at " + $rect.L + "," + $rect.T)
$bmp2 = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp2.Size)
$g2.Dispose()
$bmp2.Save('E:\ws-project\Private-Agent\.tmp-acceptance\ctl-over-dark.png', [System.Drawing.Imaging.ImageFormat]::Png)
function Lum2([int]$x, [int]$y) {
  $c = $bmp2.GetPixel($x, $y)
  return [math]::Round(0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
}
Write-Output ("dark-card(760,980) = " + (Lum2 760 980))
Write-Output ("dark-card(900,860) = " + (Lum2 900 860))
$bmp2.Dispose()

Stop-Process -Id $harness.Id -Force -ErrorAction SilentlyContinue
$form.Close()
Write-Output 'DONE'
