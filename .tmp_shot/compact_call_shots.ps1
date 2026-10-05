# Compact restitch of the anonymized call-window screenshots.
#
# The identity band (avatar/name/subtitle/status) was erased earlier, leaving
# a large blank middle. This script removes the blank band entirely: keep the
# title-bar segment and the divider/buttons segment, drop the middle, then
# blend the seam per-column between two anchor rows (the card background is
# a vertical-only gradient, so the lerp is seamless; blend zone is placed to
# avoid the divider line and the waveform/timer row).
#
# Geometry (from the C++ layout constants, window width 300):
#   incoming  300x376: title <=~34, divider 256            -> y1=45 y2=247
#   outgoing  300x316: title <=~34, divider 232            -> y1=45 y2=223
#   connected 300x368: title <=~34, status row 202..220
#                     (waveform+timer KEPT), divider 240   -> y1=45 y2=196
# Outputs: *_clean_compact.png next to the sources.
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads no-BOM files as GBK).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'D:\ws-project\Private-Agent\.tmp_shot\pai_call_e2e'

function Restitch-Compact {
  param(
    [string] $InPng,
    [string] $OutPng,
    [int] $Y1,   # first row of the bottom segment in the source
    [int] $Y2
  )
  $bmp = New-Object System.Drawing.Bitmap("$dir\$InPng")
  $w = $bmp.Width; $h = $bmp.Height
  $newH = $Y1 + ($h - $Y2)
  $dst = New-Object System.Drawing.Bitmap($w, $newH)
  $g = [System.Drawing.Graphics]::FromImage($dst)

  # top segment: src rows 0..Y1-1 -> dst rows 0..Y1-1
  $srcRect = New-Object System.Drawing.Rectangle(0, 0, $w, $Y1)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $Y1)
  $g.DrawImage($bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  # bottom segment: src rows Y2..h-1 -> dst rows Y1..newH-1
  $bottomH = $h - $Y2
  $srcRect2 = New-Object System.Drawing.Rectangle(0, $Y2, $w, $bottomH)
  $dstRect2 = New-Object System.Drawing.Rectangle(0, $Y1, $w, $bottomH)
  $g.DrawImage($bmp, $dstRect2, $srcRect2, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()

  # per-column lerp across the seam: zone rows Y1-8 .. Y1+4,
  # anchors dst rows Y1-9 (above) and Y1+5 (below) — the bottom anchor must
  # stay clear of the status-row glyph antialiasing (muted glyphs reach
  # src y=204) and of the divider line (dst y=54)
  $top = $Y1 - 9
  $bot = $Y1 + 5
  for ($y = $Y1 - 8; $y -le $Y1 + 4; $y++) {
    $t = ($y - $top) / ($bot - $top)
    for ($x = 0; $x -lt $w; $x++) {
      $ca = $dst.GetPixel($x, $top)
      $cb = $dst.GetPixel($x, $bot)
      $nr = [int]([math]::Round($ca.R + ($cb.R - $ca.R) * $t))
      $ng = [int]([math]::Round($ca.G + ($cb.G - $ca.G) * $t))
      $nb = [int]([math]::Round($ca.B + ($cb.B - $ca.B) * $t))
      $dst.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $nr, $ng, $nb))
    }
  }

  # report per-row mean luminance around the seam for smoothness check
  $report = @()
  for ($y = $Y1 - 12; $y -le $Y1 + 11; $y++) {
    $sum = 0.0
    for ($x = 12; $x -lt ($w - 12); $x++) {
      $c = $dst.GetPixel($x, $y)
      $sum += ($c.R + $c.G + $c.B) / 3.0
    }
    $report += ("row {0}: {1:F2}" -f $y, ($sum / ($w - 24)))
  }
  $dst.Save("$dir\$OutPng", [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose(); $bmp.Dispose()
  Write-Host ("restitched {0} -> {1} ({2} x {3})" -f $InPng, $OutPng, $w, $newH)
  $report -join ' | '
}

Restitch-Compact 'pai_call_e2e_incoming_clean.png'        'pai_call_e2e_incoming_clean_compact.png'        45 247
Restitch-Compact 'pai_call_e2e_outgoing_clean.png'        'pai_call_e2e_outgoing_clean_compact.png'        45 223
Restitch-Compact 'pai_call_e2e_connected_clean.png'       'pai_call_e2e_connected_clean_compact.png'       45 196
Restitch-Compact 'pai_call_e2e_connected_muted_clean.png' 'pai_call_e2e_connected_muted_clean_compact.png' 45 196
Write-Host 'COMPACT_DONE'
