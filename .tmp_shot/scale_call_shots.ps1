# Downscale the anonymized call-window screenshots to 50% (300x376 ->
# 150x188), high-quality bicubic. Outputs *_clean_small.png next to sources.
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads no-BOM files as GBK).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = 'D:\ws-project\Private-Agent\.tmp_shot\pai_call_e2e'

$names = @(
  'pai_call_e2e_incoming_clean.png',
  'pai_call_e2e_outgoing_clean.png',
  'pai_call_e2e_connected_clean.png',
  'pai_call_e2e_connected_muted_clean.png'
)

foreach ($n in $names) {
  $src = [System.Drawing.Image]::FromFile("$dir\$n")
  $w = [int]($src.Width / 2)
  $h = [int]($src.Height / 2)
  $dst = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  $out = $n -replace '_clean\.png$', '_clean_small.png'
  $dst.Save("$dir\$out", [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()
  $src.Dispose()
  Write-Host "scaled $n -> $out ($w x $h)"
}
Write-Host 'SCALED'
