# Notification windows transparency evidence: white boards behind the
# bottom-right decision dialog and the top-right glass stack; numeric verdicts.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function NewBoard([int]$x, [int]$y, [int]$w, [int]$h, [string]$text) {
  $f = New-Object System.Windows.Forms.Form
  $f.StartPosition = 'Manual'
  $f.Location = New-Object System.Drawing.Point($x, $y)
  $f.Size = New-Object System.Drawing.Size($w, $h)
  $f.BackColor = [System.Drawing.Color]::White
  $f.TopMost = $true
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Font = New-Object System.Drawing.Font('Arial', 22, [System.Drawing.FontStyle]::Bold)
  $l.ForeColor = [System.Drawing.Color]::Black
  $l.Dock = 'Fill'
  $l.TextAlign = 'MiddleCenter'
  $f.Controls.Add($l)
  [void]$f.Show()
  [void]$f.Refresh()
  return $f
}

function Shot([string]$path) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Lum([System.Drawing.Bitmap]$bmp, [int]$x, [int]$y) {
  $c = $bmp.GetPixel($x, $y)
  return [math]::Round(0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
}

$out = 'E:\ws-project\Private-Agent\.tmp-acceptance'
$exe = 'E:\ws-project\Private-Agent\scripts\call-window-transparency-acceptance.exe'

# ── A: bottom-right decision dialog (系统通知/我知道了) ──
$board1 = NewBoard 1350 660 570 370 'NOTIF-BOARD-A'
Start-Sleep -Milliseconds 300
$p1 = Start-Process $exe -ArgumentList 'notif' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1600
Shot "$out\ntf-1-over-white.png"
$bmp = New-Object System.Drawing.Bitmap "$out\ntf-1-over-white.png"
Write-Output ("notif card(1560,940) = " + (Lum $bmp 1560 940))
Write-Output ("notif card(1700,1000) = " + (Lum $bmp 1700 1000))
Write-Output ("board-only(1420,700) = " + (Lum $bmp 1420 700))
$bmp.Dispose()
Stop-Process -Id $p1.Id -Force -ErrorAction SilentlyContinue
$board1.Close()

# ── B: top-right glass notify stack ──
$board2 = NewBoard 1150 40 700 460 'GLASS-BOARD-B'
Start-Sleep -Milliseconds 300
$p2 = Start-Process $exe -ArgumentList 'glass' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1600
Shot "$out\ntf-2-glass-over-white.png"
$bmp = New-Object System.Drawing.Bitmap "$out\ntf-2-glass-over-white.png"
Write-Output ("glass card(1600,120) = " + (Lum $bmp 1600 120))
Write-Output ("glass card(1800,180) = " + (Lum $bmp 1800 180))
Write-Output ("board-only(1250,420) = " + (Lum $bmp 1250 420))
$bmp.Dispose()
Stop-Process -Id $p2.Id -Force -ErrorAction SilentlyContinue
$board2.Close()
Write-Output 'DONE'
